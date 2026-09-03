const {
    normalizeValue,
    normalizeSidedOption,
    matchProducts,
    getDistinctFieldValues,
    findMatchingOption,
    filterRows
} = require('./product-lookup');
const { calculateQuote, selectBestFixedRow } = require('./quote-calculator');

const STATES = {
    AWAITING_PRODUCT: 'awaiting_product',
    AWAITING_SIZE: 'awaiting_size',
    AWAITING_FINISH: 'awaiting_finish',
    AWAITING_SIDED_OPTION: 'awaiting_sided_option',
    AWAITING_ARTWORK_STATUS: 'awaiting_artwork_status',
    AWAITING_DIMENSIONS: 'awaiting_dimensions',
    AWAITING_QUANTITY: 'awaiting_quantity',
    QUOTE_READY: 'quote_ready'
};

function parseUnitsPerProduct(value) {
    const match = String(value || '').match(/\d+/);
    const parsed = match ? parseInt(match[0], 10) : 1;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function isGreetingMessage(text = '') {
    return /^(hi|hii|hello|hey|good morning|good afternoon|good evening|menu)\b/i.test(String(text || '').trim());
}

function parseDimensionsFromText(text = '') {
    const raw = String(text || '').toLowerCase();
    const directMatch = raw.match(/(\d{1,6}(?:\.\d{1,3})?)\s{0,4}(mm|cm|m)?\s{0,4}[x×]\s{0,4}(\d{1,6}(?:\.\d{1,3})?)\s{0,4}(mm|cm|m)?/i);
    if (!directMatch) return null;
    const convert = (value, unit) => {
        const num = parseFloat(value);
        if (!Number.isFinite(num) || num <= 0) return null;
        const normalizedUnit = String(unit || 'mm').toLowerCase();
        if (normalizedUnit === 'm') return num * 1000;
        if (normalizedUnit === 'cm') return num * 10;
        return num;
    };
    const widthMm = convert(directMatch[1], directMatch[2]);
    const heightMm = convert(directMatch[3], directMatch[4] || directMatch[2]);
    if (!widthMm || !heightMm) return null;
    return { widthMm, heightMm };
}

function parseQuantityFromText(text = '') {
    const raw = String(text || '');
    const withoutDimensions = raw.replace(/\b\d{1,6}(?:\.\d{1,3})?\s{0,4}(?:mm|cm|m)?\s{0,4}[x×]\s{0,4}\d{1,6}(?:\.\d{1,3})?\s{0,4}(?:mm|cm|m)?\b/gi, ' ');
    const explicit = withoutDimensions.match(/\b(?:qty|quantity|units|pieces|copies|cards|labels|banners|stickers)\s*[:\-]?\s*(\d{1,6})\b/i);
    if (explicit) {
        const parsed = parseInt(explicit[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const prefixed = withoutDimensions.match(/\b(\d{1,6})\s*(?:units|pieces|copies|cards|labels|banners|stickers)\b/i);
    if (prefixed) {
        const parsed = parseInt(prefixed[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const standalone = withoutDimensions.match(/\b(\d{1,6})\b/);
    if (standalone) {
        const parsed = parseInt(standalone[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function parseArtworkStatus(text = '') {
    const normalized = normalizeValue(text);
    if (!normalized) return null;
    if (/\b(no|not|dont|don't|need design|no artwork|not ready|not print ready)\b/.test(normalized)) return false;
    if (/\b(yes|have artwork|print ready|ready artwork|artwork ready)\b/.test(normalized)) return true;
    return null;
}

function createState() {
    return {
        step: STATES.AWAITING_PRODUCT,
        productQuery: '',
        candidates: [],
        selection: {
            size: '',
            finish: '',
            sided: '',
            hasArtwork: null,
            dimensions: null,
            quantity: null,
            polesRequested: false,
            installationRequested: false
        },
        askCounts: {}
    };
}

function buildGuidedProductOptions(products = [], limit = 5) {
    const groups = new Map();
    for (const row of Array.isArray(products) ? products : []) {
        const productName = String(row?.Name || row?.Subcategory || row?.Category || '').trim();
        if (!productName) continue;
        if (!groups.has(productName)) groups.set(productName, []);
        groups.get(productName).push(row);
    }
    const items = [];
    for (const [name, rows] of groups.entries()) {
        const qtyValues = [...new Set(rows
            .filter((row) => normalizeValue(row.PriceType) === 'fixed')
            .map((row) => String(row.UnitsPerProduct || '').trim())
            .filter(Boolean))];
        const qtyText = qtyValues.length
            ? ` | qty options: ${qtyValues.slice(0, 4).join(', ')}`
            : '';
        items.push(`- ${name}${qtyText}`);
        if (items.length >= limit) break;
    }
    return items.join('\n');
}

function buildFreshQuoteStartMessage(products = []) {
    const options = buildGuidedProductOptions(products, 5);
    return [
        'Great, let’s start fresh 👋',
        'Please tell me the product you want quoted, and I’ll guide you step by step.',
        options ? `Available options right now:\n${options}` : ''
    ].filter(Boolean).join('\n\n');
}

function isQuoteIntent(text = '') {
    return /\b(quote|price|pricing|cost|print|sign|signage|banner|card|cards|flyer|sticker|label|design)\b/i.test(text);
}

function isGeneralConversationInterrupt(text = '') {
    const normalized = normalizeValue(text);
    if (!normalized) return false;
    if (isQuoteIntent(normalized)) return false;
    return /\b(thanks|thank you|hello|hi|hey|how are you|where are you|location|address|hours|open|close|contact|call|email|website|whatsapp)\b/i.test(normalized);
}

function extractProductQuery(text = '') {
    const normalized = normalizeValue(text);
    return normalized
        .replace(/\b(hi|hello|please|quote|price|pricing|cost|need|want|for|a|an|the|i|me|my|can|you|help|with|to)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function recordAsk(state, step) {
    state.askCounts[step] = (state.askCounts[step] || 0) + 1;
    return state.askCounts[step];
}

function parseBooleanIntent(text = '', positiveWords = [], negativeWords = []) {
    const normalized = normalizeValue(text);
    if (!normalized) return null;
    if (negativeWords.some((word) => normalized.includes(word))) return false;
    if (positiveWords.some((word) => normalized.includes(word))) return true;
    return null;
}

function chooseProductRow(rows, selection) {
    if (!rows.length) return null;
    const byType = selection.dimensions
        ? filterRows(rows, { priceType: 'sqm' })
        : filterRows(rows, { priceType: 'fixed' });
    const candidates = byType.length ? byType : rows;
    const fixedRows = filterRows(candidates, { priceType: 'fixed' });
    if (fixedRows.length && selection.quantity) {
        return selectBestFixedRow(fixedRows, selection.quantity);
    }
    return candidates[0];
}

function formatQuoteBreakdown(result, selection) {
    const product = result.product || {};
    const name = product.Name || product.Subcategory || product.Category || 'Product';
    const lines = [
        `Quote ready for *${name}*`,
        product.Size ? `Size: ${product.Size}` : '',
        product.Finish ? `Finish/Material: ${product.Finish}` : '',
        product.SingleOrDoubleSided ? `Sided option: ${product.SingleOrDoubleSided}` : '',
        `Artwork: ${selection.hasArtwork ? 'Print-ready supplied' : 'Design required'}`,
        result.priceType === 'sqm' ? `Area: ${result.areaSqm.toFixed(3)} m² per unit` : '',
        `Quantity: ${result.quantity}`,
        `Base price: R${result.base.toFixed(2)}`,
        result.designFee > 0 ? `Design fee: R${result.designFee.toFixed(2)}` : '',
        result.poleFee > 0 ? `Pole fee: R${result.poleFee.toFixed(2)}` : '',
        result.installationFee > 0 ? `Installation fee: R${result.installationFee.toFixed(2)}` : '',
        `*Total: R${result.total.toFixed(2)}*`
    ];
    return lines.filter(Boolean).join('\n');
}

function handleQuoteConversationMessage({ jid, text, products, stateStore }) {
    const input = String(text || '').trim();
    if (!input) return { handled: false, reply: null };
    const hasSession = stateStore.has(jid);
    const state = stateStore.get(jid) || createState();
    const mustKeepProductFlow = [
        STATES.AWAITING_PRODUCT,
        STATES.AWAITING_SIZE,
        STATES.AWAITING_FINISH,
        STATES.AWAITING_SIDED_OPTION,
        STATES.AWAITING_ARTWORK_STATUS
    ].includes(state.step);
    if (hasSession && !mustKeepProductFlow && isGeneralConversationInterrupt(input)) return { handled: false, reply: null };
    if (!hasSession && !isQuoteIntent(input)) return { handled: false, reply: null };
    const normalized = normalizeValue(input);
    if (/\b(reset|start over|new quote|restart)\b/.test(normalized)) {
        stateStore.set(jid, createState());
        return { handled: true, reply: 'Sure — let’s start fresh. What product would you like a quote for?' };
    }

    const installationIntent = parseBooleanIntent(normalized, ['install', 'installation', 'with install'], ['no install', 'without install', 'no installation']);
    if (installationIntent !== null) state.selection.installationRequested = installationIntent;
    const polesIntent = parseBooleanIntent(normalized, ['with pole', 'with poles', 'pole included', 'need poles'], ['without pole', 'without poles', 'no poles']);
    if (polesIntent !== null) state.selection.polesRequested = polesIntent;

    const loopLimit = 2;
    let guard = 0;
    while (guard < 10) {
        guard += 1;
        if (state.step === STATES.AWAITING_PRODUCT) {
            if (!state.productQuery) {
                state.productQuery = extractProductQuery(input);
            }
            if (!state.productQuery) {
                const count = recordAsk(state, state.step);
                if (count > loopLimit) {
                    stateStore.set(jid, createState());
                    return { handled: true, reply: 'I’m not getting the product details yet. Please share the product name (for example: business cards, ACM signs, flyers).' };
                }
                stateStore.set(jid, state);
                return { handled: true, reply: 'What product would you like a quote for?' };
            }
            const match = matchProducts(products, state.productQuery);
            if (!match.rows.length) {
                state.productQuery = '';
                state.candidates = [];
                state.step = STATES.AWAITING_PRODUCT;
                stateStore.set(jid, state);
                return { handled: true, reply: 'I could not match that product in our catalog. Please share the product name again.' };
            }
            if (match.ambiguous) {
                state.productQuery = '';
                stateStore.set(jid, state);
                return { handled: true, reply: `I found multiple product groups. Please specify one: ${match.familyNames.slice(0, 4).join(', ')}.` };
            }
            state.candidates = match.rows;
            state.step = STATES.AWAITING_SIZE;
            continue;
        }

        if (state.step === STATES.AWAITING_SIZE) {
            const sizeOptions = getDistinctFieldValues(state.candidates, 'Size').filter((option) => !['custom', 'free size'].includes(option.value));
            if (sizeOptions.length > 1 && !state.selection.size) {
                const picked = findMatchingOption(input, sizeOptions);
                if (picked) {
                    state.selection.size = picked.display;
                    const filtered = filterRows(state.candidates, { size: picked.display });
                    if (!filtered.length) {
                        stateStore.set(jid, state);
                        return { handled: true, reply: 'That size is not available for this product. Please choose one of our listed sizes.' };
                    }
                    state.candidates = filtered;
                } else {
                    const count = recordAsk(state, state.step);
                    if (count > loopLimit) {
                        stateStore.set(jid, createState());
                        return { handled: true, reply: 'Let’s restart so I can quote accurately. Please share the product name and size together.' };
                    }
                    stateStore.set(jid, state);
                    return { handled: true, reply: `Which size would you like? Example options: ${sizeOptions.slice(0, 4).map((item) => item.display).join(', ')}.` };
                }
            }
            state.step = STATES.AWAITING_FINISH;
            continue;
        }

        if (state.step === STATES.AWAITING_FINISH) {
            const finishOptions = getDistinctFieldValues(state.candidates, 'Finish');
            if (finishOptions.length > 1 && !state.selection.finish) {
                const picked = findMatchingOption(input, finishOptions);
                if (picked) {
                    state.selection.finish = picked.display;
                    const filtered = filterRows(state.candidates, { finish: picked.display });
                    if (!filtered.length) {
                        stateStore.set(jid, state);
                        return { handled: true, reply: 'That finish/material is not available for this product. Please choose one from the available options.' };
                    }
                    state.candidates = filtered;
                } else {
                    const count = recordAsk(state, state.step);
                    if (count > loopLimit) {
                        stateStore.set(jid, createState());
                        return { handled: true, reply: 'Let’s restart quickly. Please send the product and finish/material in one message.' };
                    }
                    stateStore.set(jid, state);
                    return { handled: true, reply: `Which finish/material would you like? Options: ${finishOptions.slice(0, 4).map((item) => item.display).join(', ')}.` };
                }
            }
            state.step = STATES.AWAITING_SIDED_OPTION;
            continue;
        }

        if (state.step === STATES.AWAITING_SIDED_OPTION) {
            const sideOptions = getDistinctFieldValues(state.candidates, 'SingleOrDoubleSided');
            if (sideOptions.length > 1 && !state.selection.sided) {
                const parsedSide = normalizeSidedOption(input);
                const picked = sideOptions.find((item) => item.value === parsedSide) || findMatchingOption(input, sideOptions);
                if (picked) {
                    state.selection.sided = picked.display;
                    const filtered = filterRows(state.candidates, { sided: picked.display });
                    if (!filtered.length) {
                        stateStore.set(jid, state);
                        return { handled: true, reply: 'That sided option is not available for this product. Please choose single sided or double sided.' };
                    }
                    state.candidates = filtered;
                } else {
                    const count = recordAsk(state, state.step);
                    if (count > loopLimit) {
                        stateStore.set(jid, createState());
                        return { handled: true, reply: 'Let’s start over so I can avoid mistakes. Please send product details with sided option.' };
                    }
                    stateStore.set(jid, state);
                    return { handled: true, reply: 'Do you want single sided or double sided?' };
                }
            }
            state.step = STATES.AWAITING_ARTWORK_STATUS;
            continue;
        }

        if (state.step === STATES.AWAITING_ARTWORK_STATUS) {
            if (state.selection.hasArtwork === null) {
                const parsed = parseArtworkStatus(input);
                if (typeof parsed === 'boolean') {
                    state.selection.hasArtwork = parsed;
                } else {
                    const count = recordAsk(state, state.step);
                    if (count > loopLimit) {
                        stateStore.set(jid, createState());
                        return { handled: true, reply: 'Please restart your quote and include whether you have print-ready artwork.' };
                    }
                    stateStore.set(jid, state);
                    return { handled: true, reply: 'Do you already have print-ready artwork?' };
                }
            }
            const hasSqm = state.candidates.some((row) => normalizeValue(row.PriceType) === 'sqm');
            state.step = hasSqm ? STATES.AWAITING_DIMENSIONS : STATES.AWAITING_QUANTITY;
            continue;
        }

        if (state.step === STATES.AWAITING_DIMENSIONS) {
            if (!state.selection.dimensions) {
                const parsed = parseDimensionsFromText(input);
                if (!parsed) {
                    const count = recordAsk(state, state.step);
                    if (count > loopLimit) {
                        stateStore.set(jid, createState());
                        return { handled: true, reply: 'I still need valid dimensions to continue. Please restart and send product + size in mm (example 1200x600).' };
                    }
                    stateStore.set(jid, state);
                    return { handled: true, reply: 'Please share width and height in mm (example: 1200x600).' };
                }
                state.selection.dimensions = parsed;
            }
            state.step = STATES.AWAITING_QUANTITY;
            continue;
        }

        if (state.step === STATES.AWAITING_QUANTITY) {
            if (!state.selection.quantity) {
                const qty = parseQuantityFromText(input);
                if (!qty) {
                    const count = recordAsk(state, state.step);
                    if (count > loopLimit) {
                        stateStore.set(jid, createState());
                        return { handled: true, reply: 'Please restart the quote and include quantity so I can calculate correctly.' };
                    }
                    const qtyOptions = [...new Set(state.candidates
                        .filter((row) => normalizeValue(row.PriceType) === 'fixed')
                        .map((row) => String(row.UnitsPerProduct || '').trim())
                        .filter(Boolean))];
                    const qtyPrompt = qtyOptions.length
                        ? `What quantity should I quote? Available quantity options: ${qtyOptions.slice(0, 5).join(', ')}.`
                        : 'What quantity should I quote?';
                    stateStore.set(jid, state);
                    return { handled: true, reply: qtyPrompt };
                }
                state.selection.quantity = qty;
            }
            state.step = STATES.QUOTE_READY;
            continue;
        }

        if (state.step === STATES.QUOTE_READY) {
            const selectedRows = filterRows(state.candidates, {
                size: state.selection.size,
                finish: state.selection.finish,
                sided: state.selection.sided
            });
            const candidates = selectedRows.length ? selectedRows : state.candidates;
            if (!candidates.length) {
                stateStore.set(jid, createState());
                return { handled: true, reply: 'I could not confirm a valid product variant from the catalog. Please restart with product details.' };
            }
            const chosen = chooseProductRow(candidates, state.selection);
            if (!chosen) {
                stateStore.set(jid, createState());
                return { handled: true, reply: 'I found ambiguous product matches. Please share more specific product details.' };
            }

            const result = calculateQuote(chosen, {
                quantity: state.selection.quantity,
                widthMm: state.selection.dimensions?.widthMm,
                heightMm: state.selection.dimensions?.heightMm,
                hasArtwork: state.selection.hasArtwork,
                polesRequested: state.selection.polesRequested,
                installationRequested: state.selection.installationRequested
            });
            if (!result.ok) {
                if (result.code === 'below_min_order') {
                    state.step = STATES.AWAITING_QUANTITY;
                    state.selection.quantity = null;
                    stateStore.set(jid, state);
                    return { handled: true, reply: `${result.message} Please share your quantity.` };
                }
                if (result.code === 'invalid_dimensions') {
                    state.step = STATES.AWAITING_DIMENSIONS;
                    state.selection.dimensions = null;
                    stateStore.set(jid, state);
                    return { handled: true, reply: 'Those dimensions are invalid. Please share width x height in mm.' };
                }
                stateStore.set(jid, createState());
                return { handled: true, reply: result.message || 'I could not calculate this quote due to missing CSV fields.' };
            }
            stateStore.set(jid, createState());
            return { handled: true, reply: formatQuoteBreakdown(result, state.selection) };
        }
    }

    stateStore.set(jid, createState());
    return { handled: true, reply: 'Let’s restart your quote to avoid repetition. What product would you like a quote for?' };
}

module.exports = {
    STATES,
    createState,
    handleQuoteConversationMessage,
    isGreetingMessage,
    buildFreshQuoteStartMessage
};
