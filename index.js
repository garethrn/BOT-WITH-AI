const baileys = require('@whiskeysockets/baileys');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = baileys;
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const csv = require('csv-parser');
const pino = require('pino');
const nodemailer = require('nodemailer');
const qrcodeImg = require('qrcode');
const path = require('path');
const { Readable } = require('stream');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const {
    importBackup,
    teachBehavior,
    getDashboardData,
    setMetaConnectionIntent,
    generateLearnedReply,
    buildOpenAISystemPrompt,
    rememberConversationReply
} = require('./lib/ai-learning');

const BROWSER_FINGERPRINTS = [
    ['Mac OS', 'Chrome', '1.0.0'],
    ['Windows', 'Firefox', '1.0.0'],
    ['Linux', 'Safari', '1.0.0']
];

const ADMIN_JID = process.env.ADMIN_JID;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const IS_TEST_MODE = process.env.BOT_TEST_MODE === '1';

const STORAGE_DIR = path.join(__dirname, 'storage');
const BACKUPS_DIR = path.join(STORAGE_DIR, 'backups');
const CSV_FILE = path.join(__dirname, 'products.csv');
const AUTH_DIR = path.join(STORAGE_DIR, 'auth_info');
const LEADS_FILE = path.join(STORAGE_DIR, 'learning_leads.json');
const ORDERS_FILE = path.join(STORAGE_DIR, 'orders.json');
const CONTACTS_FILE = path.join(STORAGE_DIR, 'contacts.json');
const CONTACT_PHONES_FILE = path.join(STORAGE_DIR, 'contact_phones.json');
const CONVERSATION_TABS_FILE = path.join(STORAGE_DIR, 'conversation_tabs.json');
const MAX_BACKUP_UPLOAD_BYTES = 1024 * 1024 * 1000;

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

let products = [];
let userCarts = {};
let latestQR = null;
let retryCount = 0;
const MAX_RETRIES = 10;
let botConnectionState = 'starting';
const openaiClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
let botSocket = null;
let isBotPaused = false;
const pausedChats = new Set();
const chatLog = new Map();
const chatLastActivity = new Map();
const MAX_CHAT_MESSAGES = 500;
let learningLeads = [];
let orders = [];
let contactNames = {};
let contactPhones = {};
let conversationTabOverrides = {};

const PRODUCT_FIELD_ALIASES = {
    ID: ['ID', 'ProductID', 'Code'],
    SKU: ['SKU', 'Sku', 'ProductSKU'],
    Category: ['Category', 'Department'],
    Subcategory: ['Subcategory', 'Sub Category', 'Product Type', 'Type'],
    Name: ['Name', 'Product', 'Product Name', 'Item Name', 'Description'],
    Size: ['Size', 'Dimensions'],
    Finish: ['Finish', 'Material'],
    SingleOrDoubleSided: ['SingleOrDoubleSided', 'Single Or Double Sided', 'Sides'],
    UnitsPerProduct: ['UnitsPerProduct', 'Units Per Product', 'Pack Size', 'Quantity', 'Qty'],
    PriceType: ['PriceType', 'Price Type', 'Pricing Type'],
    PricePerSqm: ['PricePerSqm', 'Price Per Sqm', 'Sqm Price'],
    FixedPrice: ['FixedPrice', 'Fixed Price', 'Price', 'Selling Price', 'Unit Price', 'Amount'],
    MinPrice: ['MinPrice', 'Minimum Price'],
    DesignFee: ['DesignFee', 'Design Fee'],
    PolePrice: ['PolePrice', 'Pole Price'],
    InstallationFee: ['InstallationFee', 'Installation Fee'],
    Aliases: ['Aliases', 'Alias', 'Keywords', 'Tags']
};

function loadJsonFile(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) return fallbackValue;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : fallbackValue;
    } catch {
        return fallbackValue;
    }
}

function saveJsonFile(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function toNumber(value, fallback = 0) {
    const normalized = String(value ?? '')
        .replace(/[^\d,.-]+/g, '')
        .replace(/,/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatCurrency(value) {
    return `R${toNumber(value).toFixed(2)}`;
}

function normalizeCsvHeader(header) {
    return String(header || '')
        .replace(/^\uFEFF/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function getFirstMappedValue(row, fieldName) {
    const normalizedRow = Object.entries(row || {}).reduce((acc, [key, value]) => {
        acc[normalizeCsvHeader(key)] = value;
        return acc;
    }, {});
    const aliases = PRODUCT_FIELD_ALIASES[fieldName] || [fieldName];
    for (const alias of aliases) {
        const value = normalizedRow[normalizeCsvHeader(alias)];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value).trim();
        }
    }
    return '';
}

function normalizeProductRecord(row) {
    const product = {
        ID: getFirstMappedValue(row, 'ID'),
        SKU: getFirstMappedValue(row, 'SKU'),
        Category: getFirstMappedValue(row, 'Category'),
        Subcategory: getFirstMappedValue(row, 'Subcategory'),
        Name: getFirstMappedValue(row, 'Name'),
        Size: getFirstMappedValue(row, 'Size'),
        Finish: getFirstMappedValue(row, 'Finish'),
        SingleOrDoubleSided: getFirstMappedValue(row, 'SingleOrDoubleSided'),
        UnitsPerProduct: getFirstMappedValue(row, 'UnitsPerProduct'),
        PriceType: getFirstMappedValue(row, 'PriceType').toLowerCase(),
        PricePerSqm: getFirstMappedValue(row, 'PricePerSqm'),
        FixedPrice: getFirstMappedValue(row, 'FixedPrice'),
        MinPrice: getFirstMappedValue(row, 'MinPrice'),
        DesignFee: getFirstMappedValue(row, 'DesignFee'),
        PolePrice: getFirstMappedValue(row, 'PolePrice'),
        InstallationFee: getFirstMappedValue(row, 'InstallationFee'),
        Aliases: getFirstMappedValue(row, 'Aliases')
    };

    if (!product.Name) product.Name = product.Subcategory || product.Category || 'Product';
    if (product.PriceType !== 'sqm' && product.PriceType !== 'fixed') {
        product.PriceType = product.PricePerSqm ? 'sqm' : 'fixed';
    }
    return product;
}

function parseProductsCsvStream(stream) {
    return new Promise((resolve, reject) => {
        const rows = [];
        stream
            .pipe(csv({ mapHeaders: ({ header }) => String(header || '').replace(/^\uFEFF/, '').trim() }))
            .on('data', (row) => rows.push(row))
            .on('error', reject)
            .on('end', () => {
                const normalizedProducts = rows.map((row) => normalizeProductRecord(row)).filter(Boolean);
                const validProducts = normalizedProducts.filter((product) => {
                    const hasName = Boolean((product.Name || '').trim());
                    const hasPrice = toNumber(product.FixedPrice) > 0 || toNumber(product.PricePerSqm) > 0;
                    return hasName && hasPrice;
                });
                if (validProducts.length === 0) {
                    reject(new Error('No valid product rows found in CSV.'));
                    return;
                }
                resolve(validProducts);
            });
    });
}

function parseUnitsPerProduct(value) {
    const match = String(value || '').match(/\d+/);
    const parsed = match ? parseInt(match[0], 10) : 1;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function calculateFixedPrice(product, qty) {
    const unitsPerPack = parseUnitsPerProduct(product.UnitsPerProduct);
    const packPrice = toNumber(product.FixedPrice);
    const packs = Math.ceil(qty / unitsPerPack);
    return { total: packs * packPrice, unitsPerPack, packs };
}

function calculateSqmPrice(product, qty, widthMm, heightMm) {
    const sqm = (widthMm / 1000) * (heightMm / 1000);
    const raw = sqm * toNumber(product.PricePerSqm) * qty;
    const minTotal = toNumber(product.MinPrice) * qty;
    return { total: Math.max(raw, minTotal), sqmPerUnit: sqm };
}

function getProductDisplayPrice(product) {
    if (String(product.PriceType || '').toLowerCase() === 'sqm') {
        const minPrice = toNumber(product.MinPrice);
        const minText = minPrice > 0 ? ` (min ${formatCurrency(minPrice)})` : '';
        return `${formatCurrency(product.PricePerSqm)}/m²${minText}`;
    }
    const unitsPerPack = parseUnitsPerProduct(product.UnitsPerProduct);
    const unitText = unitsPerPack > 1 ? `/${unitsPerPack} units` : '/unit';
    return `${formatCurrency(product.FixedPrice)}${unitText}`;
}

function buildProductLine(product, index) {
    const name = product.Name || product.Subcategory || product.Category || `Product ${index + 1}`;
    return `${index + 1}. [${product.ID || '?'}] ${name} — ${getProductDisplayPrice(product)}`;
}

function convertDimensionToMm(value, unit) {
    const amount = parseFloat(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const normalizedUnit = String(unit || 'mm').toLowerCase();
    if (normalizedUnit === 'm') return amount * 1000;
    if (normalizedUnit === 'cm') return amount * 10;
    return amount;
}

function parseDimensionsFromText(text) {
    const raw = String(text || '').toLowerCase();
    const directMatch = raw.match(/(\d{1,6}(?:\.\d{1,3})?)\s{0,4}(mm|cm|m)?\s{0,4}[x×]\s{0,4}(\d{1,6}(?:\.\d{1,3})?)\s{0,4}(mm|cm|m)?/i);
    if (!directMatch) return null;
    const widthMm = convertDimensionToMm(directMatch[1], directMatch[2]);
    const heightMm = convertDimensionToMm(directMatch[3], directMatch[4] || directMatch[2]);
    if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) return null;
    return { widthMm, heightMm };
}

learningLeads = loadJsonFile(LEADS_FILE, []);
orders = loadJsonFile(ORDERS_FILE, []);
contactNames = loadJsonFile(CONTACTS_FILE, {});
contactPhones = loadJsonFile(CONTACT_PHONES_FILE, {});
conversationTabOverrides = loadJsonFile(CONVERSATION_TABS_FILE, {});

function getRetryDelay(count) {
    const safeCount = Math.max(1, Number(count) || 1);
    return Math.min(5000 * Math.pow(2, safeCount - 1), 60000);
}

function loadProducts() {
    if (!fs.existsSync(CSV_FILE)) {
        fs.writeFileSync(CSV_FILE, 'ID,Category,Subcategory,Name,PriceType,FixedPrice,PricePerSqm,MinPrice,UnitsPerProduct\n1,General,General,Demo Item,fixed,10.00,0,0,1\n');
    }
    return parseProductsCsvStream(fs.createReadStream(CSV_FILE)).then((results) => {
        products = results;
        console.log(`✅ Inventory Loaded (${products.length} products)`);
        return results;
    });
}
loadProducts().catch((error) => {
    console.error('❌ Failed to load products:', error);
});

function logChatMessage(jid, role, text) {
    const cleanJid = String(jid || '').trim();
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleanJid || !cleanText) return;
    if (cleanJid.endsWith('@status')) return;
    if (cleanText === '[non-text message]') return;
    if (cleanText.startsWith('Status:')) return;
    if (!isDirectUserJid(cleanJid) && !cleanJid.includes('@lid')) return;

    const existing = chatLog.get(cleanJid) || [];
    existing.push({
        role,
        text: cleanText,
        timestamp: new Date().toISOString()
    });

    if (existing.length > MAX_CHAT_MESSAGES) {
        existing.splice(0, existing.length - MAX_CHAT_MESSAGES);
    }

    chatLog.set(cleanJid, existing);
    chatLastActivity.set(cleanJid, new Date().toISOString());
}

function pushLearningLead(jid, text) {
    const message = String(text || '').trim();
    if (!jid || !message) return;
    if (message.length < 3) return;

    const existing = learningLeads.find((lead) => lead.jid === jid && lead.message === message);
    if (existing) {
        existing.count = (existing.count || 1) + 1;
        existing.lastSeen = new Date().toISOString();
    } else {
        learningLeads.push({
            jid,
            message,
            count: 1,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        });
    }
    learningLeads = learningLeads.slice(-1000);
    saveJsonFile(LEADS_FILE, learningLeads);
}

function recordOrder(jid, cart, total) {
    const order = {
        id: `ord_${Date.now()}`,
        jid,
        items: Array.isArray(cart) ? cart.map((item) => ({
            id: item.id || item.ID,
            name: item.name || item.Name || 'Product',
            qty: item.qty,
            price: toNumber(item.price || item.Price || item.total || 0)
        })) : [],
        total: Number(total.toFixed(2)),
        status: 'quoted',
        createdAt: new Date().toISOString()
    };
    orders.push(order);
    orders = orders.slice(-2000);
    saveJsonFile(ORDERS_FILE, orders);
    return order;
}

function normalizeToJid(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    if (input.includes('@')) return input;
    const digits = normalizeContactPhone(input);
    return digits ? `${digits}@s.whatsapp.net` : '';
}

function normalizeContactPhone(raw) {
    if (!raw) return '';
    let digits = String(raw).replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('00') && digits.length > 2) digits = digits.slice(2);
    if (digits.startsWith('0') && digits.length === 10) return `27${digits.slice(1)}`;
    if (digits.length >= 7 && digits.length <= 15) return digits;
    return '';
}

function extractPhoneDigitsFromJid(jid) {
    const value = String(jid || '').trim();
    if (!value) return '';
    const [localPart, domain = ''] = value.split('@');
    if (domain !== 's.whatsapp.net' && domain !== 'c.us') return '';
    return normalizeContactPhone(localPart.split(':')[0]);
}

function phoneFromJid(jid) {
    const explicit = contactPhones[String(jid || '').trim()];
    const digits = explicit || extractPhoneDigitsFromJid(jid);
    return digits ? `+${digits}` : '';
}

function isDirectUserJid(jid) {
    return typeof jid === 'string' && (
        jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')
    );
}

function isIgnoredChatJid(jid) {
    return typeof jid === 'string' && (
        jid === 'status@broadcast' ||
        jid.endsWith('@g.us') ||
        jid.endsWith('@newsletter')
    );
}

function resolveIncomingJid(key) {
    const primary = key?.remoteJid || '';
    const participant = key?.participant || '';
    if (isIgnoredChatJid(primary)) return primary;
    if (isDirectUserJid(primary)) return primary;
    if (isDirectUserJid(participant)) return participant;
    return primary || participant || '';
}

function extractIncomingMessageText(message) {
    const payload = message?.ephemeralMessage?.message
        || message?.viewOnceMessage?.message
        || message?.viewOnceMessageV2?.message
        || message?.viewOnceMessageV2Extension?.message
        || message;
    const text = payload?.conversation
        || payload?.extendedTextMessage?.text
        || payload?.imageMessage?.caption
        || payload?.videoMessage?.caption
        || payload?.documentMessage?.caption
        || payload?.buttonsResponseMessage?.selectedDisplayText
        || payload?.listResponseMessage?.title
        || payload?.listResponseMessage?.singleSelectReply?.selectedRowId
        || payload?.templateButtonReplyMessage?.selectedDisplayText
        || payload?.templateButtonReplyMessage?.selectedId
        || '';
    return typeof text === 'string' ? text.trim() : '';
}

function parseContactsFromText(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
        const clean = line.replace(/\uFEFF/g, '');
        const parts = clean.includes(',') ? clean.split(',') : clean.split('|');
        if (parts.length >= 2) {
            const name = parts[0].trim();
            const phone = normalizeContactPhone(parts.slice(1).join(' ').trim());
            const jid = phone ? `${phone}@s.whatsapp.net` : '';
            if (name && jid) results.push({ jid, name, phone });
            continue;
        }
        const vcfName = clean.match(/^FN:(.+)$/i);
        if (vcfName) {
            results.push({ pendingName: vcfName[1].trim() });
            continue;
        }
        const vcfPhone = clean.match(/^TEL[^:]*:(.+)$/i);
        if (vcfPhone) {
            const last = results[results.length - 1];
            const phone = normalizeContactPhone(vcfPhone[1].trim());
            const jid = phone ? `${phone}@s.whatsapp.net` : '';
            if (last && last.pendingName && jid) {
                last.jid = jid;
                last.name = last.pendingName;
                last.phone = phone;
                delete last.pendingName;
            }
        }
    }
    return results.filter((entry) => entry.jid && entry.name);
}

function conversationStatusForJid(jid) {
    if (conversationTabOverrides[jid]) return conversationTabOverrides[jid];
    if (pausedChats.has(jid) || isBotPaused) return 'paused';
    const hasOrders = orders.some((order) => order.jid === jid);
    if (hasOrders) return 'quoted';
    return 'idle';
}

function getConversationSummaries() {
    const summaries = [];
    const allJids = new Set([
        ...Array.from(chatLog.keys()),
        ...Object.keys(contactNames),
        ...orders.map((order) => order.jid),
        ...learningLeads.map((lead) => lead.jid)
    ]);

    for (const jid of allJids) {
        const messages = chatLog.get(jid) || [];
        const last = messages[messages.length - 1];
        summaries.push({
            jid,
            phone: phoneFromJid(jid),
            name: contactNames[jid] || '',
            lastMessage: last?.text || '',
            lastRole: last?.role || '',
            lastTimestamp: last?.timestamp || chatLastActivity.get(jid) || null,
            paused: pausedChats.has(jid),
            status: conversationStatusForJid(jid),
            messageCount: messages.length
        });
    }

    summaries.sort((a, b) => {
        const ta = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
        const tb = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
        return tb - ta;
    });

    return summaries;
}

const PRODUCT_TEXT_STOP_WORDS = new Set([
    'i', 'me', 'my', 'need', 'want', 'for', 'with', 'the', 'and', 'a', 'an', 'to', 'please',
    'quote', 'price', 'pricing', 'cost', 'can', 'you', 'help', 'on', 'of', 'in', 'at'
]);
const FINISH_KEYWORD_PATTERNS = [
    { pattern: /\blaminat(?:ed|ion)?\b/, value: 'laminated' },
    { pattern: /\bsemi[\s-]?gloss\b/, value: 'semi gloss' },
    { pattern: /\bgloss(?:y)?\b/, value: 'gloss' },
    { pattern: /\bmatte?\b/, value: 'matt' },
    { pattern: /\buv\b/, value: 'uv' }
];

function normalizeTextForMatch(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9\sx]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseQuantityFromText(text = '', dimensions = null) {
    const raw = String(text || '');
    const explicit = raw.match(/\b(?:qty|quantity|copies|cards|labels|banners|stickers|units|pieces)\s{0,3}(?:[:\-]\s{0,3})?(\d{1,6})\b/i);
    if (explicit) {
        const parsed = parseInt(explicit[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const prefixed = raw.match(/\b(\d{1,6})\s{0,3}(?:copies|cards|labels|banners|stickers|units|pieces)\b/i);
    if (prefixed) {
        const parsed = parseInt(prefixed[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    const withoutDimensions = raw.replace(/\b\d{1,6}(?:\.\d{1,3})?\s{0,4}(?:mm|cm|m)?\s{0,4}[x×]\s{0,4}\d{1,6}(?:\.\d{1,3})?\s{0,4}(?:mm|cm|m)?\b/gi, ' ');
    const values = Array.from(withoutDimensions.matchAll(/\b(\d{2,6})\b/g)).map((m) => parseInt(m[1], 10));
    const candidates = values.filter((num) => Number.isFinite(num) && num > 0);
    if (candidates.length === 0) return null;
    return candidates[0];
}

function parseProductRequestDetails(text = '') {
    const normalized = normalizeTextForMatch(text);
    const dimensions = parseDimensionsFromText(normalized);
    const quantity = parseQuantityFromText(normalized, dimensions);

    let side = '';
    if (normalized.includes('double sided') || normalized.includes('double-sided') || normalized.includes('both sided') || normalized.includes('both-sided') || normalized.includes('2 sided') || normalized.includes('2-sided')) side = 'double';
    if (normalized.includes('single sided') || normalized.includes('single-sided') || normalized.includes('one sided') || normalized.includes('one-sided') || normalized.includes('1 sided') || normalized.includes('1-sided')) side = 'single';

    const sizeToken = (normalized.match(/\b(a0|a1|a2|a3|a4|a5|a6)\b/) || [])[1] || '';
    const finishOptions = [...new Set(products.map((p) => normalizeTextForMatch(p.Finish)).filter(Boolean))];
    let finish = finishOptions.find((item) => item.length >= 4 && normalized.includes(item)) || '';
    if (!finish) {
        const hintedKeyword = FINISH_KEYWORD_PATTERNS.find((entry) => entry.pattern.test(normalized))?.value;
        if (hintedKeyword) {
            finish = finishOptions.find((item) => item.includes(hintedKeyword)) || hintedKeyword;
        }
    }

    const tokens = normalized
        .split(' ')
        .filter((token) => token.length > 1 && !PRODUCT_TEXT_STOP_WORDS.has(token) && !/^\d+$/.test(token));

    return { normalized, tokens, quantity, side, sizeToken, finish, dimensions };
}

function scoreProductVariant(product, request) {
    const normalizedName = normalizeTextForMatch([product.Name, product.Category, product.Subcategory, product.SKU, product.Aliases].join(' '));
    const normalizedFinish = normalizeTextForMatch(product.Finish);
    const normalizedSide = normalizeTextForMatch(product.SingleOrDoubleSided);
    const normalizedSize = normalizeTextForMatch(product.Size);
    const units = parseUnitsPerProduct(product.UnitsPerProduct);

    let score = 0;
    for (const token of request.tokens) {
        if (normalizedName.includes(token)) score += 3;
        if (normalizeTextForMatch(product.Name).includes(token)) score += 2;
    }

    if (request.side) score += normalizedSide.includes(request.side) ? 8 : -5;
    if (request.finish) score += normalizedFinish.includes(request.finish) ? 7 : -4;
    if (request.sizeToken) score += normalizedSize.includes(request.sizeToken) ? 8 : -4;

    if (request.dimensions) {
        const width = String(request.dimensions.widthMm);
        const height = String(request.dimensions.heightMm);
        if (normalizedSize.includes(width) && normalizedSize.includes(height)) score += 10;
        if (String(product.PriceType || '').toLowerCase() === 'sqm') score += 4;
    }

    if (request.quantity && String(product.PriceType || '').toLowerCase() === 'fixed') {
        if (units === request.quantity) score += 8;
        else score += Math.max(0, 5 - Math.floor(Math.abs(units - request.quantity) / 100));
    }

    if (String(product.PriceType || '').toLowerCase() === 'sqm' && !request.dimensions) {
        score -= 1;
    }

    return score;
}

function rankProductsForText(text = '') {
    const request = parseProductRequestDetails(text);
    return products.map((product) => ({
        product,
        score: scoreProductVariant(product, request)
    })).sort((a, b) => b.score - a.score);
}

function inferCatalogFocusFromText(text = '') {
    const ranked = rankProductsForText(text).filter((item) => item.score > 0);
    if (!ranked.length) return null;
    const top = ranked[0];
    const topProduct = top.product || {};
    return {
        category: String(topProduct.Category || '').trim(),
        subcategory: String(topProduct.Subcategory || '').trim(),
        productName: String(topProduct.Name || '').trim()
    };
}

function inferActiveCatalogFocus(jid, currentText = '') {
    if (!jid) return inferCatalogFocusFromText(currentText);
    const recentUserText = (chatLog.get(jid) || [])
        .filter((entry) => entry?.role === 'user' && entry?.text)
        .slice(-6)
        .map((entry) => String(entry.text || '').trim())
        .filter(Boolean);
    const combined = [...recentUserText, String(currentText || '').trim()].filter(Boolean).join(' ');
    return inferCatalogFocusFromText(combined);
}

function productSearchBlob(product) {
    return normalizeTextForMatch([
        product.Name,
        product.Category,
        product.Subcategory,
        product.SubSubcategory,
        product.SKU,
        product.Aliases,
        product.Size,
        product.Finish
    ].join(' '));
}

function buildProductContextForAI(userText = '', jid = '') {
    const request = parseProductRequestDetails(userText);
    const activeFocus = inferActiveCatalogFocus(jid, userText);
    const tokenSet = new Set(request.tokens);
    if (request.sizeToken) tokenSet.add(request.sizeToken);
    if (request.finish) tokenSet.add(request.finish);
    if (request.side) tokenSet.add(request.side);
    const queryTokens = Array.from(tokenSet).filter(Boolean);

    const keywordMatches = products.filter((product) => {
        if (queryTokens.length === 0) return false;
        const blob = productSearchBlob(product);
        const matched = queryTokens.filter((token) => blob.includes(token)).length;
        return matched >= Math.min(2, queryTokens.length);
    });
    const ranked = rankProductsForText(userText);
    const rankedSelection = ranked.filter((item) => item.score > 0).slice(0, 20).map((item) => item.product);
    const merged = [];
    const seenIds = new Set();
    for (const product of [...keywordMatches, ...rankedSelection]) {
        const key = String(product.ID || product.SKU || product.Name);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        merged.push(product);
        if (merged.length >= 24) break;
    }
    const focusMatched = activeFocus
        ? merged.filter((product) => {
            const category = String(product.Category || '').trim().toLowerCase();
            const subcategory = String(product.Subcategory || '').trim().toLowerCase();
            const focusCategory = String(activeFocus.category || '').trim().toLowerCase();
            const focusSubcategory = String(activeFocus.subcategory || '').trim().toLowerCase();
            return (focusCategory && category === focusCategory) || (focusSubcategory && subcategory === focusSubcategory);
        })
        : [];
    const fallback = focusMatched.length ? focusMatched : (merged.length ? merged : products.slice(0, 24));
    if (!fallback.length) return 'No product catalog loaded.';
    return fallback.map((product) => {
        const name = product.Name || product.Subcategory || product.Category || 'Product';
        const pricing = String(product.PriceType || '').toLowerCase() === 'sqm'
            ? `${formatCurrency(product.PricePerSqm)}/m²${toNumber(product.MinPrice) > 0 ? ` (min ${formatCurrency(product.MinPrice)})` : ''}`
            : `${formatCurrency(product.FixedPrice)} per ${parseUnitsPerProduct(product.UnitsPerProduct) > 1 ? `${parseUnitsPerProduct(product.UnitsPerProduct)} units` : 'unit'}`;
        const options = [
            product.ID ? `id: ${product.ID}` : '',
            product.SKU ? `sku: ${product.SKU}` : '',
            product.Category ? `category: ${product.Category}` : '',
            product.Subcategory ? `subcategory: ${product.Subcategory}` : '',
            product.Size ? `size: ${product.Size}` : '',
            product.Finish ? `finish: ${product.Finish}` : '',
            product.SingleOrDoubleSided ? `sides: ${product.SingleOrDoubleSided}` : '',
            product.UnitsPerProduct ? `qty option: ${product.UnitsPerProduct}` : '',
            product.PriceType ? `priceType: ${product.PriceType}` : ''
        ].filter(Boolean).join(' | ');
        return `- ${name} (${options || 'standard'}) | ${pricing}`;
    }).join('\n');
}

function sizeDistanceScore(requestDimensions, productSize) {
    if (!requestDimensions) return 0;
    const normalizedSize = String(productSize || '')
        .replace(/\b(width|height|length|w|h|l)\b/gi, ' ')
        .replace(/\s+/g, ' ');
    const parsed = parseDimensionsFromText(normalizedSize);
    if (!parsed) return Number.POSITIVE_INFINITY;
    const direct = Math.abs(parsed.widthMm - requestDimensions.widthMm) + Math.abs(parsed.heightMm - requestDimensions.heightMm);
    const swapped = Math.abs(parsed.widthMm - requestDimensions.heightMm) + Math.abs(parsed.heightMm - requestDimensions.widthMm);
    return Math.min(direct, swapped);
}

function buildCatalogSuggestionLines(items, limit = 4) {
    return items.slice(0, limit).map((product, index) => {
        const name = product.Name || product.Subcategory || product.Category || `Product ${index + 1}`;
        const size = product.Size ? ` | size: ${product.Size}` : '';
        return `${index + 1}. ${name}${size} | ${getProductDisplayPrice(product)}`;
    }).join('\n');
}

function findCatalogSuggestions(request, limit = 5) {
    const tokenCounted = products.map((product) => {
        const blob = productSearchBlob(product);
        const overlap = request.tokens.filter((token) => blob.includes(token)).length;
        return { product, overlap };
    }).filter((entry) => entry.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, limit)
        .map((entry) => entry.product);
    if (tokenCounted.length > 0) return tokenCounted;
    return products.slice(0, limit);
}

function buildQuoteForMatchedProduct(product, request, options = {}) {
    if (!product) return null;
    const qty = request.quantity;
    const isSqm = String(product.PriceType || '').toLowerCase() === 'sqm';
    const name = product.Name || product.Subcategory || 'Product';

    if (!qty) {
        return `I can quote *${name}* for you. Please share quantity so I can calculate the correct price.`;
    }

    let materialTotal = 0;
    let dimensionsLabel = '';
    if (isSqm) {
        const dimensions = request.dimensions;
        if (!dimensions) {
            return `For *${name}*, I still need the size in mm to quote accurately (example: 1200x600).`;
        }
        const pricing = calculateSqmPrice(product, qty, dimensions.widthMm, dimensions.heightMm);
        materialTotal = pricing.total;
        dimensionsLabel = `${dimensions.widthMm}x${dimensions.heightMm}mm`;
    } else {
        const pricing = calculateFixedPrice(product, qty);
        materialTotal = pricing.total;
    }

    const designFee = toNumber(product.DesignFee) * qty;
    const polesCost = toNumber(product.PolePrice) * qty;
    const installationFee = toNumber(product.InstallationFee) * qty;
    const total = materialTotal + designFee + polesCost + installationFee;
    const details = [product.Size, product.Finish, product.SingleOrDoubleSided].filter(Boolean).join(' • ');

    return [
        `Best match from our catalog: *${name}*${details ? ` (${details})` : ''}.`,
        options.closestSizeNote || '',
        `Quantity: ${qty}${dimensionsLabel ? ` | Size used: ${dimensionsLabel}` : ''}`,
        `• Material: ${formatCurrency(materialTotal)}`,
        designFee > 0 ? `• Design fee: ${formatCurrency(designFee)}` : '',
        polesCost > 0 ? `• Pole fee: ${formatCurrency(polesCost)}` : '',
        installationFee > 0 ? `• Installation fee: ${formatCurrency(installationFee)}` : '',
        `*Estimated total: ${formatCurrency(total)}*`,
        'Would you like me to confirm turnaround and delivery next?'
    ].filter(Boolean).join('\n');
}

function buildVariantKey(product) {
    return [
        normalizeTextForMatch(product.Category),
        normalizeTextForMatch(product.Subcategory),
        normalizeTextForMatch(product.SubSubcategory),
        normalizeTextForMatch(product.Name),
        normalizeTextForMatch(product.Size),
        normalizeTextForMatch(product.Finish),
        normalizeTextForMatch(product.SingleOrDoubleSided),
        String(product.PriceType || '').toLowerCase()
    ].join('|');
}

function pickBestQuantityTier(candidates, requestedQty) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => parseUnitsPerProduct(a.UnitsPerProduct) - parseUnitsPerProduct(b.UnitsPerProduct));
    const preferred = sorted.find((item) => parseUnitsPerProduct(item.UnitsPerProduct) >= requestedQty);
    return preferred || sorted[sorted.length - 1];
}

function selectProductsByQuantityTier(productsToFilter, requestedQty) {
    if (!requestedQty) return productsToFilter;
    const groups = new Map();
    for (const item of productsToFilter) {
        const isFixed = String(item.PriceType || '').toLowerCase() === 'fixed';
        if (!isFixed) continue;
        const key = buildVariantKey(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    if (groups.size === 0) return productsToFilter;

    const selected = new Set();
    for (const entries of groups.values()) {
        const tier = pickBestQuantityTier(entries, requestedQty);
        if (tier) selected.add(tier);
    }
    return productsToFilter.filter((item) => {
        const isFixed = String(item.PriceType || '').toLowerCase() === 'fixed';
        return !isFixed || selected.has(item);
    });
}

function buildCsvPricingReply(text = '', jid = '') {
    const pricingIntent = /\b(price|pricing|quote|cost|how much|need|want|print|banner|sign|card|sticker|label|flyer|poster|invoice)\b/i.test(text);
    if (!pricingIntent) return null;

    const request = parseProductRequestDetails(text);
    const ranked = rankProductsForText(text).filter((item) => item.score > 0);
    if (!ranked.length) {
        const suggestions = findCatalogSuggestions(request, 4);
        return [
            'I can only quote using prices from our products catalog.',
            'I could not find an exact product match yet. Please confirm the product name/category and size.',
            suggestions.length ? `Closest catalog options:\n${buildCatalogSuggestionLines(suggestions, 4)}` : ''
        ].filter(Boolean).join('\n\n');
    }
    const topScore = ranked[0].score;
    let candidatePool = ranked.filter((item) => item.score >= Math.max(1, topScore - 3)).map((item) => item.product);
    const activeFocus = inferActiveCatalogFocus(jid, text);
    if (activeFocus) {
        const focusMatchedPool = candidatePool.filter((product) => {
            const category = String(product.Category || '').trim().toLowerCase();
            const subcategory = String(product.Subcategory || '').trim().toLowerCase();
            const focusCategory = String(activeFocus.category || '').trim().toLowerCase();
            const focusSubcategory = String(activeFocus.subcategory || '').trim().toLowerCase();
            return (focusCategory && category === focusCategory) || (focusSubcategory && subcategory === focusSubcategory);
        });
        if (focusMatchedPool.length > 0) candidatePool = focusMatchedPool;
    }

    const sideOptions = [...new Set(candidatePool.map((item) => normalizeTextForMatch(item.SingleOrDoubleSided)).filter(Boolean))];
    if (!request.side && sideOptions.length > 1) {
        return `I can help with accurate pricing. Should this be *single-sided* or *double-sided*?`;
    }

    const finishOptions = [...new Set(candidatePool.map((item) => normalizeTextForMatch(item.Finish)).filter(Boolean))];
    if (!request.finish && finishOptions.length > 1) {
        const preview = finishOptions.slice(0, 4).join(', ');
        return `Great, I found matching products. Which finish do you prefer: ${preview}?`;
    }

    let filtered = [...candidatePool];
    if (request.side) filtered = filtered.filter((item) => normalizeTextForMatch(item.SingleOrDoubleSided).includes(request.side));
    if (request.finish) filtered = filtered.filter((item) => normalizeTextForMatch(item.Finish).includes(request.finish));
    if (request.sizeToken) filtered = filtered.filter((item) => normalizeTextForMatch(item.Size).includes(request.sizeToken));
    if (filtered.length === 0) filtered = candidatePool;
    filtered = selectProductsByQuantityTier(filtered, request.quantity);

    if (!request.quantity) {
        const sample = filtered[0];
        const name = sample?.Name || sample?.Subcategory || 'that product';
        return `I found *${name}* options for you. Please share quantity so I can give the correct price.`;
    }

    const pricedCandidates = filtered.map((product) => {
        const isSqm = String(product.PriceType || '').toLowerCase() === 'sqm';
        if (isSqm && !request.dimensions) return { product, total: Number.POSITIVE_INFINITY };
        const sizeDistance = request.dimensions && !isSqm
            ? sizeDistanceScore(request.dimensions, product.Size)
            : 0;
        let materialTotal = 0;
        if (isSqm) {
            materialTotal = calculateSqmPrice(product, request.quantity, request.dimensions.widthMm, request.dimensions.heightMm).total;
        } else {
            materialTotal = calculateFixedPrice(product, request.quantity).total;
        }
        const total = materialTotal
            + (toNumber(product.DesignFee) * request.quantity)
            + (toNumber(product.PolePrice) * request.quantity)
            + (toNumber(product.InstallationFee) * request.quantity);
        return { product, total, sizeDistance };
    }).filter((item) => Number.isFinite(item.total));

    if (!pricedCandidates.length) {
        return 'I’m almost ready to quote — please share the exact size in mm so I can calculate correctly.';
    }

    pricedCandidates.sort((a, b) => {
        const sizeDiff = Number(a.sizeDistance || 0) - Number(b.sizeDistance || 0);
        if (request.dimensions && sizeDiff !== 0) return sizeDiff;
        return a.total - b.total;
    });
    const best = pricedCandidates[0];
    if (request.dimensions && String(best.product.PriceType || '').toLowerCase() !== 'sqm' && !Number.isFinite(best.sizeDistance)) {
        const fixedWithSizes = filtered
            .filter((item) => String(item.PriceType || '').toLowerCase() === 'fixed' && Number.isFinite(sizeDistanceScore(request.dimensions, item.Size)))
            .sort((a, b) => sizeDistanceScore(request.dimensions, a.Size) - sizeDistanceScore(request.dimensions, b.Size));
        if (fixedWithSizes.length > 0) {
            return [
                'I can only price using sizes that exist in our products catalog.',
                `Requested size: ${request.dimensions.widthMm}x${request.dimensions.heightMm}mm`,
                `Closest available sizes:\n${buildCatalogSuggestionLines(fixedWithSizes, 3)}`,
                'Please confirm one of these sizes and I will quote immediately.'
            ].join('\n\n');
        }
    }
    const closestSizeNote = request.dimensions
        && String(best.product.PriceType || '').toLowerCase() === 'fixed'
        && Number.isFinite(best.sizeDistance)
        && best.sizeDistance > 0
        ? `Requested size ${request.dimensions.widthMm}x${request.dimensions.heightMm}mm is not an exact catalog row; using closest catalog size: ${best.product.Size}.`
        : '';
    return buildQuoteForMatchedProduct(best.product, request, { closestSizeNote });
}

function buildConversationalFallback(userText = '', jid = '') {
    const prompt = String(userText || '').toLowerCase();
    const shortlist = buildProductContextForAI(userText, jid)
        .split('\n')
        .slice(0, 3)
        .join('\n');

    if (prompt.includes('price') || prompt.includes('quote') || prompt.includes('cost')) {
        return [
            'Absolutely, I can help with pricing.',
            'Please share the product, quantity, and size (if needed), and I’ll prepare your quote.',
            '',
            'Here are a few matching options from our catalog:',
            shortlist
        ].join('\n');
    }

    return [
        'Hi 👋 Thanks for your message — I can help with product advice, pricing, and quotes.',
        'Tell me what you need (product type, quantity, and size if applicable), and I’ll assist like a sales consultant.',
        '',
        'Popular catalog options:',
        shortlist
    ].join('\n');
}

function buildConversationContextForAI(jid, currentUserText = '') {
    if (!jid) return [];
    const currentNormalized = String(currentUserText || '').slice(0, 700).trim().toLowerCase();
    const recent = (chatLog.get(jid) || [])
        .filter((entry) => entry && entry.text)
        .slice(-9)
        .map((entry) => ({
            role: entry.role === 'user' ? 'user' : 'assistant',
            content: String(entry.text).slice(0, 700)
        }));
    if (recent.length > 0) {
        const last = recent[recent.length - 1];
        if (last.role === 'user' && String(last.content || '').trim().toLowerCase() === currentNormalized) {
            recent.pop();
        }
    }
    return recent.slice(-8);
}

async function sendTrackedMessage(jid, text, role = 'bot') {
    if (!botSocket) throw new Error('WhatsApp socket not ready');
    await botSocket.sendMessage(jid, { text });
    logChatMessage(jid, role, text);
}

async function generateOpenAIReply(userText, jid = '') {
    if (!openaiClient) return null;
    const trimmed = String(userText || '').trim();
    if (!trimmed) return null;

    try {
        const productContext = buildProductContextForAI(trimmed, jid);
        const activeFocus = inferActiveCatalogFocus(jid, trimmed);
        const focusInstruction = activeFocus
            ? `Current customer product focus: ${activeFocus.subcategory || activeFocus.category || activeFocus.productName}. Stay on this product family unless the customer explicitly asks to switch products.`
            : 'Keep product suggestions tightly aligned to the customer’s current product request.';
        const conversationContext = buildConversationContextForAI(jid, trimmed);
        const completion = await openaiClient.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
                {
                    role: 'system',
                    content: [
                        buildOpenAISystemPrompt(),
                        'You are a human-like WhatsApp receptionist and sales consultant.',
                        'Do not tell the customer to "type menu" or use command-style instructions unless specifically asked.',
                        'Use the product catalog below as the source of truth for products and pricing.',
                        'Quote prices only from the catalog lines and mention the matched product name in your response.',
                        'Find likely products for the customer proactively based on their message.',
                        'When relevant, recommend up to 3 best-fit products by name and give pricing from the catalog context.',
                        'Do not ask the customer to choose by product ID.',
                        'Keep the conversation going naturally with one helpful follow-up question.',
                        'If details are missing, ask only the most important next question (quantity, size, finish, or deadline).',
                        'Answer the customer’s latest message directly and do not give unrelated generic replies.',
                        'Never invent pricing. Use only provided catalog context for prices, otherwise ask a clarifying question.',
                        focusInstruction,
                        `Catalog context:\n${productContext}`
                    ].join('\n\n')
                },
                ...conversationContext,
                { role: 'user', content: trimmed.slice(0, 1000) }
            ],
            max_tokens: 360,
            temperature: 0.2
        });

        const reply = completion.choices?.[0]?.message?.content
            ? String(completion.choices[0].message.content).trim()
            : '';
        return reply || null;
    } catch (error) {
        console.error('❌ OpenAI response failed:', error?.message || error);
        return null;
    }
}

async function runOpenAIConnectivityCheck() {
    if (!openaiClient) {
        return {
            enabled: false,
            responding: false,
            model: OPENAI_MODEL,
            error: 'OPENAI_API_KEY is not configured.'
        };
    }

    const started = Date.now();
    try {
        const completion = await openaiClient.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
                { role: 'system', content: 'Reply with exactly: OPENAI_OK' },
                { role: 'user', content: 'Health check' }
            ],
            max_tokens: 12,
            temperature: 0
        });
        const reply = String(completion.choices?.[0]?.message?.content || '').trim();
        const responding = reply.includes('OPENAI_OK');
        return {
            enabled: true,
            responding,
            model: OPENAI_MODEL,
            latencyMs: Date.now() - started,
            reply
        };
    } catch (error) {
        return {
            enabled: true,
            responding: false,
            model: OPENAI_MODEL,
            latencyMs: Date.now() - started,
            error: error?.message || 'OpenAI request failed.'
        };
    }
}

async function generateAICoachReply(userMessage, history = []) {
    const prompt = String(userMessage || '').trim();
    if (!prompt) return null;

    if (openaiClient) {
        try {
            const safeHistory = Array.isArray(history)
                ? history
                    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
                    .slice(-6)
                    .map((item) => ({
                        role: item.role,
                        content: String(item.content || '').slice(0, 800)
                    }))
                : [];
            const completion = await openaiClient.chat.completions.create({
                model: OPENAI_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: [
                            'You are an expert WhatsApp sales and support coach for a business admin.',
                            'Help the admin plan responses to clients.',
                            'Be practical, concise, and action-oriented.',
                            'Return clear sections: "Suggested Reply", "Why this works", and "Next question to ask".',
                            'Respect these active teaching rules and tone preferences:',
                            buildOpenAISystemPrompt()
                        ].join('\n')
                    },
                    ...safeHistory,
                    { role: 'user', content: prompt.slice(0, 1200) }
                ],
                max_tokens: 400
            });
            const reply = completion.choices?.[0]?.message?.content?.trim();
            if (reply) return reply;
        } catch (error) {
            console.error('⚠️ AI coach fallback due to OpenAI error:', error?.message || error);
        }
    }

    return [
        '*Suggested Reply*',
        `Thanks for your message. ${prompt ? 'Based on what you shared, ' : ''}I can help with pricing and next steps right away.`,
        '',
        '*Why this works*',
        '- Confirms the customer is heard',
        '- Keeps your tone helpful and professional',
        '- Moves the conversation toward a clear action',
        '',
        '*Next question to ask*',
        'Can you share quantity, size, and deadline so I can give you an accurate quote?'
    ].join('\n');
}

async function startBot(fingerprintIndex = 0) {
    const browser = BROWSER_FINGERPRINTS[fingerprintIndex % BROWSER_FINGERPRINTS.length];
    console.log(`🔄 Initializing WhatsApp Engine... (attempt ${retryCount + 1}, browser: ${browser[0]} / ${browser[1]})`);
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser,
            qrTimeout: 120000
        });
        botSocket = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                botConnectionState = 'qr_ready';
                console.log('⚠️ QR Code generated. Visit /qr to scan it.');
                try {
                    latestQR = await qrcodeImg.toBuffer(qr, { type: 'png' });
                } catch (qrErr) {
                    console.error('❌ Failed to generate QR buffer:', qrErr);
                }

                if (EMAIL_USER && EMAIL_PASS) {
                    const qrPath = path.join(STORAGE_DIR, 'bot-qr.png');
                    try {
                        await qrcodeImg.toFile(qrPath, qr);
                        transporter.sendMail({
                            from: EMAIL_USER,
                            to: EMAIL_USER,
                            subject: 'WhatsApp Bot Login',
                            text: 'Scan the attached QR code, or visit /qr on the bot server.',
                            attachments: [{ filename: 'bot-qr.png', path: qrPath }]
                        }, (mailErr) => {
                            if (mailErr) console.error('❌ Failed to send QR email:', mailErr.message);
                            else console.log('📧 QR code emailed successfully.');
                        });
                    } catch (mailFileErr) {
                        console.error('❌ Failed to write QR file for email:', mailFileErr);
                    }
                }
            }

            if (connection === 'close') {
                const err = lastDisconnect?.error;
                const statusCode = (err instanceof Boom) ? err.output.statusCode : 0;
                botConnectionState = 'disconnected';
                botSocket = null;
                console.error(`🔌 Connection closed. Status: ${statusCode}. Reason: ${err?.message || 'unknown'}`);
                retryCount++;
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    console.log('🗑️  Auth invalidated — clearing auth state and restarting...');
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    retryCount = 0;
                    startBot(0);
                } else if (retryCount < MAX_RETRIES) {
                    const delay = getRetryDelay(retryCount);
                    const nextFingerprint = retryCount % BROWSER_FINGERPRINTS.length;
                    setTimeout(() => startBot(nextFingerprint), delay);
                } else {
                    console.error(`🛑 Max retries (${MAX_RETRIES}) reached. Bot stopped.`);
                }
            } else if (connection === 'open') {
                retryCount = 0;
                latestQR = null;
                botConnectionState = 'connected';
                console.log('🚀 BOT IS CONNECTED AND LIVE!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type && type !== 'notify') return;
            for (const msg of Array.isArray(messages) ? messages : []) {
                try {
                    if (!msg || !msg.message || !msg.key || msg.key.fromMe) continue;
                    if (msg.broadcast || msg.key.remoteJid === 'status@broadcast') continue;

                    const jid = resolveIncomingJid(msg.key);
                    if (!jid || isIgnoredChatJid(jid)) continue;

                    const text = extractIncomingMessageText(msg.message);
                    const normalizedText = text.toLowerCase();
                    if (text) logChatMessage(jid, 'user', text);

                    const messagePayload = msg.message?.ephemeralMessage?.message
                        || msg.message?.viewOnceMessage?.message
                        || msg.message?.viewOnceMessageV2?.message
                        || msg.message?.viewOnceMessageV2Extension?.message
                        || msg.message;

                    if (jid === ADMIN_JID && messagePayload?.documentMessage) {
                        try {
                            const doc = messagePayload.documentMessage;
                            if (doc?.fileName && doc.fileName.toLowerCase().endsWith('.csv')) {
                                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                                fs.writeFileSync(CSV_FILE, buffer);
                                await loadProducts();
                                await sendTrackedMessage(jid, '📦 Products updated!');
                                continue;
                            }
                        } catch (docErr) {
                            console.error('❌ Failed to process incoming document message:', docErr);
                        }
                    }

                    if (isBotPaused || pausedChats.has(jid)) {
                        pushLearningLead(jid, text);
                        continue;
                    }

                    if (!text) continue;

                    if (normalizedText === 'hello' || normalizedText === 'menu') {
                        const greetInput = normalizedText === 'menu'
                            ? 'Customer asked to view products and pricing.'
                            : text;
                        const aiGreeting = await generateOpenAIReply(greetInput, jid);
                        if (aiGreeting) {
                            await sendTrackedMessage(jid, aiGreeting);
                            rememberConversationReply(greetInput, aiGreeting);
                        } else {
                            const fallbackReply = buildConversationalFallback(greetInput, jid);
                            await sendTrackedMessage(jid, fallbackReply);
                            rememberConversationReply(greetInput, fallbackReply);
                        }
                    } else if (normalizedText.startsWith('products ')) {
                        const keyword = normalizedText.replace(/^products\s+/, '').trim();
                        const matches = products.filter((product) =>
                            [product.ID, product.Name, product.Category, product.Subcategory, product.Aliases]
                                .map((value) => String(value || '').toLowerCase())
                                .some((value) => value.includes(keyword))
                        );
                        if (!matches.length) {
                            await sendTrackedMessage(jid, `No products found for "${keyword}".`);
                            continue;
                        }
                        const result = matches.slice(0, 25).map((p, index) => buildProductLine(p, index)).join('\n');
                        await sendTrackedMessage(jid, `*Matches for "${keyword}"*\n\n${result}${matches.length > 25 ? `\n\n...and ${matches.length - 25} more.` : ''}`);
                    } else if (normalizedText === 'cart') {
                        const cart = userCarts[jid];
                        if (!cart || cart.length === 0) {
                            await sendTrackedMessage(jid, '🛒 Your cart is empty.');
                            continue;
                        }
                        let total = 0;
                        const lines = cart.map((item, index) => {
                            total += item.total;
                            const parts = [`${index + 1}. ${item.name} (x${item.qty})`];
                            if (item.dimensions) parts.push(`[${item.dimensions}]`);
                            parts.push(`= ${formatCurrency(item.total)}`);
                            return parts.join(' ');
                        });
                        await sendTrackedMessage(jid, `*🛒 Cart*\n\n${lines.join('\n')}\n\n*Total:* ${formatCurrency(total)}\nType *checkout* to confirm.`);
                    } else if (normalizedText.startsWith('buy ')) {
                        const parts = text.trim().split(/\s+/);
                        const id = parts[1];
                        const qty = parseInt(parts[2], 10);
                        const product = products.find((p) => String(p.ID).toLowerCase() === String(id).toLowerCase());
                        if (!product) {
                            await sendTrackedMessage(jid, 'I can’t find that product ID right now. Tell me the product name you need and I’ll help you find the right option and price.');
                            continue;
                        }
                        if (!Number.isFinite(qty) || qty <= 0) {
                            await sendTrackedMessage(jid, 'Please share a valid quantity greater than zero (example: buy 101 2).');
                            continue;
                        }

                        let pricing;
                        let dimensionsLabel = '';
                        if (String(product.PriceType || '').toLowerCase() === 'sqm') {
                            const dimText = parts.slice(3).join(' ');
                            const dimensions = parseDimensionsFromText(dimText);
                            if (!dimensions) {
                                await sendTrackedMessage(
                                    jid,
                                    `This product is priced per square meter.\nUse: *buy ${product.ID} ${qty} 1200x600*`
                                );
                                continue;
                            }
                            pricing = calculateSqmPrice(product, qty, dimensions.widthMm, dimensions.heightMm);
                            dimensionsLabel = `${dimensions.widthMm}x${dimensions.heightMm}mm`;
                        } else {
                            pricing = calculateFixedPrice(product, qty);
                        }

                        const designFee = toNumber(product.DesignFee) * qty;
                        const polesCost = toNumber(product.PolePrice) * qty;
                        const installationFee = toNumber(product.InstallationFee) * qty;
                        const materialTotal = pricing.total;
                        const total = materialTotal + designFee + polesCost + installationFee;

                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push({
                            id: product.ID,
                            name: product.Name,
                            qty,
                            dimensions: dimensionsLabel,
                            materialTotal,
                            designFee,
                            polesCost,
                            installationFee,
                            total,
                            priceType: product.PriceType
                        });

                        const quoteLines = [
                            `✅ Added *${product.Name}* to cart.`,
                            `Quantity: ${qty}`,
                            dimensionsLabel ? `Size: ${dimensionsLabel}` : '',
                            `Material: ${formatCurrency(materialTotal)}`,
                            designFee > 0 ? `Design fee: ${formatCurrency(designFee)}` : '',
                            polesCost > 0 ? `Pole fee: ${formatCurrency(polesCost)}` : '',
                            installationFee > 0 ? `Installation fee: ${formatCurrency(installationFee)}` : '',
                            `*Item total: ${formatCurrency(total)}*`,
                            '',
                            'Reply *cart* to review or *checkout* to confirm pricing.'
                        ].filter(Boolean);
                        await sendTrackedMessage(jid, quoteLines.join('\n'));
                    } else if (normalizedText === 'checkout') {
                        const cart = userCarts[jid];
                        if (!cart || cart.length === 0) {
                            await sendTrackedMessage(jid, 'Cart empty.');
                            continue;
                        }
                        let total = 0;
                        let summary = '*📋 Order Summary:*\n\n';
                        cart.forEach((item, index) => {
                            total += item.total;
                            summary += `${index + 1}. *${item.name}*`;
                            if (item.dimensions) summary += ` (${item.dimensions})`;
                            summary += ` ×${item.qty}\n`;
                            summary += `   Material: ${formatCurrency(item.materialTotal)}\n`;
                            if (item.designFee > 0) summary += `   Design: ${formatCurrency(item.designFee)}\n`;
                            if (item.polesCost > 0) summary += `   Poles: ${formatCurrency(item.polesCost)}\n`;
                            if (item.installationFee > 0) summary += `   Installation: ${formatCurrency(item.installationFee)}\n`;
                            summary += `   *Item Total: ${formatCurrency(item.total)}*\n\n`;
                        });
                        summary += `*Grand Total: ${formatCurrency(total)}*\n\nReply with *confirm* to submit your order.`;
                        await sendTrackedMessage(jid, summary);
                    } else if (normalizedText === 'confirm') {
                        const cart = userCarts[jid];
                        if (!cart || cart.length === 0) {
                            await sendTrackedMessage(jid, 'You don’t have a pending quote yet. Tell me what product you need and I’ll prepare pricing for you.');
                            continue;
                        }
                        const total = cart.reduce((sum, item) => sum + toNumber(item.total), 0);
                        recordOrder(jid, cart, total);
                        delete userCarts[jid];
                        await sendTrackedMessage(jid, `✅ Order confirmed.\nTotal: *${formatCurrency(total)}*\nA team member will follow up shortly.`);
                    } else {
                        const csvPricingReply = buildCsvPricingReply(text, jid);
                        if (csvPricingReply) {
                            await sendTrackedMessage(jid, csvPricingReply);
                            rememberConversationReply(text, csvPricingReply);
                            continue;
                        }

                        const strictLearnedReply = generateLearnedReply(text, { minScore: 700 });
                        if (strictLearnedReply) {
                            await sendTrackedMessage(jid, strictLearnedReply);
                            rememberConversationReply(text, strictLearnedReply);
                            continue;
                        }

                        const openAIReply = await generateOpenAIReply(text, jid);
                        if (openAIReply) {
                            await sendTrackedMessage(jid, openAIReply);
                            rememberConversationReply(text, openAIReply);
                        } else {
                            const learnedReply = generateLearnedReply(normalizedText, { minScore: 1 });
                            if (learnedReply) {
                                await sendTrackedMessage(jid, learnedReply);
                                rememberConversationReply(text, learnedReply);
                                continue;
                            }
                            pushLearningLead(jid, text);
                            const fallbackReply = buildConversationalFallback(text, jid);
                            await sendTrackedMessage(jid, fallbackReply);
                            rememberConversationReply(text, fallbackReply);
                        }
                    }
                } catch (err) {
                    console.error('❌ Error handling incoming message (connection kept alive):', err);
                }
            }
        });
    } catch (err) {
        console.error('❌ Fatal error in startBot():', err);
        retryCount++;
        if (retryCount < MAX_RETRIES) {
            const delay = getRetryDelay(retryCount);
            const nextFingerprint = retryCount % BROWSER_FINGERPRINTS.length;
            setTimeout(() => startBot(nextFingerprint), delay);
        } else {
            console.error(`🛑 Max retries (${MAX_RETRIES}) reached after fatal error.`);
        }
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireApiToken(req, res, next) {
    const sensitivePath = req.path.startsWith('/admin') || req.path.startsWith('/ai') || req.path.startsWith('/meta');
    if (sensitivePath && !ADMIN_API_TOKEN) {
        return res.status(503).json({ error: 'ADMIN_API_TOKEN must be configured for admin, ai, and meta APIs.' });
    }
    if (!ADMIN_API_TOKEN) return next();
    const provided = req.get('x-admin-token') || String(req.query?.token || '').trim();
    if (provided !== ADMIN_API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized API request.' });
    }
    next();
}

app.use('/api', requireApiToken);
const readRateLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const writeRateLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

const upload = multer({
    limits: { fileSize: MAX_BACKUP_UPLOAD_BYTES },
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, BACKUPS_DIR),
        filename: (_req, file, cb) => {
            const baseName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
            cb(null, `${Date.now()}-${baseName}`);
        }
    })
});
const contactsImportUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 5 }
});
const productsCsvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 5 }
});

app.get('/', (_req, res) => res.send('Bot is running!'));
app.get('/dashboard', readRateLimiter, (_req, res) => res.redirect('/index.html'));

app.get('/qr', (_req, res) => {
    const providedHeaderToken = _req.get('x-admin-token');
    const providedQueryToken = String(_req.query?.token || '').trim();
    if (ADMIN_API_TOKEN && providedHeaderToken !== ADMIN_API_TOKEN && providedQueryToken !== ADMIN_API_TOKEN) {
        return res.status(401).send('Unauthorized');
    }
    if (!latestQR) {
        return res.status(404).send('No QR code available yet. The bot may already be connected, or it has not started yet.');
    }
    res.setHeader('Content-Type', 'image/png');
    res.send(latestQR);
});

app.get('/api/dashboard/state', readRateLimiter, (_req, res) => {
    res.json({
        status: botConnectionState,
        learned: getDashboardData(),
        openai: {
            enabled: Boolean(openaiClient),
            model: OPENAI_MODEL
        },
        admin: {
            paused: isBotPaused,
            pausedChats: Array.from(pausedChats),
            chatCount: chatLog.size,
            ordersCount: orders.length,
            leadsCount: learningLeads.length,
            contactsCount: Object.keys(contactNames).length
        }
    });
});

app.get('/api/admin/chats', readRateLimiter, (_req, res) => {
    res.json({
        conversations: getConversationSummaries(),
        paused: isBotPaused,
        pausedChats: Array.from(pausedChats)
    });
});

app.get('/api/admin/chats/:jid', readRateLimiter, (req, res) => {
    const jid = String(req.params.jid || '').trim();
    if (!jid) return res.status(400).json({ error: 'Missing jid.' });
    res.json({
        jid,
        phone: phoneFromJid(jid),
        name: contactNames[jid] || '',
        paused: pausedChats.has(jid),
        status: conversationStatusForJid(jid),
        messages: chatLog.get(jid) || [],
        orders: orders.filter((order) => order.jid === jid)
    });
});

app.post('/api/admin/conversations/:jid/move', writeRateLimiter, (req, res) => {
    const jid = String(req.params.jid || '').trim();
    const tab = String(req.body?.tab || '').trim().toLowerCase();
    const allowed = new Set(['main', 'quoted', 'in_progress', 'idle', 'closed', 'paused', 'paid']);
    if (!jid) return res.status(400).json({ error: 'Missing jid.' });
    if (!allowed.has(tab)) return res.status(400).json({ error: 'Invalid tab value.' });
    conversationTabOverrides[jid] = tab;
    saveJsonFile(CONVERSATION_TABS_FILE, conversationTabOverrides);
    res.json({ message: `Conversation moved to ${tab}.`, jid, tab });
});

app.get('/api/admin/orders', readRateLimiter, (_req, res) => {
    const sorted = [...orders].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ orders: sorted });
});

app.get('/api/admin/products/export', readRateLimiter, (_req, res) => {
    if (!fs.existsSync(CSV_FILE)) {
        fs.writeFileSync(CSV_FILE, 'ID,Category,Subcategory,Name,PriceType,FixedPrice,PricePerSqm,MinPrice,UnitsPerProduct\n1,General,General,Demo Item,fixed,10.00,0,0,1\n');
    }
    res.download(CSV_FILE, 'products.csv');
});

app.get('/api/admin/products', readRateLimiter, (_req, res) => {
    res.json({ products });
});

app.post('/api/admin/products/upload', writeRateLimiter, productsCsvUpload.single('file'), async (req, res) => {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Missing CSV file.' });
    const content = req.file.buffer.toString('utf8').replace(/\uFEFF/g, '').trim();
    if (!content) return res.status(400).json({ error: 'CSV file is empty.' });

    const headerCells = content
        .split(/\r?\n/)[0]
        .split(',')
        .map((cell) => normalizeCsvHeader(cell.trim().replace(/^"|"$/g, '')));
    const hasId = headerCells.includes(normalizeCsvHeader('ID'));
    const hasName = headerCells.includes(normalizeCsvHeader('Name')) || headerCells.includes(normalizeCsvHeader('Subcategory'));
    const hasPrice =
        headerCells.includes(normalizeCsvHeader('FixedPrice')) ||
        headerCells.includes(normalizeCsvHeader('PricePerSqm')) ||
        headerCells.includes(normalizeCsvHeader('Price'));
    if (!hasId || !hasName || !hasPrice) {
        return res.status(400).json({ error: 'CSV header must include ID plus Name/Subcategory and FixedPrice/PricePerSqm (or Price).' });
    }

    try {
        const parsedProducts = await parseProductsCsvStream(Readable.from([content]));
        fs.writeFileSync(CSV_FILE, content.endsWith('\n') ? content : `${content}\n`);
        products = parsedProducts;
        return res.json({ message: 'Products CSV uploaded successfully.', products: products.length });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Failed to import products CSV.' });
    }
});

app.get('/api/admin/leads', readRateLimiter, (_req, res) => {
    const sorted = [...learningLeads].sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    res.json({ leads: sorted });
});

app.get('/api/admin/contacts', readRateLimiter, (_req, res) => {
    const jidSet = new Set([
        ...Object.keys(contactNames),
        ...Array.from(chatLog.keys())
    ]);
    const contacts = Array.from(jidSet).map((jid) => ({
        jid,
        name: contactNames[jid] || '',
        phone: phoneFromJid(jid)
    })).sort((a, b) => a.jid.localeCompare(b.jid));
    res.json({ contacts });
});

app.post('/api/admin/contacts/:jid/rename', writeRateLimiter, (req, res) => {
    const jid = String(req.params.jid || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!jid || !name) return res.status(400).json({ error: 'jid and name are required.' });
    contactNames[jid] = name;
    saveJsonFile(CONTACTS_FILE, contactNames);
    res.json({ message: 'Contact renamed.', jid, name });
});

app.post('/api/admin/contacts', writeRateLimiter, (req, res) => {
    const name = String(req.body?.name || '').trim();
    const jid = normalizeToJid(req.body?.phone || req.body?.jid || '');
    if (!name || !jid) return res.status(400).json({ error: 'Valid name and phone/jid are required.' });
    contactNames[jid] = name;
    const digits = normalizeContactPhone(req.body?.phone || req.body?.jid || '');
    if (digits) contactPhones[jid] = digits;
    saveJsonFile(CONTACTS_FILE, contactNames);
    saveJsonFile(CONTACT_PHONES_FILE, contactPhones);
    res.json({ message: 'Contact saved.', jid, name });
});

app.post('/api/admin/contacts/import', writeRateLimiter, contactsImportUpload.single('file'), (req, res) => {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Missing contacts file.' });
    const parsed = parseContactsFromText(req.file.buffer.toString('utf8'));
    if (parsed.length === 0) return res.status(400).json({ error: 'No valid contacts found in file.' });
    for (const entry of parsed) {
        contactNames[entry.jid] = entry.name;
        if (entry.phone) contactPhones[entry.jid] = entry.phone;
    }
    saveJsonFile(CONTACTS_FILE, contactNames);
    saveJsonFile(CONTACT_PHONES_FILE, contactPhones);
    res.json({ message: 'Contacts imported.', imported: parsed.length });
});

app.delete('/api/admin/contacts/:jid', writeRateLimiter, (req, res) => {
    const jid = String(req.params.jid || '').trim();
    if (!jid) return res.status(400).json({ error: 'Missing jid.' });
    delete contactNames[jid];
    delete contactPhones[jid];
    saveJsonFile(CONTACTS_FILE, contactNames);
    saveJsonFile(CONTACT_PHONES_FILE, contactPhones);
    res.json({ message: 'Contact removed.', jid });
});

app.post('/api/admin/pause', writeRateLimiter, (_req, res) => {
    isBotPaused = true;
    res.json({ message: 'Bot paused globally.', paused: true });
});

app.post('/api/admin/resume', writeRateLimiter, (_req, res) => {
    isBotPaused = false;
    res.json({ message: 'Bot resumed globally.', paused: false });
});

app.post('/api/admin/whatsapp/logout', writeRateLimiter, (_req, res) => {
    try {
        if (botSocket) {
            try {
                botSocket.end?.(new Error('Admin requested logout'));
            } catch {
                botSocket.ws?.close?.();
            }
        }
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        botConnectionState = 'disconnected';
        botSocket = null;
        retryCount = 0;
        setTimeout(() => startBot(0), 1500);
        return res.json({ message: 'WhatsApp session cleared. New QR will be generated.' });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to logout WhatsApp session.' });
    }
});

app.post('/api/admin/chats/:jid/pause', writeRateLimiter, (req, res) => {
    const jid = String(req.params.jid || '').trim();
    if (!jid) return res.status(400).json({ error: 'Missing jid.' });
    pausedChats.add(jid);
    res.json({ message: `Chat ${jid} paused.`, jid, paused: true });
});

app.post('/api/admin/chats/:jid/resume', writeRateLimiter, (req, res) => {
    const jid = String(req.params.jid || '').trim();
    if (!jid) return res.status(400).json({ error: 'Missing jid.' });
    pausedChats.delete(jid);
    res.json({ message: `Chat ${jid} resumed.`, jid, paused: false });
});

app.post('/api/admin/send', writeRateLimiter, async (req, res) => {
    const jid = String(req.body?.jid || '').trim();
    const text = String(req.body?.text || '').trim();
    if (!jid || !text) return res.status(400).json({ error: 'jid and text are required.' });

    try {
        await sendTrackedMessage(jid, text, 'admin');
        return res.json({ message: 'Message sent.', jid });
    } catch (error) {
        return res.status(503).json({ error: 'Bot is not connected right now.' });
    }
});

app.post('/api/ai/upload-backup', writeRateLimiter, upload.single('backup'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Missing backup file.' });
    }

    const safePath = path.resolve(BACKUPS_DIR, req.file.filename);
    const backupDirPath = path.resolve(BACKUPS_DIR);
    if (!safePath.startsWith(`${backupDirPath}${path.sep}`)) {
        return res.status(400).json({ error: 'Invalid backup path.' });
    }

    try {
        const fileContent = fs.readFileSync(safePath);
        const trainerName = String(req.body?.trainerName || '').trim();
        const result = importBackup(req.file.originalname, fileContent, {
            trainerName,
            mimeType: req.file.mimetype
        });
        return res.json({
            message: result.note || 'Backup uploaded and imported for AI learning.',
            ...result
        });
    } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to import backup file.' });
    } finally {
        try {
            if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
        } catch {}
    }
});

app.post('/api/ai/teach', writeRateLimiter, (req, res) => {
    const instruction = String(req.body?.instruction || '').trim();
    const examples = Array.isArray(req.body?.examples) ? req.body.examples : [];

    if (!instruction) {
        return res.status(400).json({ error: 'Instruction is required.' });
    }

    const result = teachBehavior(instruction, examples);
    res.json({
        message: 'Teaching instructions saved.',
        ...result
    });
});

app.post('/api/ai/coach', writeRateLimiter, async (req, res) => {
    const message = String(req.body?.message || '').trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];

    if (!message) {
        return res.status(400).json({ error: 'message is required.' });
    }

    try {
        const reply = await generateAICoachReply(message, history);
        return res.json({
            message: 'AI coach response generated.',
            reply
        });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to generate AI coach response.' });
    }
});

app.get('/api/ai/openai-check', readRateLimiter, async (_req, res) => {
    const result = await runOpenAIConnectivityCheck();
    res.json(result);
});

app.post('/api/meta/connect-later', writeRateLimiter, (req, res) => {
    const metaConfig = setMetaConnectionIntent({
        enabled: true,
        businessAccountId: req.body?.businessAccountId,
        phoneNumberId: req.body?.phoneNumberId,
        notes: req.body?.notes || 'Planned legal Meta WhatsApp Business connection.'
    });

    res.json({
        message: 'Meta connection option saved for later legal setup.',
        metaConfig
    });
});

app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        const maxMb = Math.floor(MAX_BACKUP_UPLOAD_BYTES / (1024 * 1024));
        return res.status(400).json({ error: `Uploaded file too large (max ${maxMb}MB).` });
    }
    console.error('❌ API error:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
});

if (!IS_TEST_MODE) {
    app.listen(PORT, () => {
        console.log(`📡 Web server listening on port ${PORT}`);
        console.log('🔗 Dashboard available at /dashboard');
        if (!ADMIN_API_TOKEN) {
            console.warn('⚠️ ADMIN_API_TOKEN is not set. Admin/AI/Meta APIs are blocked until configured.');
        }
        startBot(0);
    });
}

module.exports = {
    loadProducts,
    parseDimensionsFromText,
    parseQuantityFromText,
    parseProductRequestDetails,
    buildProductContextForAI,
    buildCsvPricingReply,
    selectProductsByQuantityTier,
    pickBestQuantityTier,
    runOpenAIConnectivityCheck
};
