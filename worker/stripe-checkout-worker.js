/**
 * L'Atelier Damla — Stripe Checkout Cloudflare Worker (Zero Dependencies)
 *
 * Setup:
 * 1. Create a free Cloudflare Worker at https://dash.cloudflare.com -> Workers & Pages -> Create Worker
 * 2. Paste this file into the Worker editor and click Deploy.
 * 3. Under Worker -> Settings -> Variables and Secrets, add an encrypted Secret:
 *      Name:  STRIPE_SECRET_KEY
 *      Value: sk_test_... (for testing) or sk_live_... (for real payments)
 * 4. Copy your Worker URL (e.g. https://latelier-checkout.yourname.workers.dev)
 *    and paste it into CHECKOUT_API_URL at the top of cart.js.
 */

const SITE_URL = 'https://latelierdamla.com';

const ALLOWED_ORIGINS = new Set([
    'https://latelierdamla.com',
    'https://www.latelierdamla.com',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
]);

// Server-side source of truth for prices (in EUR cents) so buyers cannot tamper with prices.
// Whenever you add a new product to shop.html / index.html, add its ID & price here too.
const CATALOG = {
    'ocean-cup-01': {
        name: 'No. 01 — The Ocean Cup',
        description: 'Hand-thrown speckled stoneware vessel with satin glaze.',
        unitAmount: 3000, // €30.00
        image: `${SITE_URL}/images/ocean_cup.jpeg`
    },
    'shore-cup-02': {
        name: 'No. 02 — Shore Cup',
        description: 'Wheel-thrown stoneware cup with overlapping volcanic shore inspired glazes.',
        unitAmount: 3000, // €30.00
        image: `${SITE_URL}/images/shore_cup.jpeg`
    },
    'meadow-cups-03': {
        name: 'No. 03 — The Meadow Cups',
        description: 'Sculptural cups shaped from raw stoneware.',
        unitAmount: 3000, // €30.00
        image: `${SITE_URL}/images/green_cups.jpeg`
    },
    'cotton-candy-plate-04': {
        name: 'No. 04 — Cotton Candy Plate',
        description: 'Hand-built dessert plate.',
        unitAmount: 3500, // €35.00
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

// Optional shipping options shown in Stripe Checkout (amounts in EUR cents)
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
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
}

function jsonResponse(payload, status, origin) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(origin)
        }
    });
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        const url = new URL(request.url);
        if (request.method !== 'POST' || (url.pathname !== '/create-checkout-session' && url.pathname !== '/')) {
            return jsonResponse({ error: 'Not found' }, 404, origin);
        }

        if (!env.STRIPE_SECRET_KEY) {
            return jsonResponse({ error: 'Server missing STRIPE_SECRET_KEY secret.' }, 500, origin);
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResponse({ error: 'Invalid JSON request body.' }, 400, origin);
        }

        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) {
            return jsonResponse({ error: 'Your bag is empty.' }, 400, origin);
        }

        const params = new URLSearchParams();
        params.append('mode', 'payment');
        params.append('success_url', `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`);

        const safeCancelPath = typeof body.cancelPath === 'string' && body.cancelPath.startsWith('/')
            ? body.cancelPath
            : '/shop';
        params.append('cancel_url', `${SITE_URL}${safeCancelPath}`);

        // Validate & build Stripe line items from server-side catalog
        let lineIndex = 0;
        for (const item of items) {
            const product = CATALOG[item.id];
            const quantity = Number.isInteger(item.quantity) ? item.quantity : parseInt(item.quantity, 10);

            if (!product) {
                return jsonResponse({ error: `Unknown product: ${item.id}` }, 400, origin);
            }
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
                return jsonResponse({ error: `Invalid quantity for ${product.name}` }, 400, origin);
            }

            params.append(`line_items[${lineIndex}][price_data][currency]`, 'eur');
            params.append(`line_items[${lineIndex}][price_data][unit_amount]`, String(product.unitAmount));
            params.append(`line_items[${lineIndex}][price_data][product_data][name]`, product.name);
            params.append(`line_items[${lineIndex}][price_data][product_data][description]`, product.description);
            params.append(`line_items[${lineIndex}][price_data][product_data][images][0]`, product.image);
            params.append(`line_items[${lineIndex}][quantity]`, String(quantity));
            params.append(`line_items[${lineIndex}][adjustable_quantity][enabled]`, 'true');
            params.append(`line_items[${lineIndex}][adjustable_quantity][minimum]`, '1');
            params.append(`line_items[${lineIndex}][adjustable_quantity][maximum]`, '20');
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
};
