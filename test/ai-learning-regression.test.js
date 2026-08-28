const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function createLearningModule() {
    const filePath = path.join('/tmp', `ai-learning-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    process.env.AI_DATA_FILE = filePath;
    delete require.cache[require.resolve('../lib/ai-learning')];
    return { module: require('../lib/ai-learning'), filePath };
}

function cleanup(filePath) {
    try {
        if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    } catch {}
}

test('teachBehavior extracts Q/A instruction rules for immediate learned replies', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        learning.teachBehavior('Q: delivery time | A: Standard turnaround is 2-3 working days.', []);
        const reply = learning.generateLearnedReply('Hi, what is your delivery time?');
        assert.equal(reply, 'Standard turnaround is 2-3 working days.');
    } finally {
        cleanup(filePath);
    }
});

test('generateLearnedReply matches partial natural-language overlap from taught rules', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        learning.teachBehavior('Sales behavior guidance', [
            { when: 'what are your opening hours', reply: 'We are open Monday to Friday, 8am to 5pm.' }
        ]);
        const reply = learning.generateLearnedReply('Please tell me your opening hours today.');
        assert.equal(reply, 'We are open Monday to Friday, 8am to 5pm.');
    } finally {
        cleanup(filePath);
    }
});

test('importBackup accepts crypt14-style binary uploads and extracts transcript rules', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        const transcript = [
            '12/08/2026, 10:00 - Client: Need 200 flyers please',
            '12/08/2026, 10:01 - Gareth: Sure, I can quote that now.'
        ].join('\n');
        const binaryBlob = Buffer.concat([
            Buffer.alloc(4000),
            Buffer.from(transcript, 'utf8'),
            Buffer.alloc(2000)
        ]);
        const result = learning.importBackup('msgstore.db.crypt14', binaryBlob, { trainerName: 'Gareth' });
        assert.equal(result.sourceType, 'crypt14');
        assert.ok(result.importedRules >= 1);
        assert.ok(result.transcriptRules >= 1);
    } finally {
        cleanup(filePath);
    }
});
