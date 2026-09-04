const baileys = require('@whiskeysockets/baileys');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = baileys;
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const pino = require('pino');
const nodemailer = require('nodemailer');
const qrcodeImg = require('qrcode');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const {
    importBackup,
    teachBehavior,
    logAIActivity,
    getDashboardData,
    setMetaConnectionIntent,
    generateLearnedReply,
    buildOpenAISystemPrompt,
    rememberConversationReply,
    learnFromChatMessages,
    applyImmediateCorrection
} = require('./lib/ai-learning');
const {
    parseProductsCsvStream,
    parseProductsCsvContent,
    validateProductCsvHeaders
} = require('./lib/csv-loader');
const { handleQuoteConversationMessage, isGreetingMessage } = require('./lib/quote-state-machine');

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
const OPENAI_MODEL_FALLBACKS = String(process.env.OPENAI_MODEL_FALLBACKS || 'gpt-4.1-mini,gpt-4.1-nano')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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
let activeOpenAIModel = OPENAI_MODEL;
let botSocket = null;
let isBotPaused = false;
const pausedChats = new Set();
const chatLog = new Map();
const chatLastActivity = new Map();
const conversationRouteMap = new Map();
const quoteConversationState = new Map();
const MAX_CHAT_MESSAGES = 500;
let learningLeads = [];
let orders = [];
let contactNames = {};
let contactPhones = {};
let conversationTabOverrides = {};

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

function isTruthyYes(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['yes', 'true', '1', 'y'].includes(normalized);
}

function formatCurrency(value) {
    return `R${toNumber(value).toFixed(2)}`;
}

function parseUnitsPerProduct(value) {
    const match = String(value || '').match(/\d+/);
    const parsed = match ? parseInt(match[0], 10) : 1;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getFixedPricingRule(product = {}) {
    const rawUnits = String(product.UnitsPerProduct || '').trim();
    const parsedUnits = parseUnitsPerProduct(rawUnits);
    const explicitMinQty = toNumber(product.MinOrderQty, 0);
    const hasGreaterThanRule = /^(?:>=|>)\s*\d+/.test(rawUnits);
    const unitPricingHint = /\bunit\b/i.test(String(product.UnitPricing || ''));
    const numericUnitPrice = toNumber(product.UnitPricing, 0) > 0;
    const pricingMode = hasGreaterThanRule || unitPricingHint || numericUnitPrice ? 'unit' : 'pack';
    const minQty = pricingMode === 'unit'
        ? (explicitMinQty > 0 ? explicitMinQty : parsedUnits)
        : 0;
    return {
        pricingMode,
        unitsPerPack: parsedUnits,
        minQty
    };
}

function resolveFixedCatalogPrice(product = {}) {
    const fixed = toNumber(product.FixedPrice);
    if (fixed > 0) return fixed;
    const unit = toNumber(product.UnitPricing);
    if (unit > 0) return unit;
    return 0;
}

function calculateFixedPrice(product, qty) {
    const pricingRule = getFixedPricingRule(product);
    const unitsPerPack = pricingRule.unitsPerPack;
    const packPrice = resolveFixedCatalogPrice(product);
    if (pricingRule.pricingMode === 'unit') {
        if (pricingRule.minQty > 0 && qty < pricingRule.minQty) {
            return { total: Number.NaN, unitsPerPack: 1, packs: 0, pricingMode: 'unit', minQty: pricingRule.minQty };
        }
        return { total: qty * packPrice, unitsPerPack: 1, packs: qty, pricingMode: 'unit', minQty: pricingRule.minQty };
    }
    const packs = Math.ceil(qty / unitsPerPack);
    return { total: packs * packPrice, unitsPerPack, packs, pricingMode: 'pack', minQty: 0 };
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
    const pricingRule = getFixedPricingRule(product);
    const fixedPrice = resolveFixedCatalogPrice(product);
    if (pricingRule.pricingMode === 'unit') {
        const minText = pricingRule.minQty > 0 ? ` (min qty ${pricingRule.minQty})` : '';
        return `${formatCurrency(fixedPrice)}/unit${minText}`;
    }
    const unitsPerPack = pricingRule.unitsPerPack;
    const unitText = unitsPerPack > 1 ? `/${unitsPerPack} units` : '/unit';
    return `${formatCurrency(fixedPrice)}${unitText}`;
}

function buildProductLine(product, index) {
    const name = product.Name || product.Subcategory || product.Category || `Product ${index + 1}`;
    return `${index + 1}. [${product.ID || '?'}] ${name} — ${getProductDisplayPrice(product)}`;
}

function isPricingIntentMessage(text = '') {
    return /\b(price|pricing|quote|cost|how much|unit price|sqm|square meter|m2)\b/i.test(text)
        || /\b(business cards?|flyers?|banners?|signs?|signage|stickers?|labels?|posters?|acm|printing?|corex|correx|boards?)\b/i.test(text);
}

function isPlaceholderPricingReply(text = '') {
    const normalized = String(text || '').toLowerCase();
    if (!normalized) return false;
    return /\$\s*x{1,4}\b/i.test(normalized)
        || /\$\s*xx\b/i.test(normalized)
        || /here are the prices?\s+for\b/i.test(normalized) && /\$/.test(normalized);
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

function logQuoteFlowDiagnostics(jid) {
    const state = quoteConversationState.get(jid);
    if (!state) return;
    const lockedFamily = String(state.lockedFamilyLabel || state.lockedFamilyKey || '').trim();
    const step = String(state.step || '').trim();
    const candidateCount = Array.isArray(state.candidates) ? state.candidates.length : 0;
    console.log(`🧭 QuoteFlow [${jid}] family="${lockedFamily}" step="${step}" candidates=${candidateCount}`);
}

function getPriorityTaughtReply(userText) {
    const match = generateLearnedReply(userText, { minScore: 260, includeMeta: true });
    if (!match) return null;
    if (match.source !== 'responseRules') return null;
    return match.reply;
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
    if (digits.length >= 10 && digits.length <= 12) return digits;
    return '';
}

function normalizeConversationJid(rawJid) {
    const value = String(rawJid || '').trim();
    if (!value) return '';
    if (!value.includes('@')) return normalizeToJid(value);
    const digits = extractPhoneDigitsFromJid(value);
    if (digits) return `${digits}@s.whatsapp.net`;
    const mapped = resolveCanonicalFromKnownRoute(value);
    if (mapped) return mapped;
    return value;
}

function resolveCanonicalFromKnownRoute(routeJid = '') {
    const route = String(routeJid || '').trim();
    if (!route) return '';
    for (const [conversationJid, routeJidValue] of conversationRouteMap.entries()) {
        if (String(routeJidValue || '').trim() !== route) continue;
        const digits = extractPhoneDigitsFromJid(conversationJid);
        if (digits) return `${digits}@s.whatsapp.net`;
    }
    return '';
}

function extractPhoneDigitsFromJid(jid) {
    const value = String(jid || '').trim();
    if (!value) return '';
    if (value.includes('@')) {
        const domain = String(value.split('@')[1] || '').toLowerCase();
        if (domain === 'lid') return '';
        if (domain !== 's.whatsapp.net' && domain !== 'c.us') return '';
    }
    const [localPart = ''] = value.split('@');
    const digitsPart = localPart.split(':')[0];
    return normalizeContactPhone(digitsPart);
}

function phoneFromJid(jid) {
    const canonicalJid = normalizeConversationJid(jid);
    const fromJid = extractPhoneDigitsFromJid(canonicalJid);
    const explicitRaw = contactPhones[canonicalJid] || contactPhones[String(jid || '').trim()];
    const explicit = normalizeContactPhone(explicitRaw);
    const digits = fromJid || explicit;
    return digits ? `+${digits}` : '';
}

function isDirectUserJid(jid) {
    if (typeof jid !== 'string' || !jid.includes('@')) return false;
    if (isIgnoredChatJid(jid)) return false;
    return true;
}

function isIgnoredChatJid(jid) {
    return typeof jid === 'string' && (
        jid === 'status@broadcast' ||
        jid.endsWith('@g.us') ||
        jid.endsWith('@newsletter')
    );
}

function isRouteEligibleJid(jid) {
    const value = String(jid || '').trim();
    if (!value) return false;
    if (isIgnoredChatJid(value)) return false;
    if (!value.includes('@')) return false;
    return true;
}

function resolveIncomingJid(key) {
    const primary = key?.remoteJid || '';
    const participant = key?.participant || '';
    if (isIgnoredChatJid(primary)) return primary;
    const normalizedPrimary = normalizeConversationJid(primary);
    const normalizedParticipant = normalizeConversationJid(participant);
    const primaryDigits = extractPhoneDigitsFromJid(normalizedPrimary);
    const participantDigits = extractPhoneDigitsFromJid(normalizedParticipant);
    if (primaryDigits) return `${primaryDigits}@s.whatsapp.net`;
    if (participantDigits) return `${participantDigits}@s.whatsapp.net`;
    const mappedPrimary = resolveCanonicalFromKnownRoute(normalizedPrimary);
    if (mappedPrimary) return mappedPrimary;
    const mappedParticipant = resolveCanonicalFromKnownRoute(normalizedParticipant);
    if (mappedParticipant) return mappedParticipant;
    if (isDirectUserJid(normalizedPrimary)) return normalizedPrimary;
    if (isDirectUserJid(normalizedParticipant)) return normalizedParticipant;
    return normalizeConversationJid(primary || participant || '');
}

function rememberConversationRoute(conversationJid, ...routeCandidates) {
    const normalizedConversationJid = normalizeConversationJid(conversationJid);
    if (!normalizedConversationJid) return;
    for (const candidate of routeCandidates) {
        const route = String(candidate || '').trim();
        if (!isRouteEligibleJid(route)) continue;
        conversationRouteMap.set(normalizedConversationJid, route);
        return;
    }
}

function resolveOutboundJid(conversationJid) {
    const normalizedConversationJid = normalizeConversationJid(conversationJid);
    if (!normalizedConversationJid) return '';
    return conversationRouteMap.get(normalizedConversationJid) || normalizedConversationJid;
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

function getConversationMessagesByJid(jid) {
    const direct = chatLog.get(jid);
    if (Array.isArray(direct)) return direct;
    for (const [key, value] of chatLog.entries()) {
        if (normalizeConversationJid(key) === jid && Array.isArray(value)) return value;
    }
    return [];
}

function getConversationLastActivityByJid(jid) {
    const direct = chatLastActivity.get(jid);
    if (direct) return direct;
    for (const [key, value] of chatLastActivity.entries()) {
        if (normalizeConversationJid(key) === jid && value) return value;
    }
    return null;
}

function getContactNameByJid(jid) {
    if (contactNames[jid]) return contactNames[jid];
    const targetDigits = extractPhoneDigitsFromJid(jid);
    if (!targetDigits) return '';
    for (const [key, name] of Object.entries(contactNames)) {
        if (!name) continue;
        if (extractPhoneDigitsFromJid(key) === targetDigits) return name;
    }
    return '';
}

function getConversationSummaries() {
    const summaries = [];
    const sourceJids = [
        ...Array.from(chatLog.keys()),
        ...Array.from(chatLastActivity.keys()),
        ...Object.keys(contactNames),
        ...orders.map((order) => order.jid),
        ...learningLeads.map((lead) => lead.jid)
    ];
    const allJids = new Set();
    for (const source of sourceJids) {
        const normalized = normalizeConversationJid(source);
        if (!normalized) continue;
        if (isIgnoredChatJid(normalized)) continue;
        if (!isDirectUserJid(normalized)) continue;
        allJids.add(normalized);
    }

    for (const jid of allJids) {
        const messages = getConversationMessagesByJid(jid);
        const last = messages[messages.length - 1];
        summaries.push({
            jid,
            phone: phoneFromJid(jid),
            name: getContactNameByJid(jid),
            lastMessage: last?.text || '',
            lastRole: last?.role || '',
            lastTimestamp: last?.timestamp || getConversationLastActivityByJid(jid) || null,
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
    return String(value || '')
        .toLowerCase()
        .replace(/\bcorrex\b/g, 'corex')
        .replace(/[^a-z0-9\sx]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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

function parseArtworkStatusFromText(text = '') {
    const normalized = normalizeTextForMatch(text);
    if (!normalized) return null;
    if (/\b(no|not|dont|don't|no artwork|not ready|need design|not print ready)\b/i.test(normalized)) return false;
    if (/\b(yes|have artwork|print ready|artwork ready|ready artwork)\b/i.test(normalized)) return true;
    return null;
}

function parseProductRequestDetails(text = '') {
    const normalized = normalizeTextForMatch(text);
    const dimensions = parseDimensionsFromText(normalized);
    const quantity = parseQuantityFromText(normalized, dimensions);
    const hasArtwork = parseArtworkStatusFromText(normalized);

    let side = '';
    if (normalized.includes('double sided') || normalized.includes('double-sided') || normalized.includes('both sided') || normalized.includes('both-sided') || normalized.includes('2 sided') || normalized.includes('2-sided')) side = 'double';
    if (normalized.includes('single sided') || normalized.includes('single-sided') || normalized.includes('one sided') || normalized.includes('one-sided') || normalized.includes('1 sided') || normalized.includes('1-sided')) side = 'single';
    const requestedPoles = /\b(with pole|with poles|need poles|pole included|include poles)\b/.test(normalized)
        ? true
        : (/\b(no pole|no poles|without pole|without poles)\b/.test(normalized) ? false : null);
    const requestedInstallation = /\b(with install|with installation|need install|need installation|include installation)\b/.test(normalized)
        ? true
        : (/\b(no install|no installation|without install|without installation)\b/.test(normalized) ? false : null);

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

    return { normalized, tokens, quantity, side, sizeToken, finish, dimensions, hasArtwork, requestedPoles, requestedInstallation };
}

function scoreProductVariant(product, request) {
    const normalizedName = normalizeTextForMatch([
        product.Aliases,
        product.Name,
        product.Category,
        product.Subcategory,
        product.SubSubcategory,
        product.SubSubSubcategory,
        product.SKU
    ].join(' '));
    const normalizedFinish = normalizeTextForMatch(product.Finish);
    const normalizedSide = normalizeTextForMatch(product.SingleOrDoubleSided);
    const normalizedSize = normalizeTextForMatch(product.Size);
    const units = parseUnitsPerProduct(product.UnitsPerProduct);

    let score = 0;
    for (const token of request.tokens) {
        if (normalizedName.includes(token)) score += 3;
        if (normalizeTextForMatch(product.Name).includes(token)) score += 2;
    }
    if (request.tokens.includes('corex')) {
        score += normalizedName.includes('corex') ? 16 : -8;
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
    const currentFocus = inferCatalogFocusFromText(currentText);
    if (currentFocus) return currentFocus;
    if (!jid) return null;
    const recentUserText = (chatLog.get(jid) || [])
        .filter((entry) => entry?.role === 'user' && entry?.text)
        .slice(-4)
        .map((entry) => String(entry.text || '').trim())
        .filter(Boolean);
    for (let index = recentUserText.length - 1; index >= 0; index -= 1) {
        const focus = inferCatalogFocusFromText(recentUserText[index]);
        if (focus) return focus;
    }
    return null;
}

function productSearchBlob(product) {
    return normalizeTextForMatch([
        product.Aliases,
        product.Name,
        product.Category,
        product.Subcategory,
        product.SubSubcategory,
        product.SubSubSubcategory,
        product.SKU,
        product.Size,
        product.Finish,
        product.SingleOrDoubleSided,
        product.UnitsPerProduct
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
            : `${formatCurrency(resolveFixedCatalogPrice(product))} per ${parseUnitsPerProduct(product.UnitsPerProduct) > 1 ? `${parseUnitsPerProduct(product.UnitsPerProduct)} units` : 'unit'}`;
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

function getQuantityOptionsFromProducts(candidates = [], limit = 6) {
    const fixed = (Array.isArray(candidates) ? candidates : [])
        .filter((item) => String(item.PriceType || '').toLowerCase() === 'fixed')
        .map((item) => String(item.UnitsPerProduct || '').trim())
        .filter(Boolean);
    const numeric = [...new Set(fixed
        .map((value) => parseInt((value.match(/\d+/) || [])[0], 10))
        .filter((value) => Number.isFinite(value) && value > 0))]
        .sort((a, b) => a - b)
        .slice(0, limit);
    return numeric;
}

function buildQuoteForMatchedProduct(product, request, options = {}) {
    if (!product) return null;
    const qty = request.quantity;
    const isSqm = String(product.PriceType || '').toLowerCase() === 'sqm';
    const name = product.Name || product.Subcategory || 'Product';

    if (!qty) {
        return `Great choice on *${name}*. What quantity would you like me to quote?`;
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
        if (!Number.isFinite(pricing.total)) {
            return `For *${name}*, the minimum order quantity is ${pricing.minQty}. What quantity should I use for your quote?`;
        }
        materialTotal = pricing.total;
    }

    const designFeeFlat = toNumber(product.DesignFee);
    const requiresArtwork = isTruthyYes(product.RequiresArtwork);
    if (requiresArtwork && designFeeFlat > 0 && request.hasArtwork === null) {
        return `Before I finalize pricing for *${name}*, do you already have print-ready artwork? If not, I’ll add a design fee of ${formatCurrency(designFeeFlat)}.`;
    }
    const designFee = (requiresArtwork && request.hasArtwork === false) ? designFeeFlat : 0;
    const polesAvailable = isTruthyYes(product.PolesAvailable) || toNumber(product.PolePrice) > 0;
    const polesCost = request.requestedPoles === true && polesAvailable ? (toNumber(product.PolePrice) * qty) : 0;
    const installationFee = request.requestedInstallation === true ? (toNumber(product.InstallationFee) * qty) : 0;
    const total = materialTotal + designFee + polesCost + installationFee;
    const details = [product.Size, product.Finish, product.SingleOrDoubleSided].filter(Boolean).join(' • ');

    return [
        `Based on your details, the closest match is *${name}*${details ? ` (${details})` : ''}.`,
        options.closestSizeNote || '',
        request.hasArtwork === true ? '• Artwork: Print-ready supplied' : '',
        request.hasArtwork === false ? '• Artwork: Design required' : '',
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
    const pricingIntent = isPricingIntentMessage(text);
    if (!pricingIntent) return null;

    const request = parseProductRequestDetails(text);
    const ranked = rankProductsForText(text).filter((item) => item.score > 0);
    if (!ranked.length) {
        const suggestions = findCatalogSuggestions(request, 4);
        return [
            'I can only quote using prices from our products catalog.',
            'To make sure I quote correctly, please confirm the product type and size you need.',
            suggestions.length ? `Closest catalog matches right now:\n${buildCatalogSuggestionLines(suggestions, 4)}` : ''
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
        return 'To quote correctly, should this be *single-sided* or *double-sided*?';
    }

    const sizeOptions = [...new Set(candidatePool.map((item) => String(item.Size || '').trim()).filter((value) => value && !/^custom$/i.test(value)))];
    if (!request.sizeToken && !request.dimensions && sizeOptions.length > 1) {
        const preview = sizeOptions.slice(0, 3).join(', ');
        return `What size do you need for this job? For example: ${preview}.`;
    }

    const finishOptions = [...new Set(candidatePool.map((item) => normalizeTextForMatch(item.Finish)).filter(Boolean))];
    if (!request.finish && finishOptions.length > 1) {
        const preview = finishOptions.slice(0, 4).join(', ');
        return `Which finish would you like: ${preview}?`;
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
        const qtyOptions = getQuantityOptionsFromProducts(filtered);
        const optionsLine = qtyOptions.length ? ` Available options: ${qtyOptions.join(', ')}.` : '';
        return `Thanks — for *${name}*, what quantity should I quote?${optionsLine}`;
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
            + ((isTruthyYes(product.RequiresArtwork) && request.hasArtwork === false) ? toNumber(product.DesignFee) : 0)
            + (toNumber(product.PolePrice) * request.quantity)
            + (toNumber(product.InstallationFee) * request.quantity);
        return { product, total, sizeDistance };
    }).filter((item) => Number.isFinite(item.total));

    if (!pricedCandidates.length) {
        const minimumQtyRows = filtered
            .filter((item) => String(item.PriceType || '').toLowerCase() === 'fixed')
            .map((item) => {
                const rule = getFixedPricingRule(item);
                return { product: item, rule };
            })
            .filter((entry) => entry.rule.pricingMode === 'unit' && entry.rule.minQty > request.quantity)
            .sort((a, b) => a.rule.minQty - b.rule.minQty);
        if (minimumQtyRows.length > 0) {
            const minQty = minimumQtyRows[0].rule.minQty;
            return `For this product range, the minimum order is ${minQty}. Please confirm your quantity and I’ll quote straight away.`;
        }
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

function buildGreetingReply(userText = '') {
    const strictLearnedReply = generateLearnedReply(userText, { minScore: 450, includeMeta: true });
    if (strictLearnedReply && strictLearnedReply.source === 'responseRules') {
        return strictLearnedReply.reply;
    }
    return 'Hi 👋 Thank you for your message. Is there anything we can help with today?';
}

async function sendTrackedMessage(jid, text, role = 'bot') {
    if (!botSocket) throw new Error('WhatsApp socket not ready');
    const conversationJid = normalizeConversationJid(jid);
    const outboundJid = resolveOutboundJid(conversationJid);
    let sent = false;
    let lastError = null;
    for (const candidate of [outboundJid, conversationJid]) {
        const target = String(candidate || '').trim();
        if (!target) continue;
        if (sent && target === outboundJid) continue;
        try {
            await botSocket.sendMessage(target, { text });
            sent = true;
            rememberConversationRoute(conversationJid, target);
            break;
        } catch (error) {
            lastError = error;
        }
    }
    if (!sent && lastError) throw lastError;
    logChatMessage(conversationJid || jid, role, text);
}

function trimTextForOpenAI(value, maxLength = 4000) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function withTimeout(promise, timeoutMs, timeoutMessage = 'Operation timed out') {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs))
    ]);
}

function getOpenAIModelCandidates() {
    return [...new Set([activeOpenAIModel, OPENAI_MODEL, ...OPENAI_MODEL_FALLBACKS].filter(Boolean))];
}

function parseJsonFromOpenAIText(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {}
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const candidate = raw.slice(start, end + 1);
        try {
            return JSON.parse(candidate);
        } catch {}
    }
    return null;
}

async function extractQuoteRequestWithOpenAI(userText, jid = '') {
    if (!openaiClient) return null;
    const trimmed = String(userText || '').trim();
    if (!trimmed) return null;
    const quoteLike = /\b(quote|price|pricing|cost|print|sign|signage|banner|card|cards|flyer|sticker|label|poster)\b/i.test(trimmed);
    if (!quoteLike && !quoteConversationState.has(jid)) return null;

    const productContext = trimTextForOpenAI(buildProductContextForAI(trimmed, jid), 2200);
    const messages = [
        {
            role: 'system',
            content: [
                'Extract quoting details from the customer message for a deterministic CSV pricing engine.',
                'Return JSON only. No markdown. No explanation.',
                'Never provide or calculate pricing.',
                'Use null when unknown.',
                'Schema keys:',
                '{"intent":"request_quote|other","confidence":0.0,"product_query":"","category":"","subcategory":"","subSubcategory":"","subSubSubcategory":"","size":"","finish":"","sided_option":"","quantity":null,"has_artwork":null,"dimensions":{"width":null,"height":null,"unit":null},"requested_poles":null,"requested_installation":null,"needs_clarification":false,"clarification_question":null}',
                `Catalog context:\n${productContext}`
            ].join('\n')
        },
        { role: 'user', content: trimTextForOpenAI(trimmed, 700) }
    ];

    for (const model of getOpenAIModelCandidates()) {
        try {
            const completion = await openaiClient.chat.completions.create({
                model,
                messages,
                max_tokens: 260,
                temperature: 0
            });
            const reply = String(completion.choices?.[0]?.message?.content || '').trim();
            const parsed = parseJsonFromOpenAIText(reply);
            if (!parsed || typeof parsed !== 'object') continue;
            const intent = String(parsed.intent || '').toLowerCase();
            if (intent && intent !== 'request_quote') return null;
            return parsed;
        } catch {}
    }
    return null;
}

async function generateOpenAIReply(userText, jid = '') {
    if (!openaiClient) return null;
    const trimmed = String(userText || '').trim();
    if (!trimmed) return null;

    try {
        const productContext = trimTextForOpenAI(buildProductContextForAI(trimmed, jid), 3200);
        const activeFocus = inferActiveCatalogFocus(jid, trimmed);
        const focusInstruction = activeFocus
            ? `Current customer product focus: ${activeFocus.subcategory || activeFocus.category || activeFocus.productName}. Stay on this product family unless the customer explicitly asks to switch products.`
            : 'Keep product suggestions tightly aligned to the customer’s current product request.';
        const conversationContext = buildConversationContextForAI(jid, trimmed).map((entry) => ({
            role: entry.role === 'user' ? 'user' : 'assistant',
            content: trimTextForOpenAI(entry.content, 500)
        }));
        const previousAssistantReply = conversationContext
            .slice()
            .reverse()
            .find((item) => item.role === 'assistant')?.content || '';
        const baseMessages = [
            {
                role: 'system',
                content: trimTextForOpenAI([
                    buildOpenAISystemPrompt(),
                    'You are a human-like WhatsApp receptionist and sales consultant.',
                    'Do not tell the customer to "type menu" or use command-style instructions unless specifically asked.',
                    'Use the product catalog below only for product context and naming consistency.',
                    'Do not calculate, estimate, or infer pricing in this step; pricing is handled by deterministic quote services.',
                    'Find likely products for the customer proactively based on their message.',
                    'When relevant, recommend up to 3 best-fit products by name without giving a calculated price.',
                    'Do not ask the customer to choose by product ID.',
                    'Keep the conversation going naturally with one helpful follow-up question.',
                    'If details are missing, ask only the most important next question (quantity, size, finish, or deadline).',
                    'Answer the customer’s latest message directly and do not give unrelated generic replies.',
                    'Do not repeat the exact same response used in the previous assistant message.',
                    previousAssistantReply ? `Previous assistant message to avoid repeating:\n${previousAssistantReply}` : '',
                    'Never invent pricing or product options.',
                    focusInstruction,
                    `Catalog context:\n${productContext}`
                ].join('\n\n'), 5200)
            },
            ...conversationContext,
            { role: 'user', content: trimTextForOpenAI(trimmed, 700) }
        ];

        let lastError = '';
        for (const model of getOpenAIModelCandidates()) {
            try {
                const completion = await openaiClient.chat.completions.create({
                    model,
                    messages: baseMessages,
                    max_tokens: 360,
                    temperature: 0.2
                });
                const reply = completion.choices?.[0]?.message?.content
                    ? String(completion.choices[0].message.content).trim()
                    : '';
                if (reply) {
                    activeOpenAIModel = model;
                    return reply;
                }
            } catch (error) {
                lastError = error?.message || String(error);
            }
        }
        console.error('❌ OpenAI response failed:', lastError || 'No response returned from configured models.');
        return null;
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
    let lastError = '';
    for (const model of getOpenAIModelCandidates()) {
        try {
            const completion = await openaiClient.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: 'Reply with exactly: OPENAI_OK' },
                    { role: 'user', content: 'Health check' }
                ],
                max_tokens: 12,
                temperature: 0
            });
            const reply = String(completion.choices?.[0]?.message?.content || '').trim();
            const responding = reply.includes('OPENAI_OK');
            if (responding) activeOpenAIModel = model;
            return {
                enabled: true,
                responding,
                model,
                latencyMs: Date.now() - started,
                reply
            };
        } catch (error) {
            lastError = error?.message || String(error);
        }
    }
    return {
        enabled: true,
        responding: false,
        model: activeOpenAIModel || OPENAI_MODEL,
        latencyMs: Date.now() - started,
        error: lastError || 'OpenAI request failed.'
    };
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

async function rewriteCorrectionWithOpenAI(question, correctedReply) {
    const cleanQuestion = String(question || '').trim();
    const cleanReply = String(correctedReply || '').trim();
    if (!openaiClient || !cleanQuestion || !cleanReply) return cleanReply;
    try {
        const completion = await withTimeout(openaiClient.chat.completions.create({
            model: activeOpenAIModel || OPENAI_MODEL,
            messages: [
                {
                    role: 'system',
                    content: 'Rewrite the assistant reply to be friendly, concise, and human sales-style. Keep exact meaning and business intent. Return only the rewritten reply.'
                },
                {
                    role: 'user',
                    content: `Customer question:\n${trimTextForOpenAI(cleanQuestion, 600)}\n\nCorrect response to preserve:\n${trimTextForOpenAI(cleanReply, 800)}`
                }
            ],
            max_tokens: 220,
            temperature: 0.2
        }), 8000, 'OpenAI rewrite timeout');
        const rewritten = String(completion.choices?.[0]?.message?.content || '').trim();
        return rewritten || cleanReply;
    } catch (error) {
        console.warn('⚠️ New AI Learning rewrite fallback:', error?.message || error);
        return cleanReply;
    }
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
                    rememberConversationRoute(jid, msg.key?.remoteJid, msg.key?.participant, jid);

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

                    if (isGreetingMessage(normalizedText)) {
                        quoteConversationState.delete(jid);
                        const greetingReply = buildGreetingReply(text);
                        await sendTrackedMessage(jid, greetingReply);
                        rememberConversationReply('customer greeting', greetingReply);
                    } else if (normalizedText.startsWith('products ')) {
                        quoteConversationState.delete(jid);
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
                        quoteConversationState.delete(jid);
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
                        quoteConversationState.delete(jid);
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
                        quoteConversationState.delete(jid);
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
                        quoteConversationState.delete(jid);
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
                        if (isPricingIntentMessage(text)) {
                            const csvPricingReply = buildCsvPricingReply(text, jid);
                            if (csvPricingReply) {
                                quoteConversationState.delete(jid);
                                await sendTrackedMessage(jid, csvPricingReply);
                                rememberConversationReply(text, csvPricingReply);
                                continue;
                            }
                        }

                        const strictLearnedReply = getPriorityTaughtReply(text);
                        if (strictLearnedReply) {
                            quoteConversationState.delete(jid);
                            await sendTrackedMessage(jid, strictLearnedReply);
                            rememberConversationReply(text, strictLearnedReply);
                            continue;
                        }

                        const extractedQuoteRequest = await extractQuoteRequestWithOpenAI(text, jid);
                        const quoteFlow = handleQuoteConversationMessage({
                            jid,
                            text,
                            products,
                            stateStore: quoteConversationState,
                            requestDetails: extractedQuoteRequest
                        });
                        logQuoteFlowDiagnostics(jid);
                        if (quoteFlow.handled && quoteFlow.reply) {
                            await sendTrackedMessage(jid, quoteFlow.reply);
                            continue;
                        }

                        const openAIReply = await generateOpenAIReply(text, jid);
                        if (openAIReply) {
                            if (isPlaceholderPricingReply(openAIReply)) {
                                const csvFallback = buildCsvPricingReply(text, jid)
                                    || 'I can only quote from our products CSV. Please share product, size, and quantity so I can give exact pricing.';
                                await sendTrackedMessage(jid, csvFallback);
                                rememberConversationReply(text, csvFallback);
                                continue;
                            }
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
    const jid = normalizeConversationJid(req.params.jid || '');
    if (!jid) return res.status(400).json({ error: 'Missing jid.' });
    res.json({
        jid,
        phone: phoneFromJid(jid),
        name: getContactNameByJid(jid),
        paused: pausedChats.has(jid),
        status: conversationStatusForJid(jid),
        messages: getConversationMessagesByJid(jid),
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

    const headerValidation = validateProductCsvHeaders(content);
    if (!headerValidation.ok) {
        return res.status(400).json({ error: 'CSV header must include ID plus Name/Subcategory and FixedPrice/PricePerSqm (or Price).' });
    }

    try {
        const parsedProducts = await parseProductsCsvContent(content);
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
    const trigger = String(req.body?.trigger || '').trim();
    const reply = String(req.body?.reply || '').trim();
    const source = String(req.body?.source || 'manual').trim() || 'manual';
    const mergedExamples = [...examples];
    if (trigger && reply) mergedExamples.push({ when: trigger, reply });

    if (!instruction && !mergedExamples.length) {
        return res.status(400).json({ error: 'Instruction or trigger/reply is required.' });
    }

    const result = teachBehavior(instruction || `${trigger} => ${reply}`, mergedExamples, { source });
    res.json({
        message: 'Teaching instructions saved.',
        ...result
    });
});

app.post('/api/ai/new-learning', writeRateLimiter, async (req, res) => {
    try {
        const question = String(req.body?.question || req.body?.wrongQuestion || '').trim();
        const correctedReply = String(req.body?.correctedReply || req.body?.reply || '').trim();
        const improveWithOpenAI = Boolean(req.body?.improveWithOpenAI);
        if (!question || !correctedReply) {
            return res.status(400).json({ error: 'question and correctedReply are required.' });
        }
        const finalReply = improveWithOpenAI
            ? await rewriteCorrectionWithOpenAI(question, correctedReply)
            : correctedReply;
        const result = applyImmediateCorrection(question, finalReply, { source: 'new_ai_learning' });
        const preview = generateLearnedReply(question, { minScore: 1, includeMeta: true });
        return res.json({
            message: 'New AI Learning rule saved and active immediately.',
            ...result,
            preview: preview?.reply || finalReply
        });
    } catch (error) {
        console.error('❌ Failed to save new AI learning rule:', error?.message || error);
        return res.status(500).json({ error: 'Failed to save new AI learning rule.' });
    }
});

app.post('/api/ai/new-openai-learning/instruction', writeRateLimiter, (req, res) => {
    const instruction = String(req.body?.instruction || '').trim();
    if (!instruction) {
        return res.status(400).json({ error: 'instruction is required.' });
    }
    const result = teachBehavior(instruction, [], { source: 'new_openai_learning' });
    return res.json({
        message: 'New OpenAI learning instruction saved and active immediately.',
        ...result
    });
});

app.post('/api/ai/learn-from-chat', writeRateLimiter, (req, res) => {
    const jid = String(req.body?.jid || '').trim();
    const source = String(req.body?.source || 'selected_chat').trim() || 'selected_chat';
    const maxPairs = Math.min(200, Math.max(5, Number(req.body?.maxPairs || 80)));
    if (!jid) return res.status(400).json({ error: 'jid is required.' });
    const messages = chatLog.get(jid) || [];
    if (messages.length < 2) {
        return res.status(400).json({ error: 'Not enough chat messages to learn from this conversation.' });
    }

    const result = learnFromChatMessages(messages, { source, maxPairs });
    res.json({
        message: result.importedRules > 0
            ? `Learning saved from ${jid}.`
            : 'No usable user→assistant reply pairs were found in this chat.',
        jid,
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
        logAIActivity('coach_interaction', {
            promptLength: message.length,
            historyCount: history.length,
            replyLength: String(reply || '').length
        });
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
    phoneFromJid,
    resolveIncomingJid,
    resolveOutboundJid,
    rememberConversationRoute,
    isDirectUserJid,
    getConversationSummaries,
    buildGreetingReply,
    buildProductContextForAI,
    buildCsvPricingReply,
    rewriteCorrectionWithOpenAI,
    selectProductsByQuantityTier,
    pickBestQuantityTier,
    runOpenAIConnectivityCheck
};
