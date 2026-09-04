const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function loadModules() {
    const filePath = path.join('/tmp', `ai-learning-greeting-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    process.env.AI_DATA_FILE = filePath;
    process.env.BOT_TEST_MODE = '1';
    delete require.cache[require.resolve('../lib/ai-learning')];
    delete require.cache[require.resolve('../index')];
    const learning = require('../lib/ai-learning');
    const app = require('../index');
    return { learning, app, filePath };
}

function cleanup(filePath) {
    try {
        if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    } catch {}
}

test('buildGreetingReply uses human greeting with help follow-up by default', { concurrency: false }, () => {
    const { app, filePath } = loadModules();
    try {
        const reply = app.buildGreetingReply('hello');
        assert.match(reply, /is there anything we can help with today\?/i);
    } finally {
        cleanup(filePath);
    }
});

test('buildGreetingReply prioritizes taught greeting response rules', { concurrency: false }, () => {
    const { app, learning, filePath } = loadModules();
    try {
        learning.teachBehavior('Greeting rule', [
            { when: 'hello', reply: 'Hello 👋 Is there anything we can help with today?' }
        ]);
        const reply = app.buildGreetingReply('hello');
        assert.equal(reply, 'Hello 👋 Is there anything we can help with today?');
    } finally {
        cleanup(filePath);
    }
});
