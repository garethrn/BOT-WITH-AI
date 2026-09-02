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

test('generateLearnedReply supports strict minScore for immediate rule enforcement', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        learning.teachBehavior('rule', [
            { when: 'how long for delivery', reply: 'Delivery is 2-3 working days.' }
        ]);
        const strict = learning.generateLearnedReply('how long for delivery', { minScore: 700 });
        const partialStrict = learning.generateLearnedReply('please confirm delivery timing', { minScore: 700 });
        assert.equal(strict, 'Delivery is 2-3 working days.');
        assert.equal(partialStrict, null);
    } finally {
        cleanup(filePath);
    }
});

test('generateLearnedReply boosts taught rules over conversation memory during strict matching', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        learning.rememberConversationReply('delivery time', 'Old memory reply.');
        learning.teachBehavior('rule', [
            { when: 'delivery time', reply: 'Delivery is 2-3 working days.' }
        ]);
        const strict = learning.generateLearnedReply('delivery time', { minScore: 450, includeMeta: true });
        assert.equal(strict.reply, 'Delivery is 2-3 working days.');
        assert.equal(strict.source, 'responseRules');
    } finally {
        cleanup(filePath);
    }
});

test('rememberConversationReply ignores very short generic user prompts', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        const stored = learning.rememberConversationReply('hi', 'Hello and welcome.');
        assert.equal(stored, false);
        const reply = learning.generateLearnedReply('hi');
        assert.equal(reply, null);
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

test('manual and interactive teaching writes AI activity log entries', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        learning.teachBehavior('Manual instruction', [], { source: 'manual_dashboard' });
        learning.teachBehavior('Interactive coach instruction', [], { source: 'interactive_coach' });
        learning.logAIActivity('coach_interaction', { promptLength: 25, replyLength: 100 });
        const data = learning.getDashboardData();
        assert.ok(Array.isArray(data.aiActivity));
        assert.ok(data.aiActivity.length >= 3);
        const activityTypes = data.aiActivity.map((item) => item.type);
        assert.ok(activityTypes.includes('teaching_saved'));
        assert.ok(activityTypes.includes('coach_interaction'));
    } finally {
        cleanup(filePath);
    }
});

test('teachBehavior extracts when|reply instruction format for immediate rule use', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        learning.teachBehavior('when: delivery time | reply: Delivery takes 2-3 working days.');
        const reply = learning.generateLearnedReply('delivery time');
        assert.equal(reply, 'Delivery takes 2-3 working days.');
    } finally {
        cleanup(filePath);
    }
});

test('buildOpenAISystemPrompt truncates oversized stored examples', { concurrency: false }, () => {
    const { module: learning, filePath } = createLearningModule();
    try {
        const longWhen = `shipping ${'details '.repeat(120)}`;
        const longReply = `We deliver nationwide. ${'Turnaround depends on print queue. '.repeat(120)}`;
        learning.teachBehavior('Long prompt handling', [{ when: longWhen, reply: longReply }]);
        const prompt = learning.buildOpenAISystemPrompt();
        assert.ok(prompt.length < 9000);
        assert.match(prompt, /\.\.\./);
    } finally {
        cleanup(filePath);
    }
});
