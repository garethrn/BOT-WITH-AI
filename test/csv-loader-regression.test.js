const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeCsvHeader,
    normalizeProductRecord,
    validateProductCsvHeaders,
    parseProductsCsvContent
} = require('../lib/csv-loader');

test('normalizeCsvHeader trims and normalizes header labels', () => {
    assert.equal(normalizeCsvHeader(' Price Type '), 'pricetype');
    assert.equal(normalizeCsvHeader('Single Or Double Sided'), 'singleordoublesided');
});

test('normalizeProductRecord maps aliases and trims value whitespace', () => {
    const row = normalizeProductRecord({
        'Product Name': '  Business Cards 300GSM  ',
        'Sub Category': ' Business Cards ',
        'Price': 'R775.00',
        'Price Type': 'FIXED',
        'Single Or Double Sided': ' Double Sided ',
        'Units Per Product': '500'
    });
    assert.equal(row.Name, 'Business Cards 300GSM');
    assert.equal(row.Subcategory, 'Business Cards');
    assert.equal(row.PriceType, 'fixed');
    assert.equal(row.SingleOrDoubleSided, 'Double Sided');
});

test('validateProductCsvHeaders detects required fields', () => {
    const ok = validateProductCsvHeaders('ID,Name,PriceType,FixedPrice\n1,Test,fixed,10');
    const bad = validateProductCsvHeaders('Name,Finish,Size\nTest,Gloss,A4');
    assert.equal(ok.ok, true);
    assert.equal(bad.ok, false);
});

test('parseProductsCsvContent parses and keeps only valid priced rows', async () => {
    const content = [
        'ID,Name,PriceType,FixedPrice,PricePerSqm',
        '1,Test Fixed,fixed,100,',
        '2,Test Sqm,sqm,,250',
        '3,Invalid Row,fixed,,'
    ].join('\n');
    const rows = await parseProductsCsvContent(content);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].Name, 'Test Fixed');
    assert.equal(rows[1].PriceType, 'sqm');
});
