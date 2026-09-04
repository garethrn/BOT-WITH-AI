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

test('new ai learning rewrite helper is available at module scope', () => {
    assert.equal(typeof pricing.rewriteCorrectionWithOpenAI, 'function');
});

test('buildCsvPricingReply selects fixed pricing tier matching quantity and options', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('Please quote 500 business cards laminated double sided');
    assert.ok(reply);
    assert.match(reply, /Business Cards 300GSM/i);
    assert.match(reply, /Estimated total: R775\.00/i);
});

test('buildProductContextForAI includes relevant CSV product pricing lines', async () => {
    await pricing.loadProducts();
    const context = pricing.buildProductContextForAI('quote 500 laminated double sided business cards');
    assert.ok(context);
    assert.match(context, /Business Cards 300GSM/i);
    assert.match(context, /priceType: fixed/i);
    assert.match(context, /R775\.00/i);
});

test('buildCsvPricingReply does not fall through to OpenAI-style null for pricing intent', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('how much for zzqvxx nonexisting catalog item quote');
    assert.ok(reply);
    assert.match(reply, /products catalog|please share quantity/i);
});

test('buildCsvPricingReply never returns dollar placeholder pricing', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('please quote 500 business cards laminated double sided');
    assert.ok(reply);
    assert.doesNotMatch(reply, /\$xx|\$\d|\$\s*\w+/i);
    assert.match(reply, /R\d+/i);
});

test('buildCsvPricingReply suggests closest catalog size when dimensions are not exact', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('quote qty 1 vinyl cut stickers standard single colors size 1150x100');
    assert.ok(reply);
    assert.match(reply, /closest catalog size/i);
});

test('buildProductContextForAI keeps signage focus and avoids unrelated business cards', async () => {
    await pricing.loadProducts();
    const context = pricing.buildProductContextForAI('need quote for outdoor signage acm signs 1200x800');
    assert.ok(context);
    assert.match(context, /ACM Signs|Outdoor Signs/i);
    assert.doesNotMatch(context, /Business Cards 300GSM/i);
});

test('buildCsvPricingReply enforces minimum order quantity for per-unit rows', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('please quote 20 bookmarks laminated single sided 190x60');
    assert.ok(reply);
    assert.match(reply, /minimum order is 50/i);
});

test('buildCsvPricingReply uses human phrasing when quantity is missing', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('quote laminated double sided business cards');
    assert.ok(reply);
    assert.match(reply, /what quantity/i);
    assert.match(reply, /available options:/i);
    assert.match(reply, /500/i);
    assert.doesNotMatch(reply, /\bI found\b/i);
});

test('buildCsvPricingReply asks a signage-specific follow-up without drifting products', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('i need an outdoor signage quote for acm');
    assert.ok(reply);
    assert.match(reply, /single-sided|double-sided|size/i);
    assert.doesNotMatch(reply, /business cards/i);
});

test('buildCsvPricingReply adds design fee when artwork is not ready', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('quote 50 bookmarks laminated single sided 190x60 no artwork');
    assert.ok(reply);
    assert.match(reply, /Design fee:/i);
});

test('buildCsvPricingReply excludes design fee when artwork is ready', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('quote 50 bookmarks laminated single sided 190x60 yes artwork ready');
    assert.ok(reply);
    assert.doesNotMatch(reply, /Design fee/i);
});
