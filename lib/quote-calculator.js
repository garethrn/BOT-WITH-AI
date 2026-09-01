const { normalizeValue } = require('./product-lookup');

function toNumber(value, fallback = 0) {
    const normalized = String(value ?? '')
        .replace(/[^\d,.-]+/g, '')
        .replace(/,/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toBooleanYes(value) {
    const normalized = normalizeValue(value);
    return ['yes', 'true', '1', 'y'].includes(normalized);
}

function parseFixedPricingRule(product = {}) {
    const rawUnits = String(product.UnitsPerProduct || '').trim();
    const parsedUnits = parseInt((rawUnits.match(/\d+/) || [])[0], 10);
    const units = Number.isFinite(parsedUnits) && parsedUnits > 0 ? parsedUnits : 1;
    const minOrderQty = toNumber(product.MinOrderQty, 0);
    const modeHint = normalizeValue(product.UnitPricing);
    const isUnitMode = /^(?:>=|>)\s*\d+/.test(rawUnits) || modeHint === 'unit';
    const minQty = isUnitMode ? (minOrderQty > 0 ? minOrderQty : units) : 0;
    return { mode: isUnitMode ? 'unit' : 'pack', unitsPerPack: units, minQty };
}

function selectBestFixedRow(rows = [], quantity = 1) {
    if (!rows.length) return null;
    const normalizedQty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    const sorted = [...rows].sort((a, b) => {
        const ra = parseFixedPricingRule(a);
        const rb = parseFixedPricingRule(b);
        return ra.unitsPerPack - rb.unitsPerPack;
    });
    const direct = sorted.find((row) => {
        const rule = parseFixedPricingRule(row);
        return rule.mode === 'pack' && rule.unitsPerPack >= normalizedQty;
    });
    if (direct) return direct;
    return sorted[sorted.length - 1];
}

function calculateQuote(product, input = {}) {
    if (!product) return { ok: false, code: 'unknown_product', message: 'Unknown product.' };
    const priceType = normalizeValue(product.PriceType);
    const quantity = Number.isFinite(input.quantity) && input.quantity > 0 ? input.quantity : null;
    if (!quantity) return { ok: false, code: 'invalid_quantity', message: 'Please provide a valid quantity.' };

    let areaSqm = 0;
    let base = 0;
    let minApplied = false;

    if (priceType === 'sqm') {
        const widthMm = Number(input.widthMm);
        const heightMm = Number(input.heightMm);
        if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
            return { ok: false, code: 'invalid_dimensions', message: 'Please provide valid width and height.' };
        }
        const pricePerSqm = toNumber(product.PricePerSqm);
        if (!(pricePerSqm > 0)) {
            return { ok: false, code: 'empty_price_fields', message: 'This product is missing sqm pricing in the CSV.' };
        }
        areaSqm = (widthMm / 1000) * (heightMm / 1000);
        const calculatedBase = areaSqm * pricePerSqm;
        const minPrice = toNumber(product.MinPrice);
        const basePerItem = minPrice > 0 ? Math.max(calculatedBase, minPrice) : calculatedBase;
        minApplied = minPrice > 0 && basePerItem === minPrice && minPrice > calculatedBase;
        base = basePerItem * quantity;
    } else {
        const fixedPrice = toNumber(product.FixedPrice);
        if (!(fixedPrice > 0)) {
            return { ok: false, code: 'empty_price_fields', message: 'This product is missing fixed pricing in the CSV.' };
        }
        const rule = parseFixedPricingRule(product);
        if (rule.mode === 'unit') {
            if (rule.minQty > 0 && quantity < rule.minQty) {
                return {
                    ok: false,
                    code: 'below_min_order',
                    message: `Minimum order quantity is ${rule.minQty}.`
                };
            }
            base = fixedPrice * quantity;
        } else {
            const packs = Math.ceil(quantity / rule.unitsPerPack);
            base = packs * fixedPrice;
        }
    }

    const requiresArtwork = toBooleanYes(product.RequiresArtwork);
    const hasArtwork = typeof input.hasArtwork === 'boolean' ? input.hasArtwork : true;
    const designFee = (!hasArtwork && requiresArtwork) ? toNumber(product.DesignFee) : 0;

    const polesRequested = Boolean(input.polesRequested);
    const polesAvailable = toBooleanYes(product.PolesAvailable) || toNumber(product.PolesAvailable) > 0 || toNumber(product.PolePrice) > 0;
    const poleFee = polesRequested && polesAvailable ? toNumber(product.PolePrice) : 0;

    const installationRequested = Boolean(input.installationRequested);
    const installationFee = installationRequested ? toNumber(product.InstallationFee) : 0;

    const total = base + designFee + poleFee + installationFee;
    return {
        ok: true,
        product,
        priceType: priceType === 'sqm' ? 'sqm' : 'fixed',
        quantity,
        areaSqm,
        minApplied,
        base,
        designFee,
        poleFee,
        installationFee,
        total
    };
}

module.exports = {
    toNumber,
    parseFixedPricingRule,
    selectBestFixedRow,
    calculateQuote
};
