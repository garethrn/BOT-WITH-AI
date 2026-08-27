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

learningLeads = loadJsonFile(LEADS_FILE, []);
orders = loadJsonFile(ORDERS_FILE, []);
contactNames = loadJsonFile(CONTACTS_FILE, {});
conversationTabOverrides = loadJsonFile(CONVERSATION_TABS_FILE, {});

function getRetryDelay(count) {
    const safeCount = Math.max(1, Number(count) || 1);
    return Math.min(5000 * Math.pow(2, safeCount - 1), 60000);
}

function loadProducts() {
    return new Promise((resolve, reject) => {
        const results = [];
        if (!fs.existsSync(CSV_FILE)) {
            fs.writeFileSync(CSV_FILE, 'ID,Name,Price\n1,Demo Item,10.00');
        }
        fs.createReadStream(CSV_FILE)
            .pipe(csv())
            .on('data', (d) => results.push(d))
            .on('end', () => {
                products = results;
                console.log('✅ Inventory Loaded');
                resolve(results);
            })
            .on('error', reject);
    });
}
loadProducts().catch((error) => {
    console.error('❌ Failed to load products:', error);
});

function logChatMessage(jid, role, text) {
    const cleanJid = String(jid || '').trim();
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleanJid || !cleanText) return;

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
            id: item.ID,
            name: item.Name,
            qty: item.qty,
            price: item.Price
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
    const digits = input.replace(/[^\d]/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
}

function parseContactsFromText(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
        const clean = line.replace(/\uFEFF/g, '');
        const parts = clean.includes(',') ? clean.split(',') : clean.split('|');
        if (parts.length >= 2) {
            const name = parts[0].trim();
            const phone = parts.slice(1).join(' ').trim();
            const jid = normalizeToJid(phone);
            if (name && jid) results.push({ jid, name });
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
            const jid = normalizeToJid(vcfPhone[1].trim());
            if (last && last.pendingName && jid) {
                last.jid = jid;
                last.name = last.pendingName;
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
        const completion = await openaiClient.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
                { role: 'system', content: buildOpenAISystemPrompt() },
                { role: 'user', content: trimmed.slice(0, 1000) }
            ],
            max_tokens: 250
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

        sock.ev.on('messages.upsert', async ({ messages }) => {
            try {
                if (!Array.isArray(messages) || messages.length === 0) return;
                const msg = messages[0];
                if (!msg || !msg.message || !msg.key || msg.key.fromMe) return;

                const jid = msg.key.remoteJid;
                if (!jid) return;

                const text = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    ''
                ).trim();
                const normalizedText = text.toLowerCase();
                logChatMessage(jid, 'user', text || '[non-text message]');

                if (jid === ADMIN_JID && msg.message.documentMessage) {
                    try {
                        const doc = msg.message.documentMessage;
                        if (doc?.fileName && doc.fileName.endsWith('.csv')) {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            fs.writeFileSync(CSV_FILE, buffer);
                            loadProducts();
                            await sendTrackedMessage(jid, '📦 Products updated!');
                            return;
                        }
                    } catch (docErr) {
                        console.error('❌ Failed to process incoming document message:', docErr);
                    }
                }

                if (isBotPaused || pausedChats.has(jid)) {
                    pushLearningLead(jid, text);
                    return;
                }

                if (normalizedText === 'hello' || normalizedText === 'menu') {
                    let menu = '*Our Catalog:*\n\n';
                    products.forEach((p) => {
                        menu += `*ID ${p.ID}*: ${p.Name} - ${p.Price}\n`;
                    });
                    await sendTrackedMessage(jid, menu);
                } else if (normalizedText.startsWith('buy ')) {
                    const parts = normalizedText.split(' ');
                    const id = parts[1];
                    const qty = parseInt(parts[2], 10) || 1;
                    const product = products.find((p) => p.ID === id);
                    if (product) {
                        if (!userCarts[jid]) userCarts[jid] = [];
                        userCarts[jid].push({ ...product, qty });
                        await sendTrackedMessage(jid, `✅ Added ${qty} x ${product.Name}.`);
                    }
                } else if (normalizedText === 'checkout') {
                    const cart = userCarts[jid];
                    if (!cart || cart.length === 0) {
                        await sendTrackedMessage(jid, 'Cart empty.');
                        return;
                    }
                    let total = 0;
                    let summary = '*Order Review:*\n';
                    cart.forEach((i) => {
                        const sub = parseFloat(i.Price) * i.qty;
                        total += sub;
                        summary += `- ${i.Name} (x${i.qty}): ${sub.toFixed(2)}\n`;
                    });
                    summary += `\n*Total: ${total.toFixed(2)}*`;
                    await sendTrackedMessage(jid, summary);
                    recordOrder(jid, cart, total);
                    delete userCarts[jid];
                } else {
                    const learnedReply = generateLearnedReply(normalizedText);
                    if (learnedReply) {
                        await sendTrackedMessage(jid, learnedReply);
                        return;
                    }

                    const openAIReply = await generateOpenAIReply(text);
                    if (openAIReply) {
                        await sendTrackedMessage(jid, openAIReply);
                    } else {
                        pushLearningLead(jid, text);
                    }
                }
            } catch (err) {
                console.error('❌ Error handling incoming message (connection kept alive):', err);
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
        fs.writeFileSync(CSV_FILE, 'ID,Name,Price\n1,Demo Item,10.00');
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
        .map((cell) => cell.trim().replace(/^"|"$/g, '').toLowerCase());
    if (!headerCells.includes('id') || !headerCells.includes('name') || !headerCells.includes('price')) {
        return res.status(400).json({ error: 'CSV header must include ID, Name, Price.' });
    }

    try {
        fs.writeFileSync(CSV_FILE, content.endsWith('\n') ? content : `${content}\n`);
        await loadProducts();
        return res.json({ message: 'Products CSV uploaded successfully.', products: products.length });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to import products CSV.' });
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
        phone: jid.replace('@s.whatsapp.net', '')
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
    saveJsonFile(CONTACTS_FILE, contactNames);
    res.json({ message: 'Contact saved.', jid, name });
});

app.post('/api/admin/contacts/import', writeRateLimiter, contactsImportUpload.single('file'), (req, res) => {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Missing contacts file.' });
    const parsed = parseContactsFromText(req.file.buffer.toString('utf8'));
    if (parsed.length === 0) return res.status(400).json({ error: 'No valid contacts found in file.' });
    for (const entry of parsed) {
        contactNames[entry.jid] = entry.name;
    }
    saveJsonFile(CONTACTS_FILE, contactNames);
    res.json({ message: 'Contacts imported.', imported: parsed.length });
});

app.delete('/api/admin/contacts/:jid', writeRateLimiter, (req, res) => {
    const jid = String(req.params.jid || '').trim();
    if (!jid) return res.status(400).json({ error: 'Missing jid.' });
    delete contactNames[jid];
    saveJsonFile(CONTACTS_FILE, contactNames);
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

app.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Uploaded file too large (max 5MB).' });
    }
    if (err) {
        console.error('❌ API error:', err);
        return res.status(500).json({ error: 'Unexpected server error.' });
    }
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
