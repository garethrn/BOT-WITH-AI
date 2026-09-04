const test = require('node:test');
const assert = require('node:assert/strict');

const { matchProducts, filterRows, normalizeSidedOption } = require('../lib/product-lookup');
const { calculateQuote, selectBestFixedRow } = require('../lib/quote-calculator');
const { handleQuoteConversationMessage, STATES, createState, isGreetingMessage, buildFreshQuoteStartMessage } = require('../lib/quote-state-machine');

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

test('fixed price falls back to numeric UnitPricing when FixedPrice is missing', () => {
    const row = { ...sampleProducts[0], FixedPrice: '', UnitPricing: '3.50' };
    const quote = calculateQuote(row, { quantity: 500, hasArtwork: true });
    assert.equal(quote.ok, true);
    assert.equal(quote.base, 1750);
    assert.equal(quote.total, 1750);
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

test('greeting helpers start fresh and include quantity options', () => {
    assert.equal(isGreetingMessage('hello'), true);
    assert.equal(isGreetingMessage('menu'), true);
    const msg = buildFreshQuoteStartMessage(sampleProducts);
    assert.match(msg, /start fresh/i);
    assert.match(msg, /qty options: 500/i);
});

test('quantity prompt includes available fixed quantity options', () => {
    const stateStore = new Map();
    handleQuoteConversationMessage({
        jid: 'qty@s.whatsapp.net',
        text: 'quote business cards',
        products: sampleProducts,
        stateStore
    });
    handleQuoteConversationMessage({
        jid: 'qty@s.whatsapp.net',
        text: 'laminated double sided',
        products: sampleProducts,
        stateStore
    });
    handleQuoteConversationMessage({
        jid: 'qty@s.whatsapp.net',
        text: 'yes artwork ready',
        products: sampleProducts,
        stateStore
    });
    const reply = handleQuoteConversationMessage({
        jid: 'qty@s.whatsapp.net',
        text: 'please continue',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, true);
    assert.match(reply.reply, /what quantity should i quote/i);
    assert.match(reply.reply, /500/i);
});

test('plain numeric quantity reply is accepted without repeating question', () => {
    const stateStore = new Map();
    handleQuoteConversationMessage({
        jid: 'plainqty@s.whatsapp.net',
        text: 'quote business cards',
        products: sampleProducts,
        stateStore
    });
    handleQuoteConversationMessage({
        jid: 'plainqty@s.whatsapp.net',
        text: 'laminated double sided',
        products: sampleProducts,
        stateStore
    });
    handleQuoteConversationMessage({
        jid: 'plainqty@s.whatsapp.net',
        text: 'yes artwork ready',
        products: sampleProducts,
        stateStore
    });
    const reply = handleQuoteConversationMessage({
        jid: 'plainqty@s.whatsapp.net',
        text: '500',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, true);
    assert.match(reply.reply, /quote ready|total/i);
    assert.doesNotMatch(reply.reply, /what quantity should i quote/i);
});

test('active quote session allows non-quote conversation to fall through for AI assistance', () => {
    const stateStore = new Map();
    handleQuoteConversationMessage({
        jid: 'interrupt@s.whatsapp.net',
        text: 'quote business cards',
        products: sampleProducts,
        stateStore
    });

    handleQuoteConversationMessage({
        jid: 'interrupt@s.whatsapp.net',
        text: 'laminated double sided',
        products: sampleProducts,
        stateStore
    });
    handleQuoteConversationMessage({
        jid: 'interrupt@s.whatsapp.net',
        text: 'yes artwork ready',
        products: sampleProducts,
        stateStore
    });

    const reply = handleQuoteConversationMessage({
        jid: 'interrupt@s.whatsapp.net',
        text: 'what are your opening hours',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, false);
    assert.equal(reply.reply, null);
    assert.notEqual(stateStore.get('interrupt@s.whatsapp.net').step, STATES.AWAITING_PRODUCT);
});

test('active product flow does not fall through to unrelated chat before artwork step', () => {
    const stateStore = new Map();
    handleQuoteConversationMessage({
        jid: 'focus@s.whatsapp.net',
        text: 'quote business cards',
        products: sampleProducts,
        stateStore
    });

    const reply = handleQuoteConversationMessage({
        jid: 'focus@s.whatsapp.net',
        text: 'hello how are you',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, true);
    assert.match(reply.reply, /finish\/material|single sided|print-ready artwork/i);
});

test('locked product family remains stable through follow-up questions', () => {
    const stateStore = new Map();
    handleQuoteConversationMessage({
        jid: 'lock@s.whatsapp.net',
        text: 'quote business cards',
        products: sampleProducts,
        stateStore
    });
    const reply = handleQuoteConversationMessage({
        jid: 'lock@s.whatsapp.net',
        text: 'tell me about banners',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, true);
    const state = stateStore.get('lock@s.whatsapp.net');
    assert.equal((state.lockedFamilyLabel || '').toLowerCase().includes('business cards'), true);
    assert.equal(state.candidates.every((row) => String(row.Name || '').toLowerCase().includes('business cards')), true);
});

test('explicit switch intent changes locked product family', () => {
    const stateStore = new Map();
    handleQuoteConversationMessage({
        jid: 'switch@s.whatsapp.net',
        text: 'quote business cards',
        products: sampleProducts,
        stateStore
    });
    const reply = handleQuoteConversationMessage({
        jid: 'switch@s.whatsapp.net',
        text: 'switch to custom banner',
        products: sampleProducts,
        stateStore
    });
    assert.equal(reply.handled, true);
    const state = stateStore.get('switch@s.whatsapp.net');
    assert.equal((state.lockedFamilyLabel || '').toLowerCase().includes('custom banner'), true);
});

test('product lookup can match by deep category fields and units per product', () => {
    const deepProducts = [
        {
            ID: 'D1',
            Name: 'Outdoor Telescopic Banner',
            Category: 'Signage',
            Subcategory: 'Banners',
            SubSubcategory: 'Outdoor',
            SubSubSubcategory: 'Telescopic',
            Size: 'Custom',
            Finish: 'PVC',
            SingleOrDoubleSided: 'Single Sided',
            UnitsPerProduct: '1',
            PriceType: 'sqm',
            PricePerSqm: '200'
        }
    ];
    const byDeepCategory = matchProducts(deepProducts, 'telescopic');
    const byUnits = matchProducts(deepProducts, '1');
    assert.equal(byDeepCategory.rows.length, 1);
    assert.equal(byUnits.rows.length, 1);
});

test('quote state machine accepts extracted details to avoid repeat questions', () => {
    const stateStore = new Map();
    const reply = handleQuoteConversationMessage({
        jid: 'extract@s.whatsapp.net',
        text: 'quote please',
        products: sampleProducts,
        stateStore,
        requestDetails: {
            intent: 'request_quote',
            product_query: 'business cards',
            finish: 'laminated',
            sided_option: 'double sided',
            quantity: 500,
            has_artwork: true
        }
    });
    assert.equal(reply.handled, true);
    assert.match(reply.reply, /quote ready|total/i);
});
