const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../index');

test('phoneFromJid returns canonical customer number from jid', () => {
    assert.equal(app.phoneFromJid('27715551234:21@s.whatsapp.net'), '+27715551234');
    assert.equal(app.phoneFromJid('27715551234@c.us'), '+27715551234');
});

test('resolveIncomingJid normalizes direct chat jid for consistent conversation mapping', () => {
    const resolved = app.resolveIncomingJid({
        remoteJid: '27715551234:99@s.whatsapp.net',
        participant: ''
    });
    assert.equal(resolved, '27715551234@s.whatsapp.net');
});
