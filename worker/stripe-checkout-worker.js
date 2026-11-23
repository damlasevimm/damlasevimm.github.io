/**
 * L'Atelier Damla — Stripe Checkout, Automatic Inventory & Order Numbers Worker
 * Zero dependencies — copy-paste directly into the Cloudflare Worker editor.
 *
 * Required Cloudflare Worker bindings / secrets (Settings -> Variables and Secrets / Bindings):
 *   1. Secret:       STRIPE_SECRET_KEY      (sk_test_... or sk_live_...)
 *   2. Secret:       STRIPE_WEBHOOK_SECRET  (whsec_... from Stripe Developers -> Webhooks)
 *   3. KV Namespace: INVENTORY              (Cloudflare KV namespace storing stock & order records)
 *
 * Endpoints:
 *   GET  /                        -> Health & config status check
 *   GET  /inventory               -> Live stock counts for all catalog items
 *   GET  /order?session_id=cs_... -> Order receipt + sequential order number (LAD-1001) for /success
 *   POST /create-checkout-session -> Validates live stock & creates Stripe Checkout session
 *   POST /stripe-webhook          -> Verifies Stripe signature, assigns order number & decrements stock
 */

const SITE_URL = 'https://latelierdamla.com';
const ORDER_PREFIX = 'LAD';
const ORDER_START_NUMBER = 1000; // First order becomes LAD-1001

const ALLOWED_ORIGINS = new Set([
    'https://latelierdamla.com',
    'https://www.latelierdamla.com',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
]);

// Server-side source of truth for prices (in EUR cents) and initial fallback stock.
// Once a product ID is added to Cloudflare KV (INVENTORY) or purchased, KV overrides defaultStock.
const CATALOG = {
    'ocean-cup-01': {
        name: 'No. 01 — The Ocean Cup',
        description: 'Hand-thrown speckled stoneware vessel with satin glaze.',
        unitAmount: 3000, // €30.00
        defaultStock: 3,
        image: `${SITE_URL}/images/ocean_cup.jpeg`
    },
    'shore-cup-02': {
        name: 'No. 02 — Shore Cup',
        description: 'Wheel-thrown stoneware cup with overlapping volcanic shore inspired glazes.',
        unitAmount: 3000, // €30.00
        defaultStock: 3,
        image: `${SITE_URL}/images/shore_cup.jpeg`
    },
    'meadow-cups-03': {
        name: 'No. 03 — The Meadow Cups',
        description: 'Sculptural cups shaped from raw stoneware.',
        unitAmount: 3000, // €30.00
        defaultStock: 3,
        image: `${SITE_URL}/images/green_cups.jpeg`
    },
    'cotton-candy-plate-04': {
        name: 'No. 04 — Cotton Candy Plate',
        description: 'Hand-built dessert plate.',
        unitAmount: 3500, // €35.00
        defaultStock: 2,
        image: `${SITE_URL}/images/colored_plate.jpeg`
    }
};

// Countries you ship to (ISO 3166-1 alpha-2 codes)
const SHIPPING_COUNTRIES = [
    'AT', 'BE', 'BG', 'CA', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE',
    'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT',
    'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI',
    'SK', 'TR', 'US'
];

// Shipping options shown in Stripe Checkout (amounts in EUR cents)
const SHIPPING_OPTIONS = [
    {
        displayName: 'Standard Tracked Shipping',
        amount: 800, // €8.00 — set to 0 for free shipping
        minDays: 3,
        maxDays: 7
    }
];

function corsHeaders(origin) {
    const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : SITE_URL;
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
}

function jsonResponse(payload, status, origin, extraHeaders = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...corsHeaders(origin),
            ...extraHeaders
        }
    });
}

async function getProductStock(env, productId) {
    const product = CATALOG[productId];
    if (!product) return 0;

    if (env.INVENTORY) {
        const raw = await env.INVENTORY.get(productId);
        if (raw !== null) {
            const parsed = parseInt(raw, 10);
            if (Number.isInteger(parsed) && parsed >= 0) {
                return parsed;
            }
        }
    }

    return product.defaultStock;
}

async function getAllStock(env) {
    const entries = await Promise.all(
        Object.keys(CATALOG).map(async id => [id, await getProductStock(env, id)])
    );
    return Object.fromEntries(entries);
}

async function nextOrderNumber(env) {
    if (!env.INVENTORY) {
        return `${ORDER_PREFIX}-${Date.now().toString().slice(-6)}`;
    }
    const raw = await env.INVENTORY.get('order:counter');
    const current = raw !== null ? parseInt(raw, 10) : ORDER_START_NUMBER;
    const next = Number.isInteger(current) && current >= ORDER_START_NUMBER ? current + 1 : ORDER_START_NUMBER + 1;
    await env.INVENTORY.put('order:counter', String(next));
    return `${ORDER_PREFIX}-${next}`;
}

// Constant-time hex string comparison for Stripe webhook signature verification
function timingSafeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader || !secret) return false;

    const parts = signatureHeader.split(',').reduce((acc, part) => {
        const [k, v] = part.split('=');
        if (k && v) {
            acc[k.trim()] = acc[k.trim()] || [];
            acc[k.trim()].push(v.trim());
        }
        return acc;
    }, {});

    const timestamp = parts.t && parts.t[0];
    const signatures = parts.v1 || [];
    if (!timestamp || signatures.length === 0) return false;

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
    if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signedPayload = `${timestamp}.${rawBody}`;
    const macBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const expectedHex = Array.from(new Uint8Array(macBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    return signatures.some(sig => timingSafeEqualHex(sig, expectedHex));
}

/**
 * Idempotently finalizes a paid Checkout Session:
 * - Assigns sequential order number (LAD-1001, LAD-1002, ...)
 * - Decrements KV stock once per session
 * - Saves order number & items summary onto Stripe PaymentIntent (so it shows in Stripe Dashboard)
 * - Stores the order record in KV under order:session:{id} and order:number:{LAD-XXXX}
 */
async function finalizePaidSession(env, session) {
    const sessionOrderKey = `order:session:${session.id}`;
    const processedKey = `processed:${session.id}`;

    // If already finalized, return the saved order record immediately
    if (env.INVENTORY) {
        const existingRaw = await env.INVENTORY.get(sessionOrderKey);
        if (existingRaw) {
            try {
                return { order: JSON.parse(existingRaw), duplicate: true };
            } catch {
                // Continue if malformed
            }
        }
    }

    // Fetch finalized line items from Stripe (captures any quantity edits made on Stripe Checkout)
    const lineItemsRes = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100&expand[]=data.price.product`,
        {
            headers: {
                'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`
            }
        }
    );

    const lineItemsData = await lineItemsRes.json();
    if (!lineItemsRes.ok) {
        throw new Error(lineItemsData?.error?.message || 'Failed to fetch Stripe line items.');
    }

    const lineItems = (lineItemsData.data || []).map(li => {
        const catalogId = li.price?.product?.metadata?.catalog_id || null;
        return {
            id: catalogId,
            name: li.description || li.price?.product?.name || 'Ceramic Piece',
            quantity: parseInt(li.quantity, 10) || 1,
            amountTotal: typeof li.amount_total === 'number' ? li.amount_total : 0
        };
    });

    // Decrement stock only if this session hasn't already decremented stock
    const alreadyDecremented = env.INVENTORY ? Boolean(await env.INVENTORY.get(processedKey)) : false;
    const updatedStock = {};

    if (env.INVENTORY && !alreadyDecremented) {
        const purchasedCounts = {};
        for (const item of lineItems) {
            if (item.id && CATALOG[item.id] && item.quantity > 0) {
                purchasedCounts[item.id] = (purchasedCounts[item.id] || 0) + item.quantity;
            }
        }

        for (const [catalogId, qty] of Object.entries(purchasedCounts)) {
            const current = await getProductStock(env, catalogId);
            const nextStock = Math.max(0, current - qty);
            await env.INVENTORY.put(catalogId, String(nextStock));
            updatedStock[catalogId] = nextStock;
        }

        await env.INVENTORY.put(processedKey, new Date().toISOString(), {
            expirationTtl: 60 * 60 * 24 * 30
        });
    }

    const orderNumber = await nextOrderNumber(env);
    const shipping = session.shipping_details || session.collected_information?.shipping_details || null;
    const address = shipping?.address || null;

    const orderRecord = {
        orderNumber,
        sessionId: session.id,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        createdAt: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        status: 'paid',
        currency: session.currency || 'eur',
        amountSubtotal: session.amount_subtotal || 0,
        amountShipping: session.total_details?.amount_shipping || 0,
        amountTotal: session.amount_total || 0,
        customerName: shipping?.name || session.customer_details?.name || '',
        customerEmail: session.customer_details?.email || '',
        customerPhone: session.customer_details?.phone || '',
        shippingAddress: address ? {
            line1: address.line1 || '',
            line2: address.line2 || '',
            city: address.city || '',
            state: address.state || '',
            postalCode: address.postal_code || '',
            country: address.country || ''
        } : null,
        items: lineItems
    };

    // Tag the Stripe PaymentIntent so "Order LAD-1001 — L'Atelier Damla" appears in Stripe Dashboard
    if (orderRecord.paymentIntentId) {
        const itemsSummary = lineItems.map(i => `${i.name} x${i.quantity}`).join(', ').slice(0, 480);
        const piParams = new URLSearchParams();
        piParams.append('description', `Order ${orderNumber} — L'Atelier Damla`);
        piParams.append('metadata[order_number]', orderNumber);
        piParams.append('metadata[items]', itemsSummary);

        await fetch(
            `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(orderRecord.paymentIntentId)}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: piParams.toString()
            }
        ).catch(() => {});
    }

    if (env.INVENTORY) {
        const serialized = JSON.stringify(orderRecord);
        await Promise.all([
            env.INVENTORY.put(sessionOrderKey, serialized),
            env.INVENTORY.put(`order:number:${orderNumber}`, serialized)
        ]);
    }

    return { order: orderRecord, updatedStock, duplicate: false };
}

function publicOrderReceipt(order) {
    return {
        orderNumber: order.orderNumber,
        createdAt: order.createdAt,
        currency: order.currency,
        amountSubtotal: order.amountSubtotal,
        amountShipping: order.amountShipping,
        amountTotal: order.amountTotal,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        shippingCity: order.shippingAddress?.city || '',
        shippingCountry: order.shippingAddress?.country || '',
        items: (order.items || []).map(item => ({
            name: item.name,
            quantity: item.quantity,
            amountTotal: item.amountTotal
        }))
    };
}

async function handleGetOrder(request, env, origin) {
    if (!env.STRIPE_SECRET_KEY) {
        return jsonResponse({ error: 'Missing STRIPE_SECRET_KEY.' }, 500, origin);
    }

    const url = new URL(request.url);
    const sessionId = (url.searchParams.get('session_id') || '').trim();

    if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(sessionId)) {
        return jsonResponse({ error: 'Invalid session_id.' }, 400, origin);
    }

    // Fast path: already saved in KV
    if (env.INVENTORY) {
        const cached = await env.INVENTORY.get(`order:session:${sessionId}`);
        if (cached) {
            try {
                return jsonResponse({ order: publicOrderReceipt(JSON.parse(cached)) }, 200, origin);
            } catch {
                // Fall through to Stripe lookup
            }
        }
    }

    // Fetch session from Stripe to verify payment before finalizing
    const sessionRes = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
        {
            headers: {
                'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`
            }
        }
    );

    const session = await sessionRes.json();
    if (!sessionRes.ok) {
        return jsonResponse({ error: 'Order session not found.' }, 404, origin);
    }

    if (session.payment_status !== 'paid') {
        return jsonResponse({ error: 'Payment is still processing.', paymentStatus: session.payment_status }, 202, origin);
    }

    try {
        const { order } = await finalizePaidSession(env, session);
        return jsonResponse({ order: publicOrderReceipt(order) }, 200, origin);
    } catch (err) {
        return jsonResponse({ error: err.message || 'Could not load order details.' }, 500, origin);
    }
}

async function handleStripeWebhook(request, env, origin) {
    if (!env.STRIPE_WEBHOOK_SECRET) {
        return jsonResponse({ error: 'Missing STRIPE_WEBHOOK_SECRET.' }, 500, origin);
    }
    if (!env.STRIPE_SECRET_KEY) {
        return jsonResponse({ error: 'Missing STRIPE_SECRET_KEY.' }, 500, origin);
    }
    if (!env.INVENTORY) {
        return jsonResponse({ error: 'Missing INVENTORY KV binding.' }, 500, origin);
    }

    const rawBody = await request.text();
    const sigHeader = request.headers.get('Stripe-Signature');
    const isValid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);

    if (!isValid) {
        return jsonResponse({ error: 'Invalid Stripe signature.' }, 400, origin);
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return jsonResponse({ error: 'Invalid webhook payload.' }, 400, origin);
    }

    const isPaidEvent =
        (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') ||
        event.type === 'checkout.session.async_payment_succeeded';

    if (!isPaidEvent) {
        return jsonResponse({ received: true, ignored: event.type }, 200, origin);
    }

    try {
        const result = await finalizePaidSession(env, event.data.object);
        return jsonResponse({
            received: true,
            duplicate: result.duplicate,
            orderNumber: result.order.orderNumber,
            updatedStock: result.updatedStock || {}
        }, 200, origin);
    } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to finalize order.' }, 500, origin);
    }
}

async function handleCreateCheckoutSession(request, env, origin) {
    if (!env.STRIPE_SECRET_KEY) {
        return jsonResponse({ error: 'Server missing STRIPE_SECRET_KEY secret.' }, 500, origin);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON request body.' }, 400, origin);
    }

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) {
        return jsonResponse({ error: 'Your bag is empty.' }, 400, origin);
    }

    // Merge duplicate product IDs in the request
    const mergedQuantities = {};
    for (const item of rawItems) {
        const id = item && typeof item.id === 'string' ? item.id : '';
        const quantity = Number.isInteger(item?.quantity) ? item.quantity : parseInt(item?.quantity, 10);

        if (!CATALOG[id]) {
            return jsonResponse({ error: `Unknown product: ${id}` }, 400, origin);
        }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
            return jsonResponse({ error: `Invalid quantity for ${CATALOG[id].name}` }, 400, origin);
        }
        mergedQuantities[id] = (mergedQuantities[id] || 0) + quantity;
    }

    // Check live stock before creating the Stripe Checkout session
    const liveStock = await getAllStock(env);
    for (const [id, quantity] of Object.entries(mergedQuantities)) {
        const available = liveStock[id];
        if (available <= 0) {
            return jsonResponse(
                { error: `${CATALOG[id].name} is currently sold out.`, stock: liveStock },
                409,
                origin
            );
        }
        if (quantity > available) {
            return jsonResponse(
                { error: `Only ${available} left for ${CATALOG[id].name}.`, stock: liveStock },
                409,
                origin
            );
        }
    }

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`);

    const safeCancelPath = typeof body.cancelPath === 'string' && body.cancelPath.startsWith('/')
        ? body.cancelPath
        : '/shop';
    params.append('cancel_url', `${SITE_URL}${safeCancelPath}`);

    let lineIndex = 0;
    for (const [id, quantity] of Object.entries(mergedQuantities)) {
        const product = CATALOG[id];
        const available = liveStock[id];

        params.append(`line_items[${lineIndex}][price_data][currency]`, 'eur');
        params.append(`line_items[${lineIndex}][price_data][unit_amount]`, String(product.unitAmount));
        params.append(`line_items[${lineIndex}][price_data][product_data][name]`, product.name);
        params.append(`line_items[${lineIndex}][price_data][product_data][description]`, product.description);
        params.append(`line_items[${lineIndex}][price_data][product_data][images][0]`, product.image);
        params.append(`line_items[${lineIndex}][price_data][product_data][metadata][catalog_id]`, id);
        params.append(`line_items[${lineIndex}][quantity]`, String(quantity));

        if (available > 1) {
            params.append(`line_items[${lineIndex}][adjustable_quantity][enabled]`, 'true');
            params.append(`line_items[${lineIndex}][adjustable_quantity][minimum]`, '1');
            params.append(`line_items[${lineIndex}][adjustable_quantity][maximum]`, String(Math.min(available, 20)));
        }

        lineIndex++;
    }

    // Collect shipping address & phone number
    SHIPPING_COUNTRIES.forEach((code, idx) => {
        params.append(`shipping_address_collection[allowed_countries][${idx}]`, code);
    });
    params.append('phone_number_collection[enabled]', 'true');

    // Shipping rates
    SHIPPING_OPTIONS.forEach((opt, idx) => {
        params.append(`shipping_options[${idx}][shipping_rate_data][type]`, 'fixed_amount');
        params.append(`shipping_options[${idx}][shipping_rate_data][fixed_amount][amount]`, String(opt.amount));
        params.append(`shipping_options[${idx}][shipping_rate_data][fixed_amount][currency]`, 'eur');
        params.append(`shipping_options[${idx}][shipping_rate_data][display_name]`, opt.displayName);
        params.append(`shipping_options[${idx}][shipping_rate_data][delivery_estimate][minimum][unit]`, 'business_day');
        params.append(`shipping_options[${idx}][shipping_rate_data][delivery_estimate][minimum][value]`, String(opt.minDays));
        params.append(`shipping_options[${idx}][shipping_rate_data][delivery_estimate][maximum][unit]`, 'business_day');
        params.append(`shipping_options[${idx}][shipping_rate_data][delivery_estimate][maximum][value]`, String(opt.maxDays));
    });

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });

    const stripeData = await stripeRes.json();

    if (!stripeRes.ok) {
        return jsonResponse(
            { error: stripeData?.error?.message || 'Stripe rejected the checkout session.' },
            stripeRes.status,
            origin
        );
    }

    return jsonResponse({ url: stripeData.url }, 200, origin);
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        // Health check when visiting the Worker URL in a browser
        if (request.method === 'GET' && path === '/') {
            return jsonResponse({
                ok: true,
                service: "L'Atelier Damla Stripe Checkout",
                stripeConfigured: Boolean(env.STRIPE_SECRET_KEY),
                inventoryKvBound: Boolean(env.INVENTORY),
                webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET)
            }, 200, origin);
        }

        // Public live stock endpoint for index.html and shop.html
        if (request.method === 'GET' && path === '/inventory') {
            const stock = await getAllStock(env);
            return jsonResponse({ stock }, 200, origin);
        }

        // Public order receipt lookup for success.html (?session_id=cs_...)
        if (request.method === 'GET' && path === '/order') {
            return handleGetOrder(request, env, origin);
        }

        // Stripe webhook endpoint for automatic stock decrements & order numbers
        if (request.method === 'POST' && path === '/stripe-webhook') {
            return handleStripeWebhook(request, env, origin);
        }

        // Create Stripe Checkout session
        if (request.method === 'POST' && (path === '/create-checkout-session' || path === '/')) {
            return handleCreateCheckoutSession(request, env, origin);
        }

        return jsonResponse({ error: 'Not found' }, 404, origin);
    }
};
