const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pricing = require('../index');
const { parseProductsCsvContent } = require('../lib/csv-loader');

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

test('buildCsvPricingReply handles corex board requests with csv pricing', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('corex board single sided 600x800 qty 1');
    assert.ok(reply);
    assert.match(reply, /600x 800mm|single sided/i);
    assert.match(reply, /Estimated total: R200\.00/i);
    assert.doesNotMatch(reply, /\$xx|\$\s*x+/i);
});

test('buildCsvPricingReply handles correx typo requests with csv pricing', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('correx board single sided 600x800 qty 1');
    assert.ok(reply);
    assert.match(reply, /Estimated total: R200\.00/i);
    assert.doesNotMatch(reply, /\$xx|\$\s*x+/i);
});

test('buildCsvPricingReply shows catalog price lines for corex price-list requests', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('what are the prices for corex boards');
    assert.ok(reply);
    assert.match(reply, /products CSV/i);
    assert.match(reply, /R200\.00|R260\.00/i);
    assert.doesNotMatch(reply, /\$xx|\$\s*x+/i);
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
    assert.match(reply, /single-sided|double-sided|size|finish/i);
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

test('buildCsvPricingReply calculates sqm totals from csv price per sqm formula', async () => {
    await pricing.loadProducts();
    const reply = pricing.buildCsvPricingReply('quote qty 2 pvc banners 1200x600 yes artwork ready');
    assert.ok(reply);
    assert.match(reply, /Estimated total: R216\.00/i);
    assert.doesNotMatch(reply, /\$xx|\$\s*x+/i);
});

test('buildCsvPricingReply can locate catalog pricing across fixed-price subcategories', async () => {
    await pricing.loadProducts();
    const csvPath = path.join(__dirname, '..', 'products.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const allProducts = await parseProductsCsvContent(csvContent);
    const sampleRows = new Map();
    for (const product of allProducts) {
        if (String(product.PriceType || '').toLowerCase() !== 'fixed') continue;
        const subcategoryKey = String(product.Subcategory || product.Name || '').trim().toLowerCase();
        if (!subcategoryKey) continue;
        if (sampleRows.has(subcategoryKey)) continue;
        const size = String(product.Size || '').trim();
        if (!size || /^custom$/i.test(size)) continue;
        if (!pricing.parseDimensionsFromText(size) && !/\b(a0|a1|a2|a3|a4|a5|a6)\b/i.test(size)) continue;
        sampleRows.set(subcategoryKey, product);
    }

    for (const product of sampleRows.values()) {
        const qty = parseInt((String(product.UnitsPerProduct || '').match(/\d+/) || ['1'])[0], 10) || 1;
        const parsedSize = pricing.parseDimensionsFromText(String(product.Size || ''));
        const sizeToken = parsedSize ? `${parsedSize.widthMm}x${parsedSize.heightMm}` : String(product.Size || '');
        const prompt = `quote qty ${qty} ${product.Subcategory || ''} ${product.Name || ''} ${sizeToken} ${product.Finish || ''} ${product.SingleOrDoubleSided || ''} yes artwork ready`;
        const reply = pricing.buildCsvPricingReply(prompt);
        assert.ok(reply, `Expected reply for ${product.Subcategory || product.Name}`);
        assert.doesNotMatch(reply, /\$xx|\$\s*x+/i, `Placeholder price returned for ${product.Subcategory || product.Name}`);
        assert.match(reply, /Estimated total: R|minimum order/i, `No deterministic price outcome for ${product.Subcategory || product.Name}`);
    }
});
