const test = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../index');

test('parseDimensionsFromText supports mm, cm, and m units', () => {
    assert.deepEqual(pricing.parseDimensionsFromText('1200x600'), { widthMm: 1200, heightMm: 600 });
    assert.deepEqual(pricing.parseDimensionsFromText('120cm x 60cm'), { widthMm: 1200, heightMm: 600 });
    assert.deepEqual(pricing.parseDimensionsFromText('1.2m x 0.6m'), { widthMm: 1200, heightMm: 600 });
});

test('parseQuantityFromText does not confuse dimensions with quantity', () => {
    assert.equal(pricing.parseQuantityFromText('i need 2 banners 1200x600'), 2);
    assert.equal(pricing.parseQuantityFromText('quote qty 3 banner 1200x600'), 3);
    assert.equal(pricing.parseQuantityFromText('quote 500 business cards laminated double sided'), 500);
});

test('buildCsvPricingReply selects fixed pricing tier matching quantity and options', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('Please quote 500 business cards laminated double sided');
    assert.ok(reply);
    assert.match(reply, /Business Cards 300GSM/i);
    assert.match(reply, /Estimated total: R775\.00/i);
});
