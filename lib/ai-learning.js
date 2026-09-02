const fs = require('fs');
const path = require('path');

const AI_DATA_FILE = process.env.AI_DATA_FILE || './storage/ai-learning.json';
let cachedData = null;

function normalizeDataShape(data) {
    const safe = data && typeof data === 'object' ? data : {};
    if (!Array.isArray(safe.backups)) safe.backups = [];
    if (!Array.isArray(safe.teaching)) safe.teaching = [];
    if (!Array.isArray(safe.responseRules)) safe.responseRules = [];
    if (!Array.isArray(safe.conversationReplies)) safe.conversationReplies = [];
    if (!Array.isArray(safe.aiActivity)) safe.aiActivity = [];
    if (!safe.metaConnection || typeof safe.metaConnection !== 'object') {
        safe.metaConnection = { enabled: false };
    }
    return safe;
}

function ensureDataFile() {
    fs.mkdirSync(path.dirname(AI_DATA_FILE), { recursive: true });
    if (!fs.existsSync(AI_DATA_FILE)) {
        fs.writeFileSync(
            AI_DATA_FILE,
            JSON.stringify({ backups: [], teaching: [], responseRules: [], conversationReplies: [], aiActivity: [], metaConnection: { enabled: false } }, null, 2)
        );
    }
}

function readData() {
    if (cachedData) return cachedData;
    ensureDataFile();
    try {
        cachedData = normalizeDataShape(JSON.parse(fs.readFileSync(AI_DATA_FILE, 'utf8')));
    } catch {
        cachedData = normalizeDataShape({ backups: [], teaching: [], responseRules: [], conversationReplies: [], aiActivity: [], metaConnection: { enabled: false } });
        fs.writeFileSync(AI_DATA_FILE, JSON.stringify(cachedData, null, 2));
    }
    return cachedData;
}

function saveData(data) {
    fs.mkdirSync(path.dirname(AI_DATA_FILE), { recursive: true });
    const normalized = normalizeDataShape(data);
    fs.writeFileSync(AI_DATA_FILE, JSON.stringify(normalized, null, 2));
    cachedData = normalized;
}

function logAIActivity(type, details = {}) {
    const data = readData();
    data.aiActivity.push({
        type: String(type || 'event').trim() || 'event',
        details: details && typeof details === 'object' ? details : {},
        createdAt: new Date().toISOString()
    });
    if (data.aiActivity.length > 1000) {
        data.aiActivity = data.aiActivity.slice(-1000);
    }
    saveData(data);
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

        const normalizedLine = String(line || '').trim();
        const lowerLine = normalizedLine.toLowerCase();
        if (lowerLine.startsWith('when:') || lowerLine.startsWith('when-')) {
            const divider = normalizedLine.indexOf('|');
            if (divider > 0) {
                const left = normalizedLine.slice(0, divider).trim();
                const right = normalizedLine.slice(divider + 1).trim();
                const leftLower = left.toLowerCase();
                const rightLower = right.toLowerCase();
                if (leftLower.startsWith('when:') || leftLower.startsWith('when-')) {
                    let when = left.replace(/^when[:\-]\s*/i, '').trim();
                    if (rightLower.startsWith('reply:') || rightLower.startsWith('reply-') || rightLower.startsWith('respond:') || rightLower.startsWith('respond-')) {
                        const reply = right.replace(/^(reply|respond)[:\-]\s*/i, '').trim();
                        when = normalizeMessageText(when).toLowerCase();
                        if (when && reply) {
                            rules.push({ when, reply: normalizeMessageText(reply) });
                            continue;
                        }
                    }
                }
            }
        }
        if (lowerLine.startsWith('if ')) {
            const thenIndex = lowerLine.indexOf(' then ');
            if (thenIndex > 3) {
                const when = normalizeMessageText(normalizedLine.slice(3, thenIndex)).toLowerCase();
                const reply = normalizeMessageText(normalizedLine.slice(thenIndex + 6));
                if (when && reply) {
                    rules.push({ when, reply });
                    continue;
                }
            }
        }
        if (lowerLine.startsWith('q:') || lowerLine.startsWith('q-')) {
            const divider = normalizedLine.indexOf('|');
            if (divider > 0) {
                const left = normalizedLine.slice(0, divider).trim();
                const right = normalizedLine.slice(divider + 1).trim();
                const leftClean = left.replace(/^q[:\-]\s*/i, '').trim();
                const rightClean = right.replace(/^a[:\-]\s*/i, '').trim();
                if (leftClean && rightClean) {
                    rules.push({
                        when: leftClean.toLowerCase(),
                        reply: rightClean
                    });
                }
            }
        }
    }

    return rules;
}

function normalizeMessageText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateMessageText(value, maxLength = 220) {
    const text = normalizeMessageText(value);
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeRuleText(value) {
    return normalizeMessageText(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeRuleText(value) {
    return normalizeRuleText(value).split(' ').filter((token) => token.length > 1);
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)\]\s([^:]+):\s([\s\S]+)$/,
        /^([^:]{2,80}):\s(.+)$/
    ];

    for (const line of rawLines) {
        const raw = String(line || '');
        let matched = null;
        let senderIndex = 3;
        let textIndex = 4;
        for (const pattern of patterns) {
            const result = raw.match(pattern);
            if (result) {
                matched = result;
                if (pattern === patterns[2]) {
                    senderIndex = 1;
                    textIndex = 2;
                }
                break;
            }
        }

        if (matched) {
            if (current) messages.push(current);
            current = {
                sender: normalizeMessageText(matched[senderIndex]),
                text: normalizeMessageText(matched[textIndex])
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

function parseJsonBackupMessages(text) {
    try {
        const parsed = JSON.parse(String(text || ''));
        const messages = [];

        const pushMessage = (entry, fallbackSender = '') => {
            if (!entry || typeof entry !== 'object') return;
            const sender = normalizeMessageText(
                entry.sender
                || entry.from
                || entry.author
                || entry.name
                || entry.contact
                || entry.remoteJid
                || fallbackSender
            );
            const body = normalizeMessageText(
                entry.text
                || entry.message
                || entry.body
                || entry.content
                || entry.caption
            );
            if (!isUsableMessage(body)) return;
            if (!sender) return;
            messages.push({ sender, text: body });
        };

        if (Array.isArray(parsed)) {
            for (const item of parsed) pushMessage(item);
            return messages;
        }

        if (Array.isArray(parsed.messages)) {
            for (const item of parsed.messages) pushMessage(item);
        }
        if (Array.isArray(parsed.chats)) {
            for (const chat of parsed.chats) {
                const chatSender = normalizeMessageText(chat?.name || chat?.id || chat?.jid || '');
                const chatMessages = Array.isArray(chat?.messages) ? chat.messages : [];
                for (const item of chatMessages) pushMessage(item, chatSender);
            }
        }

        return messages;
    } catch {
        return [];
    }
}

function trainerNameMatches(senderValue, trainerValue) {
    const sender = normalizeRuleText(senderValue);
    const trainer = normalizeRuleText(trainerValue);
    if (!sender || !trainer) return false;
    if (sender === trainer) return true;
    if (trainer.length >= 4 && sender.includes(trainer)) return true;
    if (sender.length >= 4 && trainer.includes(sender)) return true;

    const senderDigits = sender.replace(/\D/g, '');
    const trainerDigits = trainer.replace(/\D/g, '');
    if (trainerDigits.length >= 7 && senderDigits.includes(trainerDigits)) return true;
    return false;
}

function extractRulesFromMessages(messages, trainerName) {
    const ownerName = normalizeMessageText(trainerName).toLowerCase();
    if (!ownerName) return [];
    const rules = [];

    for (let i = 1; i < messages.length; i += 1) {
        const previous = messages[i - 1];
        const current = messages[i];
        if (!previous || !current) continue;

        const previousSender = normalizeMessageText(previous.sender).toLowerCase();
        const currentSender = normalizeMessageText(current.sender).toLowerCase();
        if (!trainerNameMatches(currentSender, ownerName) || trainerNameMatches(previousSender, ownerName)) continue;
        if (!isUsableMessage(previous.text) || !isUsableMessage(current.text)) continue;

        rules.push({
            when: normalizeMessageText(previous.text).toLowerCase(),
            reply: normalizeMessageText(current.text)
        });
    }

    return rules;
}

function extractRulesFromTranscript(text, trainerName) {
    const transcriptMessages = parseWhatsAppTranscriptMessages(text);
    return extractRulesFromMessages(transcriptMessages, trainerName);
}

function extractPrintableStringsFromBuffer(fileBuffer, minLength = 8) {
    const results = [];
    let current = '';
    for (const byte of fileBuffer) {
        const isPrintable = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
        if (isPrintable) {
            current += String.fromCharCode(byte);
            continue;
        }
        if (current.length >= minLength) results.push(current.trim());
        current = '';
    }
    if (current.length >= minLength) results.push(current.trim());
    return results.filter(Boolean);
}

function looksLikeText(value) {
    const sample = String(value || '').slice(0, 4000);
    if (!sample) return false;
    let printable = 0;
    for (let i = 0; i < sample.length; i += 1) {
        const code = sample.charCodeAt(i);
        if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable += 1;
    }
    return printable / sample.length >= 0.9;
}

function decodeBackupContent(fileName, fileContent) {
    if (Buffer.isBuffer(fileContent)) {
        const utf8 = fileContent.toString('utf8');
        if (looksLikeText(utf8)) {
            return {
                text: utf8,
                sourceType: 'text'
            };
        }
        const extracted = extractPrintableStringsFromBuffer(fileContent, 10);
        return {
            text: extracted.join('\n'),
            sourceType: path.extname(String(fileName || '')).toLowerCase() === '.crypt14' ? 'crypt14' : 'binary',
            extractedStrings: extracted.length
        };
    }
    return {
        text: String(fileContent || ''),
        sourceType: 'text'
    };
}

function importBackup(fileName, fileContent, options = {}) {
    const data = readData();
    const decoded = decodeBackupContent(fileName, fileContent);
    const textBody = decoded.text || '';
    const structuredRules = extractRulesFromBackupText(textBody);
    const transcriptRules = extractRulesFromTranscript(textBody, options.trainerName);
    const jsonRules = extractRulesFromMessages(parseJsonBackupMessages(textBody), options.trainerName);
    const rules = [...structuredRules, ...transcriptRules, ...jsonRules];

    data.backups.push({
        fileName,
        uploadedAt: new Date().toISOString(),
        importedRules: rules.length,
        structuredRules: structuredRules.length,
        transcriptRules: transcriptRules.length,
        jsonRules: jsonRules.length,
        trainerName: options.trainerName || '',
        sourceType: decoded.sourceType,
        extractedStrings: decoded.extractedStrings || 0
    });

    for (const rule of rules) {
        const existing = data.responseRules.find((r) => r.when === rule.when);
        if (existing) {
            existing.reply = rule.reply;
            existing.updatedAt = new Date().toISOString();
        } else {
            data.responseRules.push({
                ...rule,
                updatedAt: new Date().toISOString()
            });
        }
    }

    saveData(data);
    return {
        importedRules: rules.length,
        structuredRules: structuredRules.length,
        transcriptRules: transcriptRules.length,
        jsonRules: jsonRules.length,
        sourceType: decoded.sourceType,
        extractedStrings: decoded.extractedStrings || 0,
        note: decoded.sourceType === 'crypt14' && rules.length === 0
            ? 'No readable chat text was found in this crypt14 file. Export a readable WhatsApp chat (.txt) or upload a decrypted DB to import past conversations.'
            : '',
        backups: data.backups.length
    };
}

function teachBehavior(instruction, examples = [], options = {}) {
    const data = readData();
    data.teaching.push({ instruction, examples, createdAt: new Date().toISOString() });
    const instructionRules = extractRulesFromBackupText(instruction);

    for (const pair of examples) {
        if (!pair || !pair.when || !pair.reply) continue;
        const when = String(pair.when).trim().toLowerCase();
        const reply = String(pair.reply).trim();
        if (!when || !reply) continue;

        const existing = data.responseRules.find((rule) => rule.when === when);
        if (existing) {
            existing.reply = reply;
            existing.updatedAt = new Date().toISOString();
        } else {
            data.responseRules.push({
                when,
                reply,
                updatedAt: new Date().toISOString()
            });
        }
    }

    for (const pair of instructionRules) {
        if (!pair || !pair.when || !pair.reply) continue;
        const existing = data.responseRules.find((rule) => rule.when === pair.when);
        if (existing) {
            existing.reply = pair.reply;
            existing.updatedAt = new Date().toISOString();
        } else {
            data.responseRules.push({
                when: pair.when,
                reply: pair.reply,
                updatedAt: new Date().toISOString()
            });
        }
    }

    saveData(data);
    logAIActivity('teaching_saved', {
        source: String(options.source || 'manual'),
        instructionLength: String(instruction || '').length,
        examplesCount: Array.isArray(examples) ? examples.length : 0,
        rulesTotal: data.responseRules.length
    });
    return { rules: data.responseRules.length, teachings: data.teaching.length };
}

function getDashboardData() {
    const data = readData();
    return {
        backups: data.backups,
        teaching: data.teaching,
        responseRules: data.responseRules,
        conversationReplies: data.conversationReplies,
        aiActivity: data.aiActivity,
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

function generateLearnedReply(text, options = {}) {
    const normalized = normalizeRuleText(text);
    if (!normalized) return null;
    const normalizedTokens = tokenizeRuleText(normalized);
    const minScore = Number(options.minScore || 1);
    const includeMeta = Boolean(options.includeMeta);

    const data = readData();
    const rules = [
        ...(Array.isArray(data.responseRules) ? data.responseRules.map((item) => ({ ...item, __source: 'responseRules' })) : []),
        ...(Array.isArray(data.conversationReplies) ? data.conversationReplies.map((item) => ({ ...item, __source: 'conversationReplies' })) : [])
    ];
    const candidates = rules
        .map((rule) => {
            if (!rule || !rule.when || !rule.reply) return false;
            const when = normalizeRuleText(rule.when);
            if (!when) return false;

            let score = 0;
            if (normalized === when) score = 1000;
            else if (normalized.includes(when) || when.includes(normalized)) score = 700;
            else {
                const whenTokens = tokenizeRuleText(when);
                const overlap = whenTokens.filter((token) => normalizedTokens.includes(token)).length;
                const tokenRatio = whenTokens.length ? overlap / whenTokens.length : 0;
                if (overlap >= 2 && tokenRatio >= 0.45) score = Math.round(tokenRatio * 500);
            }

            if (score <= 0) {
                if (when.length <= 2 && normalized === when) score = 300;
                else if (when.length > 2) {
                    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(when)}([^a-z0-9]|$)`, 'i');
                    if (pattern.test(normalized)) score = 600;
                }
            }

            if (score <= 0) return false;
            if (rule.__source === 'responseRules') score += 120;
            return { ...rule, score };
        })
        .filter(Boolean)
        .sort((a, b) => {
            const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
            if (scoreDiff !== 0) return scoreDiff;
            const lenDiff = String(b.when || '').length - String(a.when || '').length;
            if (lenDiff !== 0) return lenDiff;
            return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        });

    if (candidates.length === 0) return null;
    const best = candidates.find((candidate) => Number(candidate.score || 0) >= minScore);
    if (!best) return null;
    if (includeMeta) {
        return {
            when: best.when,
            reply: best.reply,
            score: Number(best.score || 0),
            source: best.__source || 'unknown'
        };
    }
    return best.reply;

}

function buildOpenAISystemPrompt() {
    const data = readData();
    const recentTeaching = data.teaching
        .slice(-8)
        .map((item) => truncateMessageText(item.instruction, 260))
        .filter(Boolean);
    const latestRuleExamples = [...data.responseRules]
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, 40)
        .map((rule) => `"${truncateMessageText(rule.when, 140)}" -> "${truncateMessageText(rule.reply, 220)}"`);
    const recentConversationExamples = [...data.conversationReplies]
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, 25)
        .map((rule) => `"${truncateMessageText(rule.when, 120)}" -> "${truncateMessageText(rule.reply, 180)}"`);

    const sections = [
        'You are the assistant for a WhatsApp business bot. Keep replies concise, friendly, and practical.'
    ];

    if (recentTeaching.length > 0) {
        const latestInstruction = recentTeaching[recentTeaching.length - 1];
        sections.push(`Latest high-priority direction from dashboard teaching:\n- ${latestInstruction}`);
        if (recentTeaching.length > 1) {
            sections.push(`Additional recent direction:\n- ${recentTeaching.slice(0, -1).join('\n- ')}`);
        }
    }

    if (latestRuleExamples.length > 0) {
        sections.push(`Preferred response patterns from uploaded backups and teachings (most recently updated first):\n- ${latestRuleExamples.join('\n- ')}`);
    }

    if (recentConversationExamples.length > 0) {
        sections.push(`Saved successful client conversation replies from older chats:\n- ${recentConversationExamples.join('\n- ')}`);
    }

    sections.push('If no specific pattern applies, provide a helpful general response.');
    return sections.join('\n\n');
}

function rememberConversationReply(userText, assistantReply) {
    const when = normalizeMessageText(userText).toLowerCase();
    const reply = normalizeMessageText(assistantReply);
    if (!isUsableMessage(when) || !isUsableMessage(reply)) return false;
    const whenTokens = tokenizeRuleText(when);
    if (whenTokens.length < 3) return false;
    if (/^(hi|hello|hey|thanks|ok|okay|menu)$/i.test(when)) return false;

    const data = readData();
    const existing = data.conversationReplies.find((item) => item.when === when);
    if (existing) {
        if (existing.reply !== reply) {
            existing.reply = reply;
            existing.updatedAt = new Date().toISOString();
            saveData(data);
            return true;
        }
        return false;
    }

    data.conversationReplies.push({
        when,
        reply,
        updatedAt: new Date().toISOString()
    });
    if (data.conversationReplies.length > 500) {
        data.conversationReplies = data.conversationReplies.slice(-500);
    }
    saveData(data);
    return true;
}

module.exports = {
    importBackup,
    teachBehavior,
    logAIActivity,
    getDashboardData,
    setMetaConnectionIntent,
    generateLearnedReply,
    buildOpenAISystemPrompt,
    rememberConversationReply
};
