const test = require('node:test');
const assert = require('node:assert/strict');

const { matchProducts, filterRows, normalizeSidedOption } = require('../lib/product-lookup');
const { calculateQuote, selectBestFixedRow } = require('../lib/quote-calculator');
const { handleQuoteConversationMessage, STATES, createState } = require('../lib/quote-state-machine');

const sampleProducts = [
    {
        ID: 'A1',
        Name: 'Business Cards 300GSM ',
        Category: 'Paper Printing',
        Subcategory: 'Business Cards',
        Size: 'Standard 90x55mm',
        Finish: 'Laminated',
        SingleOrDoubleSided: 'Double Sided ',
        UnitsPerProduct: '500',
        PriceType: 'fixed',
        FixedPrice: 'R775.00',
        RequiresArtwork: 'yes',
        DesignFee: '120'
    },
    {
        ID: 'A2',
        Name: 'Custom Banner',
        Category: 'Flat Banners',
        Subcategory: 'PVC Banners',
        Size: 'Custom',
        Finish: 'PVC',
        SingleOrDoubleSided: '',
        UnitsPerProduct: '1',
        PriceType: 'sqm',
        PricePerSqm: '150',
        MinPrice: '60',
        RequiresArtwork: 'yes',
        DesignFee: '120',
        PolePrice: '80',
        PolesAvailable: 'yes',
        InstallationFee: '200'
    }
];

test('fixed price product uses CSV price only', () => {
    const row = selectBestFixedRow([sampleProducts[0]], 500);
    const quote = calculateQuote(row, { quantity: 500, hasArtwork: true });
    assert.equal(quote.ok, true);
    assert.equal(quote.base, 775);
    assert.equal(quote.total, 775);
});

test('sqm product calculates with min price floor and quantity', () => {
    const quote = calculateQuote(sampleProducts[1], {
        quantity: 2,
        widthMm: 1000,
        heightMm: 200,
        hasArtwork: true
    });
    assert.equal(quote.ok, true);
    assert.equal(Number(quote.areaSqm.toFixed(3)), 0.2);
    assert.equal(quote.base, 120);
});

test('design fee applies only when artwork is missing', () => {
    const withoutArtwork = calculateQuote(sampleProducts[0], { quantity: 500, hasArtwork: false });
    const withArtwork = calculateQuote(sampleProducts[0], { quantity: 500, hasArtwork: true });
    assert.equal(withoutArtwork.ok, true);
    assert.equal(withArtwork.ok, true);
    assert.equal(withoutArtwork.designFee, 120);
    assert.equal(withArtwork.designFee, 0);
});

test('sided option matching normalizes whitespace and casing', () => {
    assert.equal(normalizeSidedOption(' Double Sided '), 'double sided');
    const matches = filterRows([sampleProducts[0]], { sided: 'double sided' });
    assert.equal(matches.length, 1);
});

test('conversation state progression reaches quote_ready path in sequence', () => {
    const stateStore = new Map();
    let reply = handleQuoteConversationMessage({
        jid: '123@s.whatsapp.net',
        text: 'I need a quote for business cards',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, true);
    assert.match(reply.reply, /which finish\/material|single sided|print-ready artwork/i);

    reply = handleQuoteConversationMessage({
        jid: '123@s.whatsapp.net',
        text: 'laminated double sided',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, true);
    assert.match(reply.reply, /print-ready artwork/i);

    reply = handleQuoteConversationMessage({
        jid: '123@s.whatsapp.net',
        text: 'yes artwork ready qty 500',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, true);
    assert.match(reply.reply, /quote ready|total/i);
    assert.equal(stateStore.get('123@s.whatsapp.net').step, STATES.AWAITING_PRODUCT);
});

test('product lookup returns matching rows by normalized product name', () => {
    const result = matchProducts(sampleProducts, 'business cards 300gsm');
    assert.equal(result.rows.length > 0, true);
    assert.equal(result.rows[0].Name.includes('Business Cards'), true);
    assert.equal(createState().step, STATES.AWAITING_PRODUCT);
});
