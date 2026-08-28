const fs = require('fs');

const AI_DATA_FILE = process.env.AI_DATA_FILE || './storage/ai-learning.json';
let cachedData = null;

function ensureDataFile() {
    if (!fs.existsSync(AI_DATA_FILE)) {
        fs.writeFileSync(
            AI_DATA_FILE,
            JSON.stringify({ backups: [], teaching: [], responseRules: [], metaConnection: { enabled: false } }, null, 2)
        );
    }
}

function readData() {
    ensureDataFile();
    if (cachedData) return cachedData;
    cachedData = JSON.parse(fs.readFileSync(AI_DATA_FILE, 'utf8'));
    return cachedData;
}

function saveData(data) {
    cachedData = data;
    fs.writeFileSync(AI_DATA_FILE, JSON.stringify(data, null, 2));
}

function extractRulesFromBackupText(text) {
    const rules = [];
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
        const arrowSplit = line.split('=>');
        if (arrowSplit.length === 2) {
            rules.push({
                when: arrowSplit[0].trim().toLowerCase(),
                reply: arrowSplit[1].trim()
            });
            continue;
        }

        const questionMatch = line.match(/^q[:\-]\s*(.+)\s*[|]\s*a[:\-]\s*(.+)$/i);
        if (questionMatch) {
            rules.push({
                when: questionMatch[1].trim().toLowerCase(),
                reply: questionMatch[2].trim()
            });
        }
    }

    return rules;
}

function normalizeMessageText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function isUsableMessage(value) {
    const text = normalizeMessageText(value);
    if (!text) return false;
    if (text.length < 2) return false;
    if (/^<media omitted>$/i.test(text)) return false;
    return true;
}

function parseWhatsAppTranscriptMessages(text) {
    const rawLines = String(text || '').split(/\r?\n/);
    const messages = [];
    let current = null;

    const patterns = [
        /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)\s[-–]\s([^:]+):\s([\s\S]+)$/,
        /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)\]\s([^:]+):\s([\s\S]+)$/
    ];

    for (const line of rawLines) {
        const raw = String(line || '');
        let matched = null;
        for (const pattern of patterns) {
            const result = raw.match(pattern);
            if (result) {
                matched = result;
                break;
            }
        }

        if (matched) {
            if (current) messages.push(current);
            current = {
                sender: normalizeMessageText(matched[3]),
                text: normalizeMessageText(matched[4])
            };
            continue;
        }

        if (current) {
            const extra = normalizeMessageText(raw);
            if (extra) current.text = `${current.text} ${extra}`.trim();
        }
    }

    if (current) messages.push(current);
    return messages;
}

function extractRulesFromTranscript(text, trainerName) {
    const ownerName = normalizeMessageText(trainerName).toLowerCase();
    if (!ownerName) return [];

    const messages = parseWhatsAppTranscriptMessages(text);
    const rules = [];

    for (let i = 1; i < messages.length; i += 1) {
        const previous = messages[i - 1];
        const current = messages[i];
        if (!previous || !current) continue;

        const previousSender = normalizeMessageText(previous.sender).toLowerCase();
        const currentSender = normalizeMessageText(current.sender).toLowerCase();
        if (currentSender !== ownerName || previousSender === ownerName) continue;
        if (!isUsableMessage(previous.text) || !isUsableMessage(current.text)) continue;

        rules.push({
            when: normalizeMessageText(previous.text).toLowerCase(),
            reply: normalizeMessageText(current.text)
        });
    }

    return rules;
}

function importBackup(fileName, fileContent, options = {}) {
    const data = readData();
    const structuredRules = extractRulesFromBackupText(fileContent);
    const transcriptRules = extractRulesFromTranscript(fileContent, options.trainerName);
    const rules = [...structuredRules, ...transcriptRules];

    data.backups.push({
        fileName,
        uploadedAt: new Date().toISOString(),
        importedRules: rules.length,
        structuredRules: structuredRules.length,
        transcriptRules: transcriptRules.length,
        trainerName: options.trainerName || ''
    });

    for (const rule of rules) {
        const existing = data.responseRules.find((r) => r.when === rule.when);
        if (existing) {
            existing.reply = rule.reply;
        } else {
            data.responseRules.push(rule);
        }
    }

    saveData(data);
    return {
        importedRules: rules.length,
        structuredRules: structuredRules.length,
        transcriptRules: transcriptRules.length,
        backups: data.backups.length
    };
}

function teachBehavior(instruction, examples = []) {
    const data = readData();
    data.teaching.push({ instruction, examples, createdAt: new Date().toISOString() });

    for (const pair of examples) {
        if (!pair || !pair.when || !pair.reply) continue;
        const when = String(pair.when).trim().toLowerCase();
        const reply = String(pair.reply).trim();
        if (!when || !reply) continue;

        const existing = data.responseRules.find((rule) => rule.when === when);
        if (existing) {
            existing.reply = reply;
        } else {
            data.responseRules.push({ when, reply });
        }
    }

    saveData(data);
    return { rules: data.responseRules.length, teachings: data.teaching.length };
}

function getDashboardData() {
    const data = readData();
    return {
        backups: data.backups,
        teaching: data.teaching,
        responseRules: data.responseRules,
        metaConnection: data.metaConnection || { enabled: false }
    };
}

function setMetaConnectionIntent(config) {
    const data = readData();
    data.metaConnection = {
        enabled: Boolean(config.enabled),
        businessAccountId: config.businessAccountId || '',
        phoneNumberId: config.phoneNumberId || '',
        notes: config.notes || '',
        updatedAt: new Date().toISOString()
    };
    saveData(data);
    return data.metaConnection;
}

function generateLearnedReply(text) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return null;

    const data = readData();
    const matched = data.responseRules.find((rule) => normalized.includes(rule.when));
    if (matched) return matched.reply;

    return null;
}

function buildOpenAISystemPrompt() {
    const data = readData();
    const recentTeaching = data.teaching.slice(-5).map((item) => item.instruction).filter(Boolean);
    const ruleExamples = data.responseRules.slice(0, 30).map((rule) => `"${rule.when}" -> "${rule.reply}"`);

    const sections = [
        'You are the assistant for a WhatsApp business bot. Keep replies concise, friendly, and practical.'
    ];

    if (recentTeaching.length > 0) {
        sections.push(`Direction from dashboard teaching:\n- ${recentTeaching.join('\n- ')}`);
    }

    if (ruleExamples.length > 0) {
        sections.push(`Preferred response patterns from uploaded backups:\n- ${ruleExamples.join('\n- ')}`);
    }

    sections.push('If no specific pattern applies, provide a helpful general response.');
    return sections.join('\n\n');
}

module.exports = {
    importBackup,
    teachBehavior,
    getDashboardData,
    setMetaConnectionIntent,
    generateLearnedReply,
    buildOpenAISystemPrompt
};
