const Apify = require('apify');

process.env.API_KEY = '3c7beec8-846d-4377-be03-71cae6145fdc';

const general = require('./tools/general');

const {
    resolveInBatches,
    getRequestListSources,
    getClient,
    randomDelay,
    validateInput,
    proxyConfiguration,
    getLocationId,
} = general;

const { processRestaurant } = require('./tools/restaurant-tools');
const { processHotel } = require('./tools/hotel-tools');
const { processAttraction, getAttractions } = require('./tools/attraction-tools');

const {
    buildRestaurantUrl,
    getPlaceInformation,
    callForRestaurantList,
    callForHotelList,
    buildHotelUrl,
} = require('./tools/api');

const { LIMIT } = require('./constants');
const { getConfig, setConfig, checkMaxItemsLimit } = require('./tools/data-limits');

const { utils: { log } } = Apify;

Apify.main(async () => {
    /** @type {any} */
    const input = await Apify.getValue('INPUT');
    let error = 0;
    validateInput(input);
    const {
        locationFullName,
        locationId: locationIdInput,
        lastReviewDate = '2010-01-01',
        hotelId,
        restaurantId,
        checkInDate,
        debugLog = false,
    } = input;

    if (debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    setConfig(input);

    log.debug('Received input', input);
    global.INCLUDE_REVIEWS = input.includeReviews || false;
    global.LAST_REVIEW_DATE = lastReviewDate;
    global.CHECKIN_DATE = checkInDate;
    global.INCLUDE_REVIEW_TAGS = input.includeTags || false;
    global.PROXY = await proxyConfiguration({
        proxyConfig: input.proxyConfiguration,
        hint: ['RESIDENTIAL'],
    });

    global.LANGUAGE = input.language || 'en';
    global.CURRENCY = input.currency || 'USD';

    /** @type {Apify.RequestOptions[]} */
    const startUrls = [];
    const generalDataset = await Apify.openDataset();
    /** @type {string} */
    let locationId;

    if (locationFullName || locationIdInput) {
        if (locationIdInput) {
            locationId = locationIdInput;
        } else {
            locationId = await getLocationId(locationFullName);
        }
        log.info(`Processing locationId: ${locationId}`);

        startUrls.push(...getRequestListSources({ ...input, locationId }));
    }

    if (restaurantId) {
        log.debug(`Processing restaurant ${restaurantId}`);

        startUrls.push({
            url: 'https://www.tripadvisor.com',
            userData: { restaurantId, restaurantDetail: true },
        });
    }

    if (hotelId) {
        log.debug(`Processing hotel ${restaurantId}`);

        startUrls.push({
            url: 'https://www.tripadvisor.com',
            userData: { hotelId, hotelDetail: true },
        });
    }

    const requestQueue = await Apify.openRequestQueue();
    /** @type {Record<string, general.Client>} */
    const sessionClients = {};
    let listenerAdded = false;
    const crawler = new Apify.BasicCrawler({
        requestList: await Apify.openRequestList('STARTURLS', startUrls),
        requestQueue,
        minConcurrency: 10,
        maxConcurrency: 20,
        maxRequestRetries: 10,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 40,
            createSessionFunction: async (sessionPool) => {
                const session = new Apify.Session({ sessionPool });

                if (!sessionClients[session.id]) {
                    try {
                        sessionClients[session.id] = await getClient(session);
                    } catch (e) {
                        log.warning(`Could not create create for session due to: ${e.message}`, { stack: e.stack });
                    }
                }

                if (!listenerAdded) {
                    sessionPool.on('sessionRetired', (ses) => delete sessionClients[ses.id]);
                    listenerAdded = true;
                }
                return session;
            },
        },
        handleRequestTimeoutSecs: 180,
        handleRequestFunction: async ({ request, session }) => {
            if (checkMaxItemsLimit()) {
                return;
            }

            const client = sessionClients[session.id] || await getClient(session);
            // await checkIp(); // Proxy check

            const { maxItems } = getConfig();

            if (request.userData.initialHotel) {
                // Process initial hotelList url and add others with pagination to request queue
                const initialRequest = await callForHotelList({
                    locationId,
                    session
                });

                if (!initialRequest?.length) {
                    request.noRetry = true;
                    throw new Error(`Hotels are empty`);
                }

                // eslint-disable-next-line no-nested-ternary
                const maxOffset = maxItems === 0
                    ? LIMIT
                    : (initialRequest.length < maxItems ? maxItems : initialRequest.length);

                log.info(`Processing hotels with last data offset: ${maxOffset}/${LIMIT}`);
                const promises = [];
                for (let i = 0; i < maxOffset; i += LIMIT) {
                    promises.push(() => requestQueue.addRequest({
                        url: `https://api.tripadvisor.com/api/internal/1.14/location/${locationId}/hotels?currency=${global.CURRENCY}&lang=${global.LANGUAGE}&limit=${LIMIT}&offset=${i}`,
                        userData: { hotelList: true, offset: i, limit: LIMIT },
                    }));
                    log.debug(`Adding location with ID: ${locationId} Offset: ${i.toString()}`);
                    if (checkMaxItemsLimit(i)) break;
                }
                await resolveInBatches(promises);
            } else if (request.userData.hotelList) {
                // Gets ids of hotels from hotelList -> gets data for given id and saves hotel to dataset
                log.info(`Processing hotel list with offset ${request.userData.offset}`);
                const hotelList = await callForHotelList({
                    locationId,
                    session,
                    limit: request.userData.limit,
                    offset: request.userData.offset,
                });

                if (!hotelList?.length) {
                    throw new Error('Hotel list is empty');
                }

                await resolveInBatches(hotelList.map((hotel) => {
                    log.debug(`Processing hotel: ${hotel.name}`);

                    if (checkMaxItemsLimit(10)) return () => {};

                    return () => processHotel({ placeInfo: hotel, session, client, dataset: generalDataset });
                }));
            } else if (request.userData.initialRestaurant) {
                // Process initial restaurantList url and add others with pagination to request queue
                const promises = [];
                const initialRequest = await callForRestaurantList({ locationId, session });

                if (!initialRequest?.length) {
                    request.noRetry = true;
                    throw new Error(`Result length is zero`);
                }

                // eslint-disable-next-line no-nested-ternary
                const maxOffset = maxItems === 0
                    ? LIMIT
                    : (initialRequest.length < maxItems ? maxItems : initialRequest.length);

                log.info(`Processing restaurants with last data offset: ${maxOffset}`);
                for (let i = 0; i < maxOffset; i += LIMIT) {
                    log.info(`Adding restaurants search page with offset: ${i} to list`);

                    promises.push(() => requestQueue.addRequest({
                        url: buildRestaurantUrl(locationId, i.toString()),
                        userData: { restaurantList: true, offset: i, limit: LIMIT },
                    }));

                    if (checkMaxItemsLimit(i)) break;
                }
                await resolveInBatches(promises);
            } else if (request.userData.restaurantList) {
                log.info(`Processing restaurant list with offset ${request.userData.offset}`);
                const restaurantList = await callForRestaurantList({
                    locationId,
                    session,
                    limit: request.userData.limit,
                    offset: request.userData.offset,
                });

                if (!restaurantList?.length) {
                    throw new Error(`Restaurant list is empty`);
                }

                await resolveInBatches(restaurantList.map((restaurant) => {
                    log.debug(`Processing restaurant: ${restaurant.name}`);

                    if (checkMaxItemsLimit(10)) return () => {};

                    return () => processRestaurant({
                        placeInfo: restaurant,
                        client,
                        dataset: generalDataset,
                        session,
                    });
                }));
            } else if (request.userData.restaurantDetail) {
                // For API usage only gets restaurantId from input and sets OUTPUT.json to key-value store
                //  a.k.a. returns response with restaurant data
                const { restaurantId: id } = request.userData;
                log.info(`Processing single API request for restaurant with id: ${id}`);
                await processRestaurant({
                    placeInfo: await getPlaceInformation({ placeId: restaurantId, session }),
                    client,
                    session,
                });
            } else if (request.userData.hotelDetail) {
                // For API usage only gets hotelId from input and sets OUTPUT.json to key-value store
                //  a.k.a. returns response with hotel data
                const { hotelId: id } = request.userData;
                log.info(`Processing single API request for hotel with id: ${id}`);
                await processHotel({
                    placeInfo: await getPlaceInformation({ placeId: hotelId, session }),
                    client,
                    session,
                });
            } else if (request.userData.initialAttraction) {
                try {
                    const attractions = await getAttractions({ locationId, session });
                    log.info(`Found ${attractions.length} attractions`);
                    await resolveInBatches(attractions.map((attr) => {
                        if (checkMaxItemsLimit(10)) return () => {};

                        return () => processAttraction({
                            attraction: attr,
                            session
                        });
                    }), 10);
                } catch (e) {
                    log.error(`Could not process attraction... ${e.message}`);
                }
            }
        },
        handleFailedRequestFunction: async ({ request }) => {
            log.info(`Request ${request.url} failed too many times`);
            await Apify.setValue(`ERROR-${Date.now()}`, JSON.stringify(request), { contentType: 'application/json' });
            error += 1;
        },
    });
    // Run the crawler and wait for it to finish.
    await crawler.run();
    log.info(`Requests failed: ${error}`);

    log.info('Crawler finished.');
});
