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
    buildOpenAISystemPrompt
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

const STORAGE_DIR = path.join(__dirname, 'storage');
const BACKUPS_DIR = path.join(STORAGE_DIR, 'backups');
const CSV_FILE = path.join(__dirname, 'products.csv');
const AUTH_DIR = path.join(STORAGE_DIR, 'auth_info');
const LEADS_FILE = path.join(STORAGE_DIR, 'learning_leads.json');
const ORDERS_FILE = path.join(STORAGE_DIR, 'orders.json');
const CONTACTS_FILE = path.join(STORAGE_DIR, 'contacts.json');
const CONTACT_PHONES_FILE = path.join(STORAGE_DIR, 'contact_phones.json');
const CONVERSATION_TABS_FILE = path.join(STORAGE_DIR, 'conversation_tabs.json');

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

function parseDimensionsFromText(text) {
    const values = String(text || '').match(/\d+(?:\.\d+)?/g);
    if (!values || values.length < 2) return null;
    const widthMm = parseFloat(values[0]);
    const heightMm = parseFloat(values[1]);
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

function buildProductContextForAI(userText = '') {
    const normalized = String(userText || '').toLowerCase();
    const ranked = products.map((product) => {
        const haystack = [
            product.ID,
            product.Name,
            product.Category,
            product.Subcategory,
            product.Aliases
        ].map((value) => String(value || '').toLowerCase()).join(' ');

        let score = 0;
        const tokens = normalized.split(/\s+/).filter(Boolean);
        for (const token of tokens) {
            if (token.length < 2) continue;
            if (haystack.includes(token)) score += 1;
        }
        return { product, score };
    });

    ranked.sort((a, b) => b.score - a.score);
    const top = ranked
        .filter((item) => item.score > 0)
        .slice(0, 12)
        .map((item) => item.product);

    const fallback = top.length ? top : products.slice(0, 12);
    if (!fallback.length) return 'No product catalog loaded.';

    return fallback.map((product) => {
        const name = product.Name || product.Subcategory || product.Category || 'Product';
        const pricing = String(product.PriceType || '').toLowerCase() === 'sqm'
            ? `${formatCurrency(product.PricePerSqm)}/m²${toNumber(product.MinPrice) > 0 ? ` (min ${formatCurrency(product.MinPrice)})` : ''}`
            : `${formatCurrency(product.FixedPrice)}${parseUnitsPerProduct(product.UnitsPerProduct) > 1 ? ` per ${parseUnitsPerProduct(product.UnitsPerProduct)} units` : ' per unit'}`;
        return `- ID ${product.ID}: ${name} | ${pricing}`;
    }).join('\n');
}

function buildConversationalFallback(userText = '') {
    const prompt = String(userText || '').toLowerCase();
    const shortlist = buildProductContextForAI(userText)
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

async function sendTrackedMessage(jid, text, role = 'bot') {
    if (!botSocket) throw new Error('WhatsApp socket not ready');
    await botSocket.sendMessage(jid, { text });
    logChatMessage(jid, role, text);
}

async function generateOpenAIReply(userText) {
    if (!openaiClient) return null;
    const trimmed = String(userText || '').trim();
    if (!trimmed) return null;

    try {
        const productContext = buildProductContextForAI(trimmed);
        const completion = await openaiClient.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
                {
                    role: 'system',
                    content: [
                        buildOpenAISystemPrompt(),
                        'You are a human-like WhatsApp receptionist and sales consultant.',
                        'Do not tell the customer to "type menu".',
                        'Use the product catalog below as the source of truth for products and pricing.',
                        'Ask clarifying questions naturally when details are missing.',
                        'When pricing is requested, reference relevant items and pricing from the catalog context.',
                        `Catalog context:\n${productContext}`
                    ].join('\n\n')
                },
                { role: 'user', content: trimmed.slice(0, 1000) }
            ],
            max_tokens: 320
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
                        const aiGreeting = await generateOpenAIReply(greetInput);
                        if (aiGreeting) {
                            await sendTrackedMessage(jid, aiGreeting);
                        } else {
                            await sendTrackedMessage(jid, buildConversationalFallback(greetInput));
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
                        const qty = parseInt(parts[2], 10) || 1;
                        const product = products.find((p) => String(p.ID).toLowerCase() === String(id).toLowerCase());
                        if (!product) {
                            await sendTrackedMessage(jid, 'I can’t find that product ID right now. Tell me the product name you need and I’ll help you find the right option and price.');
                            continue;
                        }
                        if (qty <= 0) {
                            await sendTrackedMessage(jid, 'Quantity must be greater than zero.');
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
                        const learnedReply = generateLearnedReply(normalizedText);
                        if (learnedReply) {
                            await sendTrackedMessage(jid, learnedReply);
                            continue;
                        }

                        const openAIReply = await generateOpenAIReply(text);
                        if (openAIReply) {
                            await sendTrackedMessage(jid, openAIReply);
                        } else {
                            pushLearningLead(jid, text);
                            await sendTrackedMessage(jid, buildConversationalFallback(text));
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
    limits: { fileSize: 1024 * 1024 * 5 },
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

    const fileContent = fs.readFileSync(safePath, 'utf8');
    const trainerName = String(req.body?.trainerName || '').trim();
    const result = importBackup(req.file.originalname, fileContent, { trainerName });
    res.json({
        message: 'Backup uploaded and imported for AI learning.',
        ...result
    });
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
        return res.status(400).json({ error: 'Uploaded file too large (max 5MB).' });
    }
    console.error('❌ API error:', err);
    return res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
    console.log(`📡 Web server listening on port ${PORT}`);
    console.log('🔗 Dashboard available at /dashboard');
    if (!ADMIN_API_TOKEN) {
        console.warn('⚠️ ADMIN_API_TOKEN is not set. Admin/AI/Meta APIs are blocked until configured.');
    }
    startBot(0);
});
