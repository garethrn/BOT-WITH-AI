function normalizeValue(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\u00d7/g, 'x')
        .replace(/[^a-z0-9\sx.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeSize(value) {
    return normalizeValue(value)
        .replace(/\s*x\s*/g, ' x ')
        .replace(/\s*mm\b/g, 'mm')
        .replace(/\s*cm\b/g, 'cm')
        .replace(/\s*m\b/g, 'm')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeSidedOption(value) {
    const normalized = normalizeValue(value);
    if (!normalized) return '';
    if (/(double|both|2)\s*-?\s*sided?/.test(normalized)) return 'double sided';
    if (/(single|one|1)\s*-?\s*sided?/.test(normalized)) return 'single sided';
    return normalized;
}

function normalizeProductRow(row = {}) {
    return {
        ...row,
        _normalized: {
            name: normalizeValue(row.Name),
            category: normalizeValue(row.Category),
            subcategory: normalizeValue(row.Subcategory),
            subSubcategory: normalizeValue(row.SubSubcategory),
            subSubSubcategory: normalizeValue(row.SubSubSubcategory),
            size: normalizeSize(row.Size),
            finish: normalizeValue(row.Finish),
            sided: normalizeSidedOption(row.SingleOrDoubleSided),
            aliases: normalizeValue(row.Aliases),
            unitsPerProduct: normalizeValue(row.UnitsPerProduct)
        }
    };
}

function normalizeProducts(products = []) {
    return products.map((row) => normalizeProductRow(row));
}

function tokenize(value) {
    return normalizeValue(value).split(' ').filter((token) => token.length >= 2);
}

function scoreProduct(row, queryText) {
    const query = normalizeValue(queryText);
    if (!query) return 0;
    const {
        aliases,
        name,
        category,
        subcategory,
        subSubcategory,
        subSubSubcategory,
        size,
        finish,
        sided,
        unitsPerProduct
    } = row._normalized || normalizeProductRow(row)._normalized;
    const blob = [aliases, name, category, subcategory, subSubcategory, subSubSubcategory, size, finish, sided, unitsPerProduct].join(' ');
    const tokens = tokenize(query);

    let score = 0;
    const orderedFields = [
        { value: aliases, exact: 95, partial: 42 },
        { value: name, exact: 85, partial: 38 },
        { value: category, exact: 50, partial: 22 },
        { value: subcategory, exact: 48, partial: 21 },
        { value: subSubcategory, exact: 46, partial: 20 },
        { value: subSubSubcategory, exact: 44, partial: 19 },
        { value: size, exact: 36, partial: 16 },
        { value: finish, exact: 34, partial: 15 },
        { value: sided, exact: 32, partial: 14 },
        { value: unitsPerProduct, exact: 18, partial: 8 }
    ];

    for (const field of orderedFields) {
        const value = String(field.value || '').trim();
        if (!value) continue;
        if (value === query) score += field.exact;
        else if (value.includes(query) || query.includes(value)) score += field.partial;
    }

    for (const token of tokens) {
        if (blob.includes(token)) score += 4;
        if (name.includes(token)) score += 3;
        if (subcategory.includes(token)) score += 2;
        if (subSubcategory.includes(token)) score += 2;
        if (subSubSubcategory.includes(token)) score += 2;
    }
    return score;
}

function familyKey(row) {
    const n = row._normalized || normalizeProductRow(row)._normalized;
    return `${n.name}|${n.category}|${n.subcategory}`;
}

function matchProducts(products = [], queryText = '') {
    const normalizedRows = normalizeProducts(products);
    const ranked = normalizedRows
        .map((row) => ({ row, score: scoreProduct(row, queryText) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

    if (!ranked.length) return { rows: [], ambiguous: false, familyNames: [] };

    const topScore = ranked[0].score;
    const selected = ranked
        .filter((item) => item.score >= Math.max(8, topScore - 6))
        .map((item) => item.row);

    const families = new Map();
    for (const row of selected) {
        const key = familyKey(row);
        if (!families.has(key)) families.set(key, row.Name || row.Subcategory || row.Category || 'Product');
    }
    const familyNames = Array.from(families.values());
    const ambiguous = familyNames.length > 3 && topScore < 50;
    return { rows: selected, ambiguous, familyNames };
}

function getDistinctFieldValues(rows = [], fieldName) {
    const map = new Map();
    for (const row of rows) {
        const raw = String(row[fieldName] || '').trim();
        if (!raw) continue;
        let normalized = normalizeValue(raw);
        if (fieldName === 'Size') normalized = normalizeSize(raw);
        if (fieldName === 'SingleOrDoubleSided') normalized = normalizeSidedOption(raw);
        if (!normalized) continue;
        if (!map.has(normalized)) map.set(normalized, raw);
    }
    return Array.from(map.entries()).map(([value, display]) => ({ value, display }));
}

function findMatchingOption(text = '', options = []) {
    const normalizedText = normalizeValue(text);
    if (!normalizedText || !options.length) return null;
    const sorted = [...options].sort((a, b) => b.value.length - a.value.length);
    for (const option of sorted) {
        if (!option.value) continue;
        if (normalizedText.includes(option.value) || option.value.includes(normalizedText)) return option;
    }
    return null;
}

function filterRows(rows = [], criteria = {}) {
    const size = criteria.size ? normalizeSize(criteria.size) : '';
    const finish = criteria.finish ? normalizeValue(criteria.finish) : '';
    const sided = criteria.sided ? normalizeSidedOption(criteria.sided) : '';
    const priceType = criteria.priceType ? normalizeValue(criteria.priceType) : '';

    return rows.filter((row) => {
        const normalized = row._normalized || normalizeProductRow(row)._normalized;
        if (size && normalized.size !== size) return false;
        if (finish && normalized.finish !== finish) return false;
        if (sided && normalized.sided && normalized.sided !== sided) return false;
        if (priceType && normalizeValue(row.PriceType) !== priceType) return false;
        return true;
    });
}

module.exports = {
    normalizeValue,
    normalizeSize,
    normalizeSidedOption,
    normalizeProductRow,
    normalizeProducts,
    matchProducts,
    getDistinctFieldValues,
    findMatchingOption,
    filterRows
};
