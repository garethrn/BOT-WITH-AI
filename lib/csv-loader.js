const csv = require('csv-parser');
const { Readable } = require('stream');

const PRODUCT_FIELD_ALIASES = {
    ID: ['ID', 'ProductID', 'Code'],
    SKU: ['SKU', 'Sku', 'ProductSKU'],
    Category: ['Category', 'Department'],
    Subcategory: ['Subcategory', 'Sub Category', 'Product Type', 'Type'],
    Name: ['Name', 'Product', 'Product Name', 'Item Name', 'Description'],
    Size: ['Size', 'Dimensions'],
    Finish: ['Finish', 'Material'],
    SingleOrDoubleSided: ['SingleOrDoubleSided', 'Single Or Double Sided', 'Sides'],
    UnitsPerProduct: ['UnitsPerProduct', 'Units Per Product', 'Pack Size', 'Quantity', 'Qty'],
    PriceType: ['PriceType', 'Price Type', 'Pricing Type'],
    PricePerSqm: ['PricePerSqm', 'Price Per Sqm', 'Sqm Price'],
    FixedPrice: ['FixedPrice', 'Fixed Price', 'Price', 'Selling Price', 'Unit Price', 'Amount'],
    MinPrice: ['MinPrice', 'Minimum Price'],
    DesignFee: ['DesignFee', 'Design Fee'],
    PolePrice: ['PolePrice', 'Pole Price'],
    InstallationFee: ['InstallationFee', 'Installation Fee'],
    Aliases: ['Aliases', 'Alias', 'Keywords', 'Tags'],
    MinOrderQty: ['MinOrderQty', 'Min Order Qty', 'Minimum Order Qty', 'Minimum Qty', 'Min Qty'],
    UnitPricing: ['UnitPricing', 'Unit Pricing', 'Pricing Unit', 'Rate Type'],
    RequiresArtwork: ['RequiresArtwork', 'Requires Artwork'],
    PolesAvailable: ['PolesAvailable', 'Poles Available']
};

function normalizeCsvHeader(header) {
    return String(header || '')
        .replace(/^\uFEFF/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function toNumber(value, fallback = 0) {
    const normalized = String(value ?? '')
        .replace(/[^\d,.-]+/g, '')
        .replace(/,/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeValue(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function getFirstMappedValue(row, fieldName) {
    const normalizedRow = Object.entries(row || {}).reduce((acc, [key, value]) => {
        acc[normalizeCsvHeader(key)] = value;
        return acc;
    }, {});
    const aliases = PRODUCT_FIELD_ALIASES[fieldName] || [fieldName];
    for (const alias of aliases) {
        const value = normalizedRow[normalizeCsvHeader(alias)];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return normalizeValue(value);
        }
    }
    return '';
}

function normalizeProductRecord(row) {
    const product = {
        ID: getFirstMappedValue(row, 'ID'),
        SKU: getFirstMappedValue(row, 'SKU'),
        Category: getFirstMappedValue(row, 'Category'),
        Subcategory: getFirstMappedValue(row, 'Subcategory'),
        Name: getFirstMappedValue(row, 'Name'),
        Size: getFirstMappedValue(row, 'Size'),
        Finish: getFirstMappedValue(row, 'Finish'),
        SingleOrDoubleSided: getFirstMappedValue(row, 'SingleOrDoubleSided'),
        UnitsPerProduct: getFirstMappedValue(row, 'UnitsPerProduct'),
        PriceType: getFirstMappedValue(row, 'PriceType').toLowerCase(),
        PricePerSqm: getFirstMappedValue(row, 'PricePerSqm'),
        FixedPrice: getFirstMappedValue(row, 'FixedPrice'),
        MinPrice: getFirstMappedValue(row, 'MinPrice'),
        DesignFee: getFirstMappedValue(row, 'DesignFee'),
        PolePrice: getFirstMappedValue(row, 'PolePrice'),
        InstallationFee: getFirstMappedValue(row, 'InstallationFee'),
        Aliases: getFirstMappedValue(row, 'Aliases'),
        MinOrderQty: getFirstMappedValue(row, 'MinOrderQty'),
        UnitPricing: getFirstMappedValue(row, 'UnitPricing'),
        RequiresArtwork: getFirstMappedValue(row, 'RequiresArtwork'),
        PolesAvailable: getFirstMappedValue(row, 'PolesAvailable')
    };

    if (!product.Name) product.Name = product.Subcategory || product.Category || 'Product';
    if (product.PriceType !== 'sqm' && product.PriceType !== 'fixed') {
        product.PriceType = product.PricePerSqm ? 'sqm' : 'fixed';
    }
    return product;
}

function parseProductsCsvStream(stream) {
    return new Promise((resolve, reject) => {
        const rows = [];
        stream
            .pipe(csv({ mapHeaders: ({ header }) => String(header || '').replace(/^\uFEFF/, '').trim() }))
            .on('data', (row) => rows.push(row))
            .on('error', reject)
            .on('end', () => {
                const normalizedProducts = rows.map((row) => normalizeProductRecord(row)).filter(Boolean);
                const validProducts = normalizedProducts.filter((product) => {
                    const hasName = Boolean((product.Name || '').trim());
                    const hasPrice = toNumber(product.FixedPrice) > 0 || toNumber(product.PricePerSqm) > 0;
                    return hasName && hasPrice;
                });
                if (validProducts.length === 0) {
                    reject(new Error('No valid product rows found in CSV.'));
                    return;
                }
                resolve(validProducts);
            });
    });
}

function validateProductCsvHeaders(content = '') {
    const firstLine = String(content || '').split(/\r?\n/)[0] || '';
    const headerCells = firstLine
        .split(',')
        .map((cell) => normalizeCsvHeader(cell.trim().replace(/^"|"$/g, '')));
    const hasId = headerCells.includes(normalizeCsvHeader('ID'));
    const hasName = headerCells.includes(normalizeCsvHeader('Name')) || headerCells.includes(normalizeCsvHeader('Subcategory'));
    const hasPrice =
        headerCells.includes(normalizeCsvHeader('FixedPrice')) ||
        headerCells.includes(normalizeCsvHeader('PricePerSqm')) ||
        headerCells.includes(normalizeCsvHeader('Price'));
    return {
        ok: hasId && hasName && hasPrice,
        hasId,
        hasName,
        hasPrice
    };
}

function parseProductsCsvContent(content = '') {
    return parseProductsCsvStream(Readable.from([String(content || '')]));
}

module.exports = {
    PRODUCT_FIELD_ALIASES,
    normalizeCsvHeader,
    normalizeProductRecord,
    parseProductsCsvStream,
    parseProductsCsvContent,
    validateProductCsvHeaders
};
