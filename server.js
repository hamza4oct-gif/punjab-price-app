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
    CACHE_TTL_MS: 60 * 60 * 1000,                    // 1 hour
    CACHE_REFRESH_THRESHOLD_MS: 10 * 60 * 1000,       // refresh in background if <10 min left
    AUTO_SYNC_INTERVAL_MS: 3 * 60 * 60 * 1000,        // Auto Sync every 3 hours
    BACKGROUND_REFRESH_INTERVAL_MS: 30 * 60 * 1000,   // 30 min
    CACHE_CLEANUP_INTERVAL_MS: 15 * 60 * 1000,        // 15 min
    MAX_SEARCH_HISTORY: 500,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX_REQUESTS: 60,
    RETRY: { retries: 2, baseDelayMs: 150 },
    INTERNET_SOURCE_TIMEOUT_MS: 2000,
    INTERNET_SEARCH_TOTAL_BUDGET_MS: 7000, // hard cap so a slow/unreachable source never makes the whole request hang
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
// Firestore sirf tab active hoga jab service account credentials mojood hon.
// Agar credentials na hon to app crash nahi karega, sirf Firestore skip ho jayega.
let firestoreDB = null;
try {
    const admin = require('firebase-admin');
    const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'firebase-service-account.json');
    if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
        const serviceAccount = require(SERVICE_ACCOUNT_PATH);
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        firestoreDB = admin.firestore();
        console.log('✅ Firestore connected');
    } else {
        console.log('⚠️  Firestore service account not found, running in JSON-only mode');
    }
} catch (e) {
    console.log('⚠️  Firestore module unavailable, running in JSON-only mode:', e.message);
    firestoreDB = null;
}

// ============ AMIS PUNJAB COMMODITY ID MAP (REAL, VERIFIED) ============
const AMIS_COMMODITY_MAP = {
    atta: 1,      // Wheat (closest available proxy for atta/flour)
    chini: 7,     // Sugar
    mirch: 29,    // Red Chilli Whole (Dry)
    haldi: 123,   // Turmeric Whole (ثابت ہلدی)
    pyaz: 23,     // Onion
    lasun: 73,    // Garlic (Local)
    dhaniya: 114, // Coriander (دھنیا)
    chawal: 4,    // Rice (IRRI)
    // ---- Fruits (verified against amis.pk commodity list) ----
    anar: 95,          // Pomegranate Desi
    seb: 40,           // Apple (Golden)
    kela: 42,          // Banana (DOZEN)
    aam: 92,           // Mango Desi
    malta: 45,         // Kinnow (100Pcs)
    angoor: 47,        // Grapes (Other)
    tarbooz: 76,       // Watermelon
    kharbooza: 75,     // Melon
    amrood: 43,        // Guava
    papita: 124,       // Papaya
    aarhoo: 88,        // Peach
    aloo_bukhara: 90,  // Plum
    lychee: 79,        // Lychee
    strawberry: 80,    // Strawberry
    loquat: 140,       // Loquat
    jamun: 104,        // Jaman
    narial: 120,       // Cocunut
    nashpati: 98       // Pear
    // NOTE: Pineapple (ananas) and Cherry are NOT tracked by AMIS Punjab at all —
    // no commodity ID exists for them on the source site, so they are intentionally
    // left out of this map. Searching them will correctly return "Product Not Found"
    // instead of a wrong price.
};

const NAHEED_PRODUCT_MAP = {
    chini: { url: 'https://www.naheed.pk/naheed-sugar-fine-1-kg', packKg: 1 },
    atta: { url: 'https://www.naheed.pk/bake-parlour-super-fine-atta-10-kg', packKg: 10 }
};

// ============ TRUSTED INTERNET SOURCES (REAL, VERIFIED SOURCES) ============
const TRUSTED_SOURCES = [
    {
        name: 'amis-punjab',
        buildUrl: (canonicalKey) => {
            const commodityId = AMIS_COMMODITY_MAP[canonicalKey];
            if (!commodityId) return null; // yeh commodity AMIS par mojood nahi
            return `http://www.amis.pk/Printer.aspx?searchType=0&commodityId=${commodityId}`;
        },
        parse: ($) => {
            let foundPrice = null;

            $('table tr').each((i, row) => {
                const cells = $(row).find('td');
                if (cells.length < 4) return; // header ya irrelevant row skip karain

                const cellTexts = [];
                cells.each((j, cell) => {
                    cellTexts.push($(cell).text().trim());
                });

                const candidates = [
                    cellTexts[cellTexts.length - 2],
                    cellTexts[cellTexts.length - 3]
                ];

                for (const candidate of candidates) {
                    const numericValue = parseFloat((candidate || '').replace(/,/g, ''));
                    if (!isNaN(numericValue) && numericValue > 0) {
                        foundPrice = numericValue;
                        break;
                    }
                }

                if (foundPrice !== null) {
                    return false; // cheerio .each: false return karne se loop break hota hai
                }
            });

            return foundPrice;
        }
    },
    {
        name: 'naheed-pk',
        buildUrl: (canonicalKey) => {
            const product = NAHEED_PRODUCT_MAP[canonicalKey];
            if (!product) return null; // is source par yeh product curated nahi hai
            return product.url;
        },
        parse: ($, canonicalKey) => {
            const priceContent = $('meta[property="product:price:amount"]').attr('content');
            if (!priceContent) return null;

            const totalPackPrice = parseFloat(priceContent);
            if (isNaN(totalPackPrice) || totalPackPrice <= 0) return null;

            const product = NAHEED_PRODUCT_MAP[canonicalKey];
            const packKg = (product && product.packKg) ? product.packKg : 1;

            return Math.round((totalPackPrice / packKg) * 100) / 100;
        }
    }
];

// ============ LEVEL 6: UNIVERSAL SOURCE REGISTRY ============
// Wraps TRUSTED_SOURCES with health + scoring metadata without altering the original
// source definitions (name/buildUrl/parse) above.
const sourceRegistry = new Map();
TRUSTED_SOURCES.forEach(source => {
    sourceRegistry.set(source.name, {
        name: source.name,
        score: 100,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        disabled: false,
        lastSuccess: null,
        lastFailure: null,
        avgResponseTimeMs: 0,
        totalResponseTimeMs: 0
    });
});

function getSourceHealth(name) {
    return sourceRegistry.get(name);
}

// ============ LEVEL 7: SOURCE HEALTH ENGINE ============
function recordSourceSuccess(name, responseTimeMs) {
    const health = sourceRegistry.get(name);
    if (!health) return;
    health.successCount++;
    health.consecutiveFailures = 0;
    health.disabled = false;
    health.lastSuccess = new Date().toISOString();
    health.totalResponseTimeMs += responseTimeMs;
    health.avgResponseTimeMs = Math.round(health.totalResponseTimeMs / health.successCount);
    health.score = Math.min(100, health.score + 5); // Level 18: score up on success
}

function recordSourceFailure(name) {
    const health = sourceRegistry.get(name);
    if (!health) return;
    health.failureCount++;
    health.consecutiveFailures++;
    health.lastFailure = new Date().toISOString();
    health.score = Math.max(0, health.score - 10); // Level 18: score down on failure
    if (health.consecutiveFailures >= CONFIG.SOURCE_HEALTH.MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE) {
        health.disabled = true;
        console.error(`🚨 Source "${name}" disabled after ${health.consecutiveFailures} consecutive failures`);
    }
}

// ============ LEVEL 4 & 18: SOURCE PRIORITY / SMART SOURCE SCORING ============
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

// ============ LEVEL 8: AUTO RECOVERY ENGINE ============
function attemptSourceRecovery() {
    sourceRegistry.forEach((health, name) => {
        if (health.disabled) {
            console.log(`🔄 Auto-recovery: re-enabling source "${name}" for retry`);
            health.disabled = false;
            health.consecutiveFailures = 0;
        }
    });
}

// ============ ALIAS MAP (ENGLISH / URDU / ROMAN URDU) ============
const ALIAS_MAP = {
    atta: ['atta', 'aata', 'ata', 'flour', 'wheat flour', 'گندم کا آٹا', 'آٹا'],
    chini: ['chini', 'cheeni', 'sugar', 'شکر', 'چینی'],
    namak: ['namak', 'salt', 'نمک'],
    mirch: ['mirch', 'mirchi', 'red chili', 'red chilli', 'chili powder', 'مرچ', 'لال مرچ'],
    haldi: ['haldi', 'turmeric', 'ہلدی'],
    pyaz: ['pyaz', 'pyaaz', 'onion', 'پیاز'],
    lasun: ['lasun', 'lehsun', 'garlic', 'لہسن'],
    dhaniya: ['dhaniya', 'dhania', 'coriander', 'دھنیا'],
    malai: ['malai', 'cream', 'ملائی'],
    makhan: ['makhan', 'butter', 'مکھن'],
    chawal: ['chawal', 'chaawal', 'rice', 'چاول'],
    anar: ['anar', 'anaar', 'pomegranate', 'انار'],
    seb: ['seb', 'saib', 'apple', 'سیب'],
    kela: ['kela', 'kaila', 'banana', 'کیلا'],
    aam: ['aam', 'mango', 'آم'],
    malta: ['malta', 'kinnow', 'kino', 'orange', 'مالٹا', 'کینو'],
    angoor: ['angoor', 'angur', 'grapes', 'انگور'],
    tarbooz: ['tarbooz', 'tarbuz', 'watermelon', 'تربوز'],
    kharbooza: ['kharbooza', 'kharbuza', 'muskmelon', 'melon', 'خربوزہ'],
    amrood: ['amrood', 'amrud', 'guava', 'امرود'],
    papita: ['papita', 'papaya', 'پپیتا'],
    aarhoo: ['aarhoo', 'aroo', 'peach', 'آڑو'],
    aloo_bukhara: ['aloo bukhara', 'aalu bukhara', 'plum', 'آلو بخارا'],
    lychee: ['lychee', 'litchi', 'لیچی'],
    strawberry: ['strawberry', 'سٹرابیری'],
    ananas: ['ananas', 'pineapple', 'اناناس'],
    loquat: ['loquat', 'lokat', 'لوکاٹ'],
    jamun: ['jamun', 'jaman', 'java plum', 'جامن'],
    cherry: ['cherry', 'چیری'],
    narial: ['narial', 'nariyal', 'coconut', 'ناریل'],
    nashpati: ['nashpati', 'pear', 'ناشپاتی']
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

// ============ INPUT SANITIZATION ============
function sanitizeInput(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .trim()
        .slice(0, 100)
        .replace(/[<>$`;{}]/g, '');
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

// ============ LEVEL 1: SMART RETRY HELPER ============
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

// ============ IN-MEMORY CACHE (1 HOUR TTL) + LEVEL 3: SMART CACHE REFRESH ============
const memoryCache = new Map();

function getFromCache(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryCache.delete(key); // expired cache hata dain
        return null;
    }
    // Smart Cache Refresh: if entry is close to expiry, refresh it in the background
    // (does not block the current request / does not change the returned data)
    if (entry.expiresAt - Date.now() < CONFIG.CACHE_REFRESH_THRESHOLD_MS && !entry.refreshing) {
        entry.refreshing = true;
        triggerBackgroundRefresh(key)
            .catch(() => {})
            .finally(() => { entry.refreshing = false; });
    }
    return entry.data;
}

function setToCache(key, data) {
    memoryCache.set(key, { data, expiresAt: Date.now() + CONFIG.CACHE_TTL_MS, refreshing: false });
}

function cleanupExpiredCache() {
    let removed = 0;
    for (const [key, entry] of memoryCache.entries()) {
        if (Date.now() > entry.expiresAt) {
            memoryCache.delete(key);
            removed++;
        }
    }
    if (removed > 0) console.log(`🧹 Cache cleanup: removed ${removed} expired entries`);
}

function warmupCache() {
    const db = readDB();
    db.products.forEach(p => setToCache(p.searchname, [p]));
    console.log(`🔥 Cache warmed up with ${db.products.length} products`);
}

// ============ CONCURRENT REQUEST DEDUPLICATION (LEVEL 5: INTERNET SEARCH LOCK) ============
const pendingRequests = new Map();

// ============ DATABASE HELPERS ============
function ensureSchema(db) {
    if (!db.syncLog) db.syncLog = [];
    if (!db.searchHistory) db.searchHistory = [];
    if (!db.predictions) db.predictions = {};
    if (!db.analytics) {
        db.analytics = {
            dailyStats: {},
            weeklyStats: {},
            monthlyStats: {},
            totals: {
                cacheHits: 0,
                firestoreHits: 0,
                internetHits: 0,
                databaseHits: 0,
                notFound: 0,
                totalSearches: 0,
                totalResponseTimeMs: 0
            }
        };
    }
    return db;
}

function initDB() {
    if (!fs.existsSync(DB_FILE)) {
        writeDefaultDB();
        return;
    }

    // Existing file — try to read/parse it. If it's corrupted (e.g. an
    // interrupted save left it truncated), DO NOT crash the server.
    // Instead: try the latest backup first, and only fall back to a fresh
    // default database.json if no usable backup exists.
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const existing = JSON.parse(raw);

        // Migration path: adds new schema fields without touching existing data.
        // Only writes to disk if something actually changed (avoids nodemon
        // restart loops from unnecessary writes).
        const migrated = ensureSchema(existing);
        const migratedJson = JSON.stringify(migrated, null, 2);
        if (migratedJson !== JSON.stringify(existing, null, 2)) {
            fs.writeFileSync(DB_FILE, migratedJson);
        }
    } catch (e) {
        console.error('🚨 database.json is corrupted/invalid:', e.message);

        // Save the broken file for inspection, then attempt recovery.
        try {
            fs.copyFileSync(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}.bak`);
        } catch (copyErr) {
            console.error('⚠️ Could not save a copy of the corrupted file:', copyErr.message);
        }

        const restored = restoreLatestBackup();
        if (restored) {
            try {
                JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); // verify the backup itself is valid
                console.log('✅ Recovered database.json from latest backup');
                return;
            } catch (verifyErr) {
                console.error('⚠️ Backup was also invalid, falling back to defaults:', verifyErr.message);
            }
        }

        writeDefaultDB();
        console.log('♻️ No usable backup found — recreated a fresh default database.json');
    }
}

function writeDefaultDB() {
    const initialData = ensureSchema({
        products: [
            { id: 1, name: 'Atta', searchname: 'atta', price: 65, shop: 'Lahore Market', verified: true },
            { id: 2, name: 'Chini', searchname: 'chini', price: 85, shop: 'Islamabad', verified: true },
            { id: 3, name: 'Namak', searchname: 'namak', price: 25, shop: 'Karachi', verified: true },
            { id: 4, name: 'Mirch', searchname: 'mirch', price: 450, shop: 'Peshawar', verified: true },
            { id: 5, name: 'Haldi', searchname: 'haldi', price: 380, shop: 'Multan', verified: true },
            { id: 6, name: 'Pyaz', searchname: 'pyaz', price: 45, shop: 'Rawalpindi', verified: true },
            { id: 7, name: 'Lasun', searchname: 'lasun', price: 120, shop: 'Faisalabad', verified: true },
            { id: 8, name: 'Dhaniya', searchname: 'dhaniya', price: 280, shop: 'Sargodha', verified: true },
            { id: 9, name: 'Malai', searchname: 'malai', price: 350, shop: 'Gujranwala', verified: true },
            { id: 10, name: 'Makhan', searchname: 'makhan', price: 650, shop: 'Sialkot', verified: true }
        ]
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
}

// readDB() is called on every request. If database.json somehow becomes
// corrupted while the server is already running (e.g. process killed mid-write),
// this self-heals the same way initDB() does instead of crashing the request.
function readDB() {
    try {
        return ensureSchema(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    } catch (e) {
        console.error('🚨 readDB() found corrupted database.json, repairing:', e.message);
        initDB();
        return ensureSchema(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    }
}

// ============ SMART BACKUP SYSTEM ============
function backupDB() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUP_DIR, `database-${timestamp}.json`);
        fs.copyFileSync(DB_FILE, backupPath);

        const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('database-')).sort();
        while (files.length > CONFIG.MAX_BACKUPS_KEPT) {
            fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
        }
    } catch (e) {
        console.error('⚠️ Backup failed:', e.message);
    }
}

function restoreLatestBackup() {
    if (!fs.existsSync(BACKUP_DIR)) return false;
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('database-')).sort();
    if (files.length === 0) return false;
    const latest = files[files.length - 1];
    fs.copyFileSync(path.join(BACKUP_DIR, latest), DB_FILE);
    console.log(`♻️ Restored database.json from backup: ${latest}`);
    return true;
}

let writeCounter = 0;
function writeDB(data) {
    writeCounter++;
    if (writeCounter % CONFIG.BACKUP_EVERY_N_WRITES === 0) backupDB();
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

initDB();

// ============ LEVEL 9: SMART UPDATE QUEUE ============
// Serializes all writes (Firestore + database.json) and prevents duplicate
// concurrent writes for the same key.
const updateQueue = [];
let queueProcessing = false;
const queuedKeys = new Set();

function enqueueUpdate(task) {
    if (task.dedupe !== false && queuedKeys.has(task.key)) {
        return Promise.resolve(); // duplicate write prevention
    }
    if (task.dedupe !== false) queuedKeys.add(task.key);

    return new Promise((resolve, reject) => {
        updateQueue.push({
            ...task,
            resolve,
            reject
        });
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

function getQueueStatus() {
    return { pending: updateQueue.length, processing: queueProcessing };
}

// ============ LEVEL 11: PRICE VALIDATION ENGINE ============
function validatePrice(newPrice, oldPrice) {
    const { MIN_PRICE, MAX_PRICE, MAX_JUMP_PERCENT } = CONFIG.PRICE_VALIDATION;
    if (typeof newPrice !== 'number' || isNaN(newPrice)) {
        return { valid: false, reason: 'Price is not a number' };
    }
    if (newPrice < MIN_PRICE || newPrice > MAX_PRICE) {
        return { valid: false, reason: `Price out of acceptable range (${MIN_PRICE}-${MAX_PRICE})` };
    }
    if (oldPrice && oldPrice > 0) {
        const percentChange = Math.abs((newPrice - oldPrice) / oldPrice) * 100;
        if (percentChange > MAX_JUMP_PERCENT) {
            return { valid: false, reason: `Price jump of ${percentChange.toFixed(1)}% exceeds threshold`, percentChange };
        }
        return { valid: true, percentChange };
    }
    return { valid: true, percentChange: 0 };
}

// ============ LEVEL 10: PRICE CHANGE DETECTOR ============
function detectPriceChange(oldPrice, newPrice) {
    if (!oldPrice || oldPrice <= 0) return { changed: false, percentChange: 0, direction: 'new' };
    const percentChange = ((newPrice - oldPrice) / oldPrice) * 100;
    return {
        changed: Math.abs(percentChange) > 0.01,
        percentChange: Math.round(percentChange * 100) / 100,
        direction: percentChange > 0 ? 'up' : percentChange < 0 ? 'down' : 'same'
    };
}

// ============ LEVEL 14 & 16: AI LEARNING ENGINE + AI PRICE PREDICTION ============
// Predictions are stored separately in db.predictions and NEVER overwrite real prices.
function recordPriceHistory(db, canonicalKey, price) {
    if (!db.predictions[canonicalKey]) {
        db.predictions[canonicalKey] = { history: [] };
    }
    db.predictions[canonicalKey].history.push({ price, timestamp: new Date().toISOString() });
    if (db.predictions[canonicalKey].history.length > 50) {
        db.predictions[canonicalKey].history.shift();
    }
}

function generatePricePrediction(canonicalKey, db) {
    const record = db.predictions[canonicalKey];
    if (!record || record.history.length < 3) {
        return { available: false, reason: 'Not enough historical data' };
    }
    const prices = record.history.map(h => h.price);
    const n = prices.length;
    const avg = prices.reduce((a, b) => a + b, 0) / n;

    // Simple linear-trend prediction (least squares) using historical data only.
    const xs = prices.map((_, i) => i);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i] - xMean) * (prices[i] - avg);
        den += (xs[i] - xMean) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const predictedPrice = Math.round((prices[n - 1] + slope) * 100) / 100;

    const variance = prices.reduce((sum, p) => sum + (p - avg) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const confidence = Math.max(0, Math.min(100, Math.round(100 - (stdDev / avg) * 100)));

    return {
        available: true,
        predictedPrice,
        trend: slope > 0.01 ? 'rising' : slope < -0.01 ? 'falling' : 'stable',
        confidence,
        basedOnDataPoints: n
    };
}

// ============ LEVEL 13: PERSISTENT SEARCH HISTORY / TRENDING PRODUCTS ============
function recordSearchHistory(db, query, canonicalKey, resolvedFrom, found) {
    db.searchHistory.push({
        query,
        canonicalKey: canonicalKey || null,
        resolvedFrom,
        found,
        timestamp: new Date().toISOString()
    });
    if (db.searchHistory.length > CONFIG.MAX_SEARCH_HISTORY) {
        db.searchHistory.shift();
    }
}

function getTrendingProducts(db, limit = 10) {
    const counts = {};
    db.searchHistory.forEach(h => {
        const key = h.canonicalKey || h.query;
        counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, count]) => ({ product: key, searchCount: count }));
}

// ============ LEVEL 15: SMART ANALYTICS ENGINE ============
function getDateKeys(date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil((((date - yearStart) / 86400000) + yearStart.getUTCDay() + 1) / 7);
    const week = `${date.getUTCFullYear()}-W${weekNum}`;
    const month = date.toISOString().slice(0, 7);
    return { day, week, month };
}

function recordAnalytics(db, resolvedFrom, responseTimeMs, found) {
    const totals = db.analytics.totals;
    totals.totalSearches++;
    totals.totalResponseTimeMs += responseTimeMs;
    if (!found) totals.notFound++;
    if (resolvedFrom === 'cache') totals.cacheHits++;
    if (resolvedFrom === 'firestore') totals.firestoreHits++;
    if (resolvedFrom === 'internet') totals.internetHits++;
    if (resolvedFrom === 'database.json') totals.databaseHits++;

    const { day, week, month } = getDateKeys();
    [[db.analytics.dailyStats, day], [db.analytics.weeklyStats, week], [db.analytics.monthlyStats, month]]
        .forEach(([bucket, key]) => {
            if (!bucket[key]) bucket[key] = { searches: 0, notFound: 0, totalResponseTimeMs: 0 };
            bucket[key].searches++;
            if (!found) bucket[key].notFound++;
            bucket[key].totalResponseTimeMs += responseTimeMs;
        });
}

function pct(part, total) {
    if (!total) return '0%';
    return `${((part / total) * 100).toFixed(1)}%`;
}

function getAnalyticsSummary(db) {
    const totals = db.analytics.totals;
    const avgResponseTime = totals.totalSearches > 0
        ? Math.round(totals.totalResponseTimeMs / totals.totalSearches)
        : 0;
    return {
        totals: {
            ...totals,
            averageResponseTimeMs: avgResponseTime,
            cacheHitRate: pct(totals.cacheHits, totals.totalSearches),
            firestoreHitRate: pct(totals.firestoreHits, totals.totalSearches),
            internetHitRate: pct(totals.internetHits, totals.totalSearches),
            databaseHitRate: pct(totals.databaseHits, totals.totalSearches),
            notFoundRate: pct(totals.notFound, totals.totalSearches)
        },
        daily: db.analytics.dailyStats,
        weekly: db.analytics.weeklyStats,
        monthly: db.analytics.monthlyStats,
        trending: getTrendingProducts(db)
    };
}

// ============ RATE LIMITER ============
const rateLimitMap = new Map();
function isRateLimited(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart > CONFIG.RATE_LIMIT_WINDOW_MS) {
        entry.count = 0;
        entry.windowStart = now;
    }
    entry.count++;
    rateLimitMap.set(ip, entry);
    return entry.count > CONFIG.RATE_LIMIT_MAX_REQUESTS;
}

// ============ DOES THIS ITEM HAVE A LIVE INTERNET SOURCE? ============
// Used to decide search priority: if an item has a real trusted source mapped
// (AMIS/Naheed), we should trust a LIVE price over whatever is sitting in
// database.json — local data is only a fallback, never an override.
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

// ============ CORE SEARCH LOGIC (CACHE -> FIRESTORE -> JSON -> INTERNET) ============

function searchInLocalDB(searchKey, canonicalKey) {
    const db = readDB();
    return db.products.filter(product => {
        const nameMatch = product.name.toLowerCase().includes(searchKey);
        const searchNameMatch = product.searchname.toLowerCase().includes(searchKey);
        const canonicalMatch = canonicalKey && product.searchname.toLowerCase() === canonicalKey;
        return nameMatch || searchNameMatch || canonicalMatch;
    });
}

async function searchInFirestore(searchKey, canonicalKey) {
    if (!firestoreDB) return null;
    try {
        const snapshot = await firestoreDB.collection('products')
            .where('searchname', '==', canonicalKey || searchKey)
            .limit(1)
            .get();

        if (snapshot.empty) return null;

        const doc = snapshot.docs[0];
        return { id: doc.id, ...doc.data() };
    } catch (e) {
        console.error('⚠️ Firestore search error:', e.message);
        return null;
    }
}

async function saveToFirestore(product) {
    if (!firestoreDB) return;
    try {
        const key = product.searchname;
        const existingSnapshot = await firestoreDB.collection('products')
            .where('searchname', '==', key)
            .limit(1)
            .get();

        if (!existingSnapshot.empty) {
            const docId = existingSnapshot.docs[0].id;
            await firestoreDB.collection('products').doc(docId).set(product, { merge: true });
        } else {
            await firestoreDB.collection('products').add(product);
        }
    } catch (e) {
        console.error('⚠️ Firestore save error:', e.message);
    }
}

function saveToLocalDB(productData) {
    const db = readDB();
    const existingIndex = db.products.findIndex(
        p => p.searchname.toLowerCase() === productData.searchname.toLowerCase()
    );

    if (existingIndex !== -1) {
        db.products[existingIndex] = {
            ...db.products[existingIndex],
            ...productData,
            id: db.products[existingIndex].id
        };
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

// ============ SEARCH TIMEOUT BUDGET ============
// Ensures internet search NEVER makes the overall request hang longer than
// CONFIG.INTERNET_SEARCH_TOTAL_BUDGET_MS — protects against the hosting
// platform's own gateway timeout kicking in and returning an HTML error page
// (which breaks the frontend's JSON parsing) instead of our own clean
// "Product Not Found" JSON response.
function withTimeout(promise, ms, fallbackValue = null) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))
    ]);
}

// ============ LEVEL 1 + 4 + 6 + 7 + 8 + 17 + 18: INTERNET SEARCH (RETRY, PRIORITY, ============
// ============ HEALTH TRACKING, MULTI-SOURCE AGGREGATION, SCORING) ============
async function searchOnInternet(canonicalKey, rawSearchKey) {
    const prioritizedSources = getPrioritizedSources();

    // Query all applicable sources IN PARALLEL (not one-by-one). This means total
    // wait time is roughly the slowest single source, not the sum of all of them —
    // which lets us afford more retry attempts per source within the same overall
    // time budget, making a single search much more likely to succeed on the first try.
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
                return {
                    price,
                    source: source.name,
                    foundAt: new Date().toISOString(),
                    sourceScore: getSourceHealth(source.name)?.score ?? 100
                };
            }
            recordSourceSuccess(source.name, responseTimeMs); // site reached fine, just no valid price row today
            return null;
        } catch (e) {
            recordSourceFailure(source.name);
            console.error(`⚠️ Internet source "${source.name}" failed after retries:`, e.message);
            return null;
        }
    });

    const settled = await Promise.allSettled(attempts);
    const results = settled
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

    if (results.length === 0) return null;
    if (results.length === 1) return results[0];

    // Multi Source Aggregation: prefer the result from the higher-scored source
    results.sort((a, b) => b.sourceScore - a.sourceScore);
    return results[0];
}

// ============ LEVEL 2: BACKGROUND AUTO REFRESH ============
async function triggerBackgroundRefresh(cacheKey) {
    try {
        const canonicalKey = resolveCanonicalKey(cacheKey) || cacheKey;
        const internetResult = await searchOnInternet(canonicalKey, cacheKey);
        if (!internetResult) return;

        const existing = searchInLocalDB(cacheKey, canonicalKey)[0];
        const oldPrice = existing ? existing.price : null;
        const validation = validatePrice(internetResult.price, oldPrice);
        if (!validation.valid) return;

        const productData = {
            name: canonicalKey.charAt(0).toUpperCase() + canonicalKey.slice(1),
            searchname: canonicalKey,
            price: internetResult.price,
            shop: internetResult.source,
            verified: false,
            source: internetResult.source,
            lastUpdated: internetResult.foundAt
        };

        await enqueueUpdate({
            key: `refresh:${canonicalKey}`,
            run: async () => {
                await saveToFirestore(productData);
                const savedProduct = saveToLocalDB(productData);
                setToCache(cacheKey, [savedProduct]);
                console.log(`🔁 Background refresh updated "${canonicalKey}"`);
            }
        });
    } catch (e) {
        console.error(`⚠️ Background refresh failed for "${cacheKey}":`, e.message);
    }
}

function finalizeSearchTracking(query, canonicalKey, resolvedFrom, found, responseTimeMs) {
    enqueueUpdate({
        key: `track:${Date.now()}:${Math.random()}`,
        dedupe: false,
        run: async () => {
            const db = readDB();
            recordSearchHistory(db, query, canonicalKey, resolvedFrom, found);
            recordAnalytics(db, resolvedFrom, responseTimeMs, found);
            writeDB(db);
        }
    }).catch(e => console.error('⚠️ Search tracking failed:', e.message));
}

async function performSmartSearch(rawQuery) {
    const startTime = Date.now();
    const searchKey = sanitizeInput(rawQuery).toLowerCase();

    if (!searchKey) {
        return { success: false, error: 'Invalid search query' };
    }

    const canonicalKey = resolveCanonicalKey(searchKey);
    const cacheKey = canonicalKey || searchKey;

    const cached = getFromCache(cacheKey);
    if (cached) {
        finalizeSearchTracking(rawQuery, canonicalKey, 'cache', true, Date.now() - startTime);
        return { success: true, data: cached, resolvedFrom: 'cache' };
    }

    if (pendingRequests.has(cacheKey)) {
        return pendingRequests.get(cacheKey);
    }

    const searchPromise = (async () => {
        try {
            const firestoreResult = await searchInFirestore(searchKey, canonicalKey);
            if (firestoreResult) {
                setToCache(cacheKey, [firestoreResult]);
                finalizeSearchTracking(rawQuery, canonicalKey, 'firestore', true, Date.now() - startTime);
                return { success: true, data: [firestoreResult], resolvedFrom: 'firestore' };
            }

            const canKey = canonicalKey || searchKey;
            const liveSourceAvailable = hasInternetSource(canKey);

            // ---- PRIORITY: if a real trusted source exists for this item, try LIVE
            // internet price FIRST. Local database.json is only used as a fallback
            // (e.g. if the source is temporarily down) — it never overrides a live price. ----
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
                        const changeInfo = detectPriceChange(oldPrice, internetResult.price);

                        const productData = {
                            name: canKey.charAt(0).toUpperCase() + canKey.slice(1),
                            searchname: canKey,
                            price: internetResult.price,
                            shop: internetResult.source,
                            verified: false,
                            source: internetResult.source,
                            lastUpdated: internetResult.foundAt,
                            aliases: canonicalKey ? ALIAS_MAP[canonicalKey] || [] : [],
                            priceChange: changeInfo
                        };

                        const savedProduct = await enqueueUpdate({
                            key: `save:${cacheKey}`,
                            run: async () => {
                                await saveToFirestore(productData);
                                const saved = saveToLocalDB(productData);

                                const db = readDB();
                                recordPriceHistory(db, canKey, internetResult.price);
                                writeDB(db);

                                return saved;
                            }
                        });

                        setToCache(cacheKey, [savedProduct]);
                        finalizeSearchTracking(rawQuery, canonicalKey, 'internet', true, Date.now() - startTime);
                        return { success: true, data: [savedProduct], resolvedFrom: 'internet' };
                    }
                    console.error(`🚫 Price validation failed for "${canKey}": ${validation.reason}`);
                }

                // Live source failed/unavailable this time — fall back to whatever
                // we have locally (last known price) instead of a hard failure.
                const fallbackResults = searchInLocalDB(searchKey, canonicalKey);
                if (fallbackResults.length > 0) {
                    setToCache(cacheKey, fallbackResults);
                    finalizeSearchTracking(rawQuery, canonicalKey, 'database.json (fallback)', true, Date.now() - startTime);
                    return { success: true, data: fallbackResults, resolvedFrom: 'database.json (fallback — live source unavailable)' };
                }

                finalizeSearchTracking(rawQuery, canonicalKey, 'not_found', false, Date.now() - startTime);
                return { success: false, message: 'Product Not Found' };
            }

            // ---- No live source mapped for this item at all — local database is
            // the only option, exactly as before. ----
            const localResults = searchInLocalDB(searchKey, canonicalKey);
            if (localResults.length > 0) {
                setToCache(cacheKey, localResults);
                finalizeSearchTracking(rawQuery, canonicalKey, 'database.json', true, Date.now() - startTime);
                return { success: true, data: localResults, resolvedFrom: 'database.json' };
            }

            finalizeSearchTracking(rawQuery, canonicalKey, 'not_found', false, Date.now() - startTime);
            return { success: false, message: 'Product Not Found' };
        } finally {
            pendingRequests.delete(cacheKey);
        }
    })();

    pendingRequests.set(cacheKey, searchPromise);
    return searchPromise;
}

// ============ LEVEL 12: SMART SCHEDULER ENGINE ============
function startScheduler() {
    // Auto Sync every 3 hours
    setInterval(() => {
        console.log('🔄 Scheduled auto-sync check:', new Date().toISOString());
        attemptSourceRecovery();
    }, CONFIG.AUTO_SYNC_INTERVAL_MS);

    // Automatic Cache Cleanup
    setInterval(cleanupExpiredCache, CONFIG.CACHE_CLEANUP_INTERVAL_MS);

    // Auto Recovery Engine check
    setInterval(attemptSourceRecovery, CONFIG.SOURCE_HEALTH.RECOVERY_CHECK_INTERVAL_MS);

    console.log('⏱️  Smart Scheduler started (auto-sync every 3h, cache cleanup every 15m)');
}

// Create server
const server = http.createServer((req, res) => {
    try {
        handleRequest(req, res);
    } catch (err) {
        console.error('🚨 Synchronous error in request handler (caught, server stayed alive):', err);
        try {
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(500);
            }
            res.end(JSON.stringify({ success: false, message: 'Internal server error' }));
        } catch (writeErr) {
            console.error('⚠️ Could not send error response:', writeErr.message);
        }
    }
});

function handleRequest(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Security Headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    // ============ API RATE LIMITER (applies to /api/* only) ============
    if (pathname.startsWith('/api/')) {
        const clientIp = req.socket.remoteAddress || 'unknown';
        if (isRateLimited(clientIp)) {
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(429);
            res.end(JSON.stringify({ success: false, message: 'Too many requests, please slow down' }));
            return;
        }
    }

    // ============ SERVE FRONTEND (index.html) ============
    // Ab yeh server khud aapki index.html bhi dikhata hai — isliye phone/computer
    // kisi bhi browser mein seedha http://<IP>:5000 khol kar poori app chal sakti hai,
    // aur "content://" ya "file://" se kholne wale purane errors khatam ho jayenge.
    if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
        const indexPath = path.join(__dirname, 'index.html');
        fs.readFile(indexPath, 'utf8', (err, html) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('index.html nahi mili. Isay server.js ke sath usi folder mein rakhein.');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        });
        return;
    }

    // Baqi sab API responses JSON hi rahenge
    res.setHeader('Content-Type', 'application/json');

    // ============ SEARCH API (SMART MULTILINGUAL + CACHE + INTERNET FALLBACK) ============
    if (pathname === '/api/search' && req.method === 'GET') {
        const searchQuery = query.q;

        if (!searchQuery) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Query required' }));
            return;
        }

        performSmartSearch(searchQuery)
            .then(result => {
                if (result.success) {
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, data: result.data, resolvedFrom: result.resolvedFrom }));
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ success: false, message: result.message || result.error || 'Product Not Found' }));
                }
            })
            .catch(e => {
                console.error('⚠️ Search pipeline error:', e.message);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, message: 'Internal search error' }));
            });
        return;
    }

    // ============ GET ALL PRODUCTS ============
    if (pathname === '/api/products' && req.method === 'GET') {
        const db = readDB();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: db.products }));
        return;
    }

    // ============ GET SINGLE PRODUCT ============
    if (pathname.match(/^\/api\/products\/\d+$/) && req.method === 'GET') {
        const id = parseInt(pathname.split('/')[3]);
        const db = readDB();
        const product = db.products.find(p => p.id === id);

        if (product) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, data: product }));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ success: false, message: 'Product not found' }));
        }
        return;
    }

    // ============ ADD PRODUCT ============
    if (pathname === '/api/products' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { name, searchname, price, shop } = JSON.parse(body);

                if (!name || !price || !shop) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Missing required fields' }));
                    return;
                }

                const db = readDB();
                const newProduct = {
                    id: db.products.length > 0 ? Math.max(...db.products.map(p => p.id)) + 1 : 1,
                    name,
                    searchname: searchname || name.toLowerCase(),
                    price: parseFloat(price),
                    shop,
                    verified: false
                };

                db.products.push(newProduct);
                writeDB(db);

                res.writeHead(200);
                res.end(JSON.stringify({ success: true, message: 'Product added', data: newProduct }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ============ UPDATE PRICE (AUTO SYNC) ============
    if (pathname.match(/^\/api\/products\/\d+\/price$/) && req.method === 'PUT') {
        const id = parseInt(pathname.split('/')[3]);
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { price } = JSON.parse(body);

                if (!price) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Price required' }));
                    return;
                }

                const db = readDB();
                const product = db.products.find(p => p.id === id);

                if (!product) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ success: false, message: 'Product not found' }));
                    return;
                }

                const oldPrice = product.price;
                product.price = parseFloat(price);
                product.verified = true;

                db.syncLog.push({
                    timestamp: new Date().toISOString(),
                    productId: product.id,
                    productName: product.name,
                    oldPrice,
                    newPrice: price,
                    source: 'punjab-govt'
                });

                writeDB(db);

                memoryCache.delete(product.searchname);

                res.writeHead(200);
                res.end(JSON.stringify({ success: true, message: 'Price updated', data: product }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ============ UPDATE PRODUCT ============
    if (pathname.match(/^\/api\/products\/\d+$/) && req.method === 'PUT') {
        const id = parseInt(pathname.split('/')[3]);
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { name, price, shop } = JSON.parse(body);
                const db = readDB();
                const product = db.products.find(p => p.id === id);

                if (!product) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ success: false, message: 'Product not found' }));
                    return;
                }

                if (name) product.name = name;
                if (price) product.price = parseFloat(price);
                if (shop) product.shop = shop;

                writeDB(db);

                memoryCache.delete(product.searchname);

                res.writeHead(200);
                res.end(JSON.stringify({ success: true, message: 'Product updated', data: product }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ============ DELETE PRODUCT ============
    if (pathname.match(/^\/api\/products\/\d+$/) && req.method === 'DELETE') {
        const id = parseInt(pathname.split('/')[3]);
        const db = readDB();
        const index = db.products.findIndex(p => p.id === id);

        if (index === -1) {
            res.writeHead(404);
            res.end(JSON.stringify({ success: false, message: 'Product not found' }));
            return;
        }

        const deleted = db.products.splice(index, 1);
        writeDB(db);

        if (deleted[0]) {
            memoryCache.delete(deleted[0].searchname);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Product deleted', data: deleted }));
        return;
    }

    // ============ GET SYNC LOG ============
    if (pathname === '/api/sync-log' && req.method === 'GET') {
        const db = readDB();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: db.syncLog }));
        return;
    }

    // ============ STATISTICS (original fields preserved + advanced analytics added) ============
    if (pathname === '/api/statistics' && req.method === 'GET') {
        const db = readDB();
        const products = db.products;

        const stats = {
            totalProducts: products.length,
            averagePrice: (products.reduce((sum, p) => sum + p.price, 0) / products.length).toFixed(2),
            highestPrice: Math.max(...products.map(p => p.price)),
            lowestPrice: Math.min(...products.map(p => p.price)),
            totalSyncs: db.syncLog.length,
            advanced: getAnalyticsSummary(db)
        };

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: stats }));
        return;
    }

    // ============ CALCULATOR ============
    if (pathname === '/api/calculate' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { productId, quantity } = JSON.parse(body);

                if (!productId || !quantity) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Product ID and quantity required' }));
                    return;
                }

                const db = readDB();
                const product = db.products.find(p => p.id === parseInt(productId));

                if (!product) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ success: false, message: 'Product not found' }));
                    return;
                }

                const total = product.price * parseFloat(quantity);

                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    data: {
                        product: product.name,
                        quantity,
                        unitPrice: product.price,
                        total: total.toFixed(2)
                    }
                }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ============ NEW: HEALTH CHECK API ============
    if (pathname === '/api/health' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            status: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
            firestoreConnected: !!firestoreDB,
            cacheSize: memoryCache.size,
            queue: getQueueStatus(),
            sources: Array.from(sourceRegistry.values()),
            timestamp: new Date().toISOString()
        }));
        return;
    }

    // ============ NEW: ANALYTICS API ============
    if (pathname === '/api/analytics' && req.method === 'GET') {
        const db = readDB();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: getAnalyticsSummary(db) }));
        return;
    }

    // ============ NEW: VERSION API ============
    if (pathname === '/api/version' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            version: CONFIG.VERSION,
            node: process.version
        }));
        return;
    }

    // ============ NEW: TRENDING PRODUCTS ============
    if (pathname === '/api/trending' && req.method === 'GET') {
        const db = readDB();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: getTrendingProducts(db) }));
        return;
    }

    // ============ NEW: SEARCH HISTORY ============
    if (pathname === '/api/search-history' && req.method === 'GET') {
        const db = readDB();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: db.searchHistory.slice(-100).reverse() }));
        return;
    }

    // ============ NEW: PRICE PREDICTION ============
    if (pathname === '/api/predict' && req.method === 'GET') {
        const key = sanitizeInput(query.searchname || '').toLowerCase();
        if (!key) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'searchname query param required' }));
            return;
        }
        const canonicalKey = resolveCanonicalKey(key) || key;
        const db = readDB();
        const prediction = generatePricePrediction(canonicalKey, db);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: prediction }));
        return;
    }

    // ============ NEW: SOURCE HEALTH / STATISTICS ============
    if (pathname === '/api/sources' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: Array.from(sourceRegistry.values()) }));
        return;
    }

    // ============ NEW: BACKUP / RESTORE ============
    if (pathname === '/api/backup' && req.method === 'POST') {
        backupDB();
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Backup created' }));
        return;
    }

    if (pathname === '/api/restore' && req.method === 'POST') {
        const restored = restoreLatestBackup();
        res.writeHead(restored ? 200 : 404);
        res.end(JSON.stringify({ success: restored, message: restored ? 'Restored from latest backup' : 'No backup available' }));
        return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
}

server.listen(CONFIG.PORT, () => {
    console.log(`✅ Server running on http://localhost:${CONFIG.PORT}`);
    console.log(`📱 Isi WiFi par apne phone se: http://<is-computer-ka-IP>:${CONFIG.PORT}`);
    console.log(`📡 Enterprise backend v${CONFIG.VERSION} ready!`);
    warmupCache();
    startScheduler();
});
