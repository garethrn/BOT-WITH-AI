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

function getRetryDelay(count) {
    return Math.min(5000 * Math.pow(2, count - 1), 60000);
}

function loadProducts() {
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
        });
}
loadProducts();

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

function getConversationSummaries() {
    const summaries = [];
    for (const [jid, messages] of chatLog.entries()) {
        const last = messages[messages.length - 1];
        summaries.push({
            jid,
            lastMessage: last?.text || '',
            lastRole: last?.role || '',
            lastTimestamp: last?.timestamp || chatLastActivity.get(jid) || null,
            paused: pausedChats.has(jid),
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
    if (req.path.startsWith('/admin') && !ADMIN_API_TOKEN) {
        return res.status(503).json({ error: 'ADMIN_API_TOKEN must be configured for admin APIs.' });
    }
    if (!ADMIN_API_TOKEN) return next();
    const provided = req.get('x-admin-token');
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

app.get('/', (_req, res) => res.send('Bot is running!'));
app.get('/dashboard', readRateLimiter, (_req, res) => res.redirect('/index.html'));

app.get('/qr', (_req, res) => {
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
            chatCount: chatLog.size
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
        paused: pausedChats.has(jid),
        messages: chatLog.get(jid) || []
    });
});

app.post('/api/admin/pause', writeRateLimiter, (_req, res) => {
    isBotPaused = true;
    res.json({ message: 'Bot paused globally.', paused: true });
});

app.post('/api/admin/resume', writeRateLimiter, (_req, res) => {
    isBotPaused = false;
    res.json({ message: 'Bot resumed globally.', paused: false });
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
        return res.status(400).json({ error: 'Backup file too large (max 5MB).' });
    }
    if (err) {
        console.error('❌ API error:', err);
        return res.status(500).json({ error: 'Unexpected server error.' });
    }
    return next(err);
});

app.listen(PORT, () => {
    console.log(`📡 Web server listening on port ${PORT}`);
    console.log('🔗 Dashboard available at /dashboard');
    if (!ADMIN_API_TOKEN) {
        console.warn('⚠️ ADMIN_API_TOKEN is not set. Admin APIs are currently unprotected.');
    }
    startBot(0);
});
