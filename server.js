const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const axios = require('axios');
const cheerio = require('cheerio');

// IMPORTANT: database.json and its backups live in /tmp — DELIBERATELY outside
// the source folder (__dirname). The hosting platform's file-watcher restarts
// the server on ANY change inside the source folder, and it was not respecting
// our nodemon.json ignore rules. That meant every write to database.json could
// trigger a restart mid-write, truncating/corrupting the file. Writing to /tmp
// instead means these writes are invisible to the watcher — no more restarts,
// no more corruption. (/tmp may be cleared on a fresh redeploy, but the app already
// self-heals with default data in that case — see initDB() below.)
const DB_FILE = path.join('/tmp', 'database.json');
const BACKUP_DIR = path.join('/tmp', 'backups');

// ============ GLOBAL CRASH SAFETY NET ============
// Whatever else goes wrong anywhere in the app, the Node process itself must
// never die — a dead process is what makes the hosting platform serve its own
// generic HTML error page instead of our JSON, which breaks the frontend.
process.on('uncaughtException', (err) => {
    console.error('🚨 UNCAUGHT EXCEPTION (server stayed alive):', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('🚨 UNHANDLED PROMISE REJECTION (server stayed alive):', reason);
});

// ============ LEVEL: CONFIG SUPPORT (centralized configurable values) ============
const CONFIG = {
    PORT: process.env.PORT || 5000,
    CACHE_TTL_MS: 5 * 60 * 1000,
    CACHE_REFRESH_THRESHOLD_MS: 60 * 1000,
    AUTO_SYNC_INTERVAL_MS: 3 * 60 * 60 * 1000,
    BACKGROUND_REFRESH_INTERVAL_MS: 30 * 60 * 1000,
    CACHE_CLEANUP_INTERVAL_MS: 15 * 60 * 1000,
    MAX_SEARCH_HISTORY: 500,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX_REQUESTS: 60,
    RETRY: { retries: 2, baseDelayMs: 150 },
    INTERNET_SOURCE_TIMEOUT_MS: 2000,
    INTERNET_SEARCH_TOTAL_BUDGET_MS: 7000,
    PRICE_VALIDATION: {
        MIN_PRICE: 1,
        MAX_PRICE: 1000000,
        MAX_JUMP_PERCENT: 300
    },
    SOURCE_HEALTH: {
        RECOVERY_CHECK_INTERVAL_MS: 20 * 60 * 1000,
        MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE: 5
    },
    BACKUP_EVERY_N_WRITES: 10,
    MAX_BACKUPS_KEPT: 20,
    VERSION: '2.0.0-enterprise'
};

// ============ FIRESTORE (OPTIONAL) ============
let firestoreDB = null;
try {
    const admin = require('firebase-admin');
    let serviceAccount = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else {
        const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'firebase-service-account.json');
        if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
            serviceAccount = require(SERVICE_ACCOUNT_PATH);
        }
    }

    if (serviceAccount) {
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firestoreDB = admin.firestore();
        console.log('✅ Firestore connected');
    } else {
        console.log('⚠️  Firestore credentials not found, running in JSON-only mode');
    }
} catch (e) {
    console.log('⚠️  Firestore module unavailable, running in JSON-only mode:', e.message);
    firestoreDB = null;
}

const FIRESTORE_ADMIN_COLLECTION = 'Document';

// ============ PWA: MANIFEST + SERVICE WORKER ============
const PWA_ICON_192 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAFt0lEQVR4nO3cTWwUZQDG8dl+sNtCW/ohainVcgCtGtIIB0n4CjFwwR5sogc1QRMTL0pME0NMuGhiGowmxHgiCKiJB0nRQCKJEbCaoEE[...]
const PWA_ICON_512 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAQV0lEQVR4nO3df6zddX3H8furvbc/aIGWX6W0pYAW5GdgIBsCA9TBQJxZdAwWZswMyWaGbmRhm4TIZGKMkZAoQ90iTjeHC10A7QKMAQ7[...]

const PWA_MANIFEST = {
    name: "Punjab Price App",
    short_name: "Punjab Price",
    description: "Punjab ki mandiyon ki live prices — Atta, Chini, sabziyan, phal aur bohot kuch.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f7fb",
    theme_color: "#1e40af",
    orientation: "portrait",
    icons: [
        { src: PWA_ICON_192, sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: PWA_ICON_512, sizes: "512x512", type: "image/png", purpose: "any maskable" }
    ]
};

const PWA_SERVICE_WORKER = `
const CACHE_NAME = "punjab-price-v1";
self.addEventListener("install", (event) => {
    self.skipWaiting();
});
self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
`;

const AMIS_COMMODITY_MAP = {
    atta: 1, chini: 7, mirch: 29, haldi: 123, pyaz: 23, lasun: 73, dhaniya: 114, chawal: 4,
    anar: 95, seb: 40, kela: 42, aam: 92, malta: 45, angoor: 47, tarbooz: 76, kharbooza: 75,
    amrood: 43, papita: 124, aarhoo: 88, aloo_bukhara: 90, lychee: 79, strawberry: 80, loquat: 140,
    jamun: 104, narial: 120, nashpati: 98, aloo: 21, tamatar: 26, baingan: 28, karela: 31,
    lauki: 102, kaddu: 33, bhindi: 30, gajar: 38, gobi: 34, band_gobi: 64, palak: 27, shalgham: 36,
    muli: 37, hari_mirch: 84, shimla_mirch: 85, kheera: 74, matar: 35, tori: 103, arvi: 107,
    hari_pyaz: 129, adrak: 68, masoor: 16, moong: 12, mash: 66, chana_daal: 10, safed_chana: 8,
    besan: 99, makai: 17, jau: 138, bajra: 18, jowar: 19, khubani: 93, khajoor: 81, musambi: 60,
    nimbu: 86, ber: 119, gur: 65, podina: 115, methi: 105, til: 118, ganna: 125, bathua: 130,
    shakar: 127, kaala_chana: 9, chakotra: 61, cholia: 126, moongphali: 63, saag: 108, santra: 44,
    basmati: 3, persimmon: 110, chuqandar: 136, shakarqandi: 111, tinda: 32
};

const MARKET_ID_MAP = {
    lahore: 1, faisalabad: 2, gujranwala: 3, okara: 4, sargodha: 5, rawalpindi: 6, multan: 7,
    rahimyarkhan: 8, bhakkar: 9, kasur: 11, sahiwal: 13, vehari: 14, burewala: 15, layyah: 16,
    gujrat: 17, khanewal: 18, muzaffargarh: 19, bahawalpur: 20, ttsingh: 21, dgkhan: 36, jhang: 64,
    sialkot: 57, narowal: 58, sheikhupura: 78, hafizabad: 104, chiniot: 81, nankana: 70,
    mandibahaudin: 41, chakwal: 59, jhelum: 60, mianwali: 62, rajanpur: 63
};

const CITY_COMMODITY_KEYWORDS = {
    atta: ['wheat'], chini: ['sugar'], mirch: ['red chilli', 'chilli'], haldi: ['turmeric'],
    pyaz: ['onion'], lasun: ['garlic'], dhaniya: ['coriander'], chawal: ['rice'],
    anar: ['pomegranate'], seb: ['apple'], kela: ['banana'], aam: ['mango'],
    malta: ['kinnow', 'orange'], angoor: ['grape'], tarbooz: ['watermelon'],
    kharbooza: ['melon'], amrood: ['guava'], papita: ['papaya'], aarhoo: ['peach'],
    aloo_bukhara: ['plum'], lychee: ['lychee', 'litchi'], strawberry: ['strawberry'],
    loquat: ['loquat'], jamun: ['jaman'], narial: ['cocunut', 'coconut'], nashpati: ['pear']
};

const TRUSTED_SOURCES = [
    {
        name: 'amis-punjab',
        buildUrl: (canonicalKey) => {
            const commodityId = AMIS_COMMODITY_MAP[canonicalKey];
            if (!commodityId) return null;
            return `http://www.amis.pk/Printer.aspx?searchType=0&commodityId=${commodityId}`;
        },
        parse: ($) => {
            let foundPrice = null;
            $('table tr').each((i, row) => {
                const cells = $(row).find('td');
                if (cells.length < 4) return;
                const cellTexts = [];
                cells.each((j, cell) => {
                    cellTexts.push($(cell).text().trim());
                });
                const candidates = [cellTexts[cellTexts.length - 2], cellTexts[cellTexts.length - 3]];
                for (const candidate of candidates) {
                    const numericValue = parseFloat((candidate || '').replace(/,/g, ''));
                    if (!isNaN(numericValue) && numericValue > 0) {
                        foundPrice = numericValue;
                        break;
                    }
                }
                if (foundPrice !== null) return false;
            });
            if (foundPrice !== null) {
                foundPrice = Math.round((foundPrice / 100) * 100) / 100;
            }
            return foundPrice;
        }
    }
];

const sourceRegistry = new Map();
TRUSTED_SOURCES.forEach(source => {
    sourceRegistry.set(source.name, {
        name: source.name, score: 100, successCount: 0, failureCount: 0,
        consecutiveFailures: 0, disabled: false, lastSuccess: null, lastFailure: null,
        avgResponseTimeMs: 0, totalResponseTimeMs: 0
    });
});

function getSourceHealth(name) { return sourceRegistry.get(name); }

function recordSourceSuccess(name, responseTimeMs) {
    const health = sourceRegistry.get(name);
    if (!health) return;
    health.successCount++;
    health.consecutiveFailures = 0;
    health.disabled = false;
    health.lastSuccess = new Date().toISOString();
    health.totalResponseTimeMs += responseTimeMs;
    health.avgResponseTimeMs = Math.round(health.totalResponseTimeMs / health.successCount);
    health.score = Math.min(100, health.score + 5);
}

function recordSourceFailure(name) {
    const health = sourceRegistry.get(name);
    if (!health) return;
    health.failureCount++;
    health.consecutiveFailures++;
    health.lastFailure = new Date().toISOString();
    health.score = Math.max(0, health.score - 10);
    if (health.consecutiveFailures >= CONFIG.SOURCE_HEALTH.MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE) {
        health.disabled = true;
        console.error(`🚨 Source "${name}" disabled after ${health.consecutiveFailures} consecutive failures`);
    }
}

function getPrioritizedSources() {
    return [...TRUSTED_SOURCES]
        .filter(s => {
            const health = sourceRegistry.get(s.name);
            return !health || !health.disabled;
        })
        .sort((a, b) => {
            const scoreA = sourceRegistry.get(a.name)?.score ?? 100;
            const scoreB = sourceRegistry.get(b.name)?.score ?? 100;
            return scoreB - scoreA;
        });
}

function attemptSourceRecovery() {
    sourceRegistry.forEach((health, name) => {
        if (health.disabled) {
            console.log(`🔄 Auto-recovery: re-enabling source "${name}" for retry`);
            health.disabled = false;
            health.consecutiveFailures = 0;
        }
    });
}

const ALIAS_MAP = {
    atta: ['atta', 'aata', 'ata', 'flour', 'wheat flour', 'گندم کا آٹا', 'آٹا'],
    chini: ['chini', 'cheeni', 'sugar', 'شکر', 'چینی'],
    namak: ['namak', 'salt', 'نمک'],
    mirch: ['mirch', 'mirchi', 'red chili', 'red chilli', 'chili powder', 'مرچ', 'لال مرچ'],
    haldi: ['haldi', 'turmeric', 'ہلدی'],
    pyaz: ['pyaz', 'pyaaz', 'onion', 'پیاز'],
    lasun: ['lasun', 'lehsun', 'garlic', 'لہسن'],
    dhaniya: ['dhaniya', 'dhania', 'coriander', 'دھنیا'],
    chawal: ['chawal', 'chaawal', 'rice', 'چاول'],
    anar: ['anar', 'anaar', 'pomegranate', 'انار'],
    seb: ['seb', 'saib', 'apple', 'سیب'],
    kela: ['kela', 'kaila', 'banana', 'کیلا'],
    aam: ['aam', 'mango', 'آم'],
    aloo: ['aloo', 'alu', 'potato', 'آلو'],
    tamatar: ['tamatar', 'tamater', 'tomato', 'ٹماٹر']
};

function buildAliasLookup() {
    const lookup = {};
    for (const [canonical, aliases] of Object.entries(ALIAS_MAP)) {
        aliases.forEach(alias => {
            lookup[alias.toLowerCase().trim()] = canonical;
        });
    }
    return lookup;
}
const ALIAS_LOOKUP = buildAliasLookup();

function sanitizeInput(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, 100).replace(/[<>$`;{}]/g, '');
}

function resolveCanonicalKey(searchKey) {
    if (ALIAS_LOOKUP[searchKey]) return ALIAS_LOOKUP[searchKey];
    for (const [alias, canonical] of Object.entries(ALIAS_LOOKUP)) {
        if (alias.includes(searchKey) || searchKey.includes(alias)) {
            return canonical;
        }
    }
    return null;
}

async function smartRetry(fn, { retries = 2, baseDelayMs = 300 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            if (attempt < retries) {
                const delay = baseDelayMs * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

const memoryCache = new Map();

function getFromCache(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryCache.delete(key);
        return null;
    }
    return entry.data;
}

function setToCache(key, data) {
    memoryCache.set(key, { data, expiresAt: Date.now() + CONFIG.CACHE_TTL_MS, refreshing: false });
}

const pendingRequests = new Map();

function ensureSchema(db) {
    if (!db.syncLog) db.syncLog = [];
    if (!db.searchHistory) db.searchHistory = [];
    if (!db.predictions) db.predictions = {};
    if (!db.analytics) {
        db.analytics = {
            dailyStats: {}, weeklyStats: {}, monthlyStats: {},
            totals: { cacheHits: 0, firestoreHits: 0, internetHits: 0, databaseHits: 0, notFound: 0, totalSearches: 0, totalResponseTimeMs: 0 }
        };
    }
    return db;
}

function initDB() {
    if (!fs.existsSync(DB_FILE)) {
        writeDefaultDB();
        return;
    }
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const existing = JSON.parse(raw);
        const migrated = ensureSchema(existing);
        const migratedJson = JSON.stringify(migrated, null, 2);
        if (migratedJson !== JSON.stringify(existing, null, 2)) {
            fs.writeFileSync(DB_FILE, migratedJson);
        }
    } catch (e) {
        console.error('🚨 database.json corrupted:', e.message);
        writeDefaultDB();
    }
}

function writeDefaultDB() {
    const initialData = ensureSchema({
        products: [
            { id: 1, name: 'Atta', searchname: 'atta', price: 65, shop: 'Lahore', verified: true },
            { id: 2, name: 'Chini', searchname: 'chini', price: 85, shop: 'Islamabad', verified: true },
            { id: 3, name: 'Namak', searchname: 'namak', price: 25, shop: 'Karachi', verified: true },
            { id: 4, name: 'Aloo', searchname: 'aloo', price: 45, shop: 'Lahore', verified: true }
        ]
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
}

function readDB() {
    try {
        return ensureSchema(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    } catch (e) {
        console.error('🚨 readDB() corrupted, repairing:', e.message);
        initDB();
        return ensureSchema(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    }
}

let writeCounter = 0;
function writeDB(data) {
    writeCounter++;
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

initDB();

const updateQueue = [];
let queueProcessing = false;
const queuedKeys = new Set();

function enqueueUpdate(task) {
    if (task.dedupe !== false && queuedKeys.has(task.key)) {
        return Promise.resolve();
    }
    if (task.dedupe !== false) queuedKeys.add(task.key);
    return new Promise((resolve, reject) => {
        updateQueue.push({ ...task, resolve, reject });
        processQueue();
    });
}

async function processQueue() {
    if (queueProcessing) return;
    queueProcessing = true;
    while (updateQueue.length > 0) {
        const task = updateQueue.shift();
        try {
            const result = await task.run();
            task.resolve(result);
        } catch (e) {
            console.error(`⚠️ Queue task failed for key "${task.key}":`, e.message);
            task.reject(e);
        } finally {
            if (task.dedupe !== false) queuedKeys.delete(task.key);
        }
    }
    queueProcessing = false;
}

function validatePrice(newPrice, oldPrice) {
    const { MIN_PRICE, MAX_PRICE, MAX_JUMP_PERCENT } = CONFIG.PRICE_VALIDATION;
    if (typeof newPrice !== 'number' || isNaN(newPrice)) {
        return { valid: false, reason: 'Price is not a number' };
    }
    if (newPrice < MIN_PRICE || newPrice > MAX_PRICE) {
        return { valid: false, reason: `Price out of range (${MIN_PRICE}-${MAX_PRICE})` };
    }
    if (oldPrice && oldPrice > 0) {
        const percentChange = Math.abs((newPrice - oldPrice) / oldPrice) * 100;
        if (percentChange > MAX_JUMP_PERCENT) {
            return { valid: false, reason: `Price jump ${percentChange.toFixed(1)}% exceeds limit`, percentChange };
        }
        return { valid: true, percentChange };
    }
    return { valid: true, percentChange: 0 };
}

function searchInLocalDB(searchKey, canonicalKey) {
    const db = readDB();
    return db.products.filter(product => {
        const nameMatch = product.name.toLowerCase().includes(searchKey);
        const searchNameMatch = product.searchname.toLowerCase().includes(searchKey);
        const canonicalMatch = canonicalKey && product.searchname.toLowerCase() === canonicalKey;
        return nameMatch || searchNameMatch || canonicalMatch;
    });
}

async function searchOnInternet(canonicalKey, rawSearchKey) {
    const prioritizedSources = getPrioritizedSources();
    const attempts = prioritizedSources.map(async (source) => {
        try {
            const targetUrl = source.buildUrl(canonicalKey || rawSearchKey);
            if (!targetUrl) return null;
            const startTime = Date.now();
            const response = await smartRetry(
                () => axios.get(targetUrl, { timeout: CONFIG.INTERNET_SOURCE_TIMEOUT_MS }),
                CONFIG.RETRY
            );
            const responseTimeMs = Date.now() - startTime;
            const $ = cheerio.load(response.data);
            const price = source.parse($, canonicalKey || rawSearchKey);
            if (price !== null && !isNaN(price) && price > 0) {
                recordSourceSuccess(source.name, responseTimeMs);
                return { price, source: source.name, foundAt: new Date().toISOString(), sourceScore: getSourceHealth(source.name)?.score ?? 100 };
            }
            recordSourceSuccess(source.name, responseTimeMs);
            return null;
        } catch (e) {
            recordSourceFailure(source.name);
            console.error(`⚠️ Internet source "${source.name}" failed:`, e.message);
            return null;
        }
    });
    const settled = await Promise.allSettled(attempts);
    const results = settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];
    results.sort((a, b) => b.sourceScore - a.sourceScore);
    return results[0];
}

function saveToLocalDB(productData) {
    const db = readDB();
    const existingIndex = db.products.findIndex(p => p.searchname.toLowerCase() === productData.searchname.toLowerCase());
    if (existingIndex !== -1) {
        db.products[existingIndex] = { ...db.products[existingIndex], ...productData, id: db.products[existingIndex].id };
        writeDB(db);
        return db.products[existingIndex];
    } else {
        const newProduct = {
            id: db.products.length > 0 ? Math.max(...db.products.map(p => p.id)) + 1 : 1,
            ...productData
        };
        db.products.push(newProduct);
        writeDB(db);
        return newProduct;
    }
}

function withTimeout(promise, ms, fallbackValue = null) {
    return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))]);
}

function hasInternetSource(canonicalKey) {
    if (!canonicalKey) return false;
    return TRUSTED_SOURCES.some(source => {
        try {
            return !!source.buildUrl(canonicalKey);
        } catch (e) {
            return false;
        }
    });
}

async function performSmartSearch(rawQuery, cityKey = null) {
    const startTime = Date.now();
    const searchKey = sanitizeInput(rawQuery).toLowerCase();
    if (!searchKey) return { success: false, error: 'Invalid search query' };
    
    const canonicalKey = resolveCanonicalKey(searchKey);
    const cacheKey = canonicalKey || searchKey;
    
    const cached = getFromCache(cacheKey);
    if (cached) return { success: true, data: cached, resolvedFrom: 'cache' };
    
    if (pendingRequests.has(cacheKey)) {
        return pendingRequests.get(cacheKey);
    }
    
    const searchPromise = (async () => {
        try {
            const canKey = canonicalKey || searchKey;
            const liveSourceAvailable = hasInternetSource(canKey);
            
            if (liveSourceAvailable) {
                const internetResult = await withTimeout(
                    searchOnInternet(canonicalKey, searchKey),
                    CONFIG.INTERNET_SEARCH_TOTAL_BUDGET_MS
                );
                
                if (internetResult) {
                    const existingLocal = searchInLocalDB(searchKey, canonicalKey)[0];
                    const oldPrice = existingLocal ? existingLocal.price : null;
                    const validation = validatePrice(internetResult.price, oldPrice);
                    
                    if (validation.valid) {
                        const productData = {
                            name: canKey.charAt(0).toUpperCase() + canKey.slice(1),
                            searchname: canKey,
                            price: internetResult.price,
                            shop: internetResult.source,
                            verified: false,
                            source: internetResult.source,
                            lastUpdated: internetResult.foundAt
                        };
                        
                        const savedProduct = saveToLocalDB(productData);
                        setToCache(cacheKey, [savedProduct]);
                        return { success: true, data: [savedProduct], resolvedFrom: 'internet' };
                    }
                }
                
                const fallbackResults = searchInLocalDB(searchKey, canonicalKey);
                if (fallbackResults.length > 0) {
                    setToCache(cacheKey, fallbackResults);
                    return { success: true, data: fallbackResults, resolvedFrom: 'database.json' };
                }
                
                return { success: false, message: 'Product Not Found' };
            }
            
            const localResults = searchInLocalDB(searchKey, canonicalKey);
            if (localResults.length > 0) {
                setToCache(cacheKey, localResults);
                return { success: true, data: localResults, resolvedFrom: 'database.json' };
            }
            
            return { success: false, message: 'Product Not Found' };
        } catch (e) {
            console.error('❌ Search error:', e.message);
            return { success: false, error: e.message };
        }
    })();
    
    pendingRequests.set(cacheKey, searchPromise);
    const result = await searchPromise;
    pendingRequests.delete(cacheKey);
    return result;
}

// ============ HTTP SERVER ============
const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    try {
        // Search endpoint
        if (pathname === '/api/search' && req.method === 'GET') {
            const searchQuery = query.q || '';
            const city = query.city || null;
            const result = await performSmartSearch(searchQuery, city);
            res.writeHead(result.success ? 200 : 404);
            res.end(JSON.stringify(result));
            return;
        }

        // PWA manifest
        if (pathname === '/manifest.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(PWA_MANIFEST));
            return;
        }

        // Service worker
        if (pathname === '/sw.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(PWA_SERVICE_WORKER);
            return;
        }

        // Serve index.html
        if (pathname === '/' || pathname === '/index.html') {
            const filePath = path.join(__dirname, 'index.html');
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Server error' }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(data);
                }
            });
            return;
        }

        // 404
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (e) {
        console.error('❌ Request error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Server error' }));
    }
});

const PORT = CONFIG.PORT;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT}`);
});

server.on('error', (e) => {
    console.error('🚨 Server error:', e.message);
});
