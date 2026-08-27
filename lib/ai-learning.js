const fs = require('fs');

const AI_DATA_FILE = process.env.AI_DATA_FILE || './storage/ai-learning.json';

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
    return JSON.parse(fs.readFileSync(AI_DATA_FILE, 'utf8'));
}

function saveData(data) {
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

function importBackup(fileName, fileContent) {
    const data = readData();
    const rules = extractRulesFromBackupText(fileContent);

    data.backups.push({
        fileName,
        uploadedAt: new Date().toISOString(),
        importedRules: rules.length
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
    return { importedRules: rules.length, backups: data.backups.length };
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

module.exports = {
    importBackup,
    teachBehavior,
    getDashboardData,
    setMetaConnectionIntent,
    generateLearnedReply
};
