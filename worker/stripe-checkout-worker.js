/**
 * L'Atelier Damla — Stripe Checkout, Automatic Inventory & Order Numbers Worker
 * Zero dependencies — copy-paste directly into the Cloudflare Worker editor.
 *
 * Required Cloudflare Worker bindings / secrets (Settings -> Variables and Secrets / Bindings):
 *   1. Secret:       STRIPE_SECRET_KEY      (sk_test_... or sk_live_...)
 *   2. Secret:       STRIPE_WEBHOOK_SECRET  (whsec_... from Stripe Developers -> Webhooks)
 *   3. KV Namespace: INVENTORY              (Cloudflare KV namespace for item stock counts only)
 *   4. KV Namespace: ORDERS                 (Cloudflare KV namespace for order numbers & records)
 *   5. KV Namespace: PROCESSED              (Cloudflare KV namespace for processed/emailed/session keys)
 *   6. Secret:       RESEND_API_KEY         (re_... from https://resend.com — enables automatic emails)
 *   7. Optional Var: EMAIL_FROM             (defaults to "L'Atelier Damla <orders@latelierdamla.com>")
 *
 * Endpoints:
 *   GET  /                        -> Health & config status check
 *   GET  /inventory               -> Live stock counts for all catalog items
 *   GET  /order?session_id=cs_... -> Order receipt + sequential order number (LAD-1001) for /success
 *   POST /create-checkout-session -> Validates live stock & creates Stripe Checkout session
 *   POST /stripe-webhook          -> Verifies Stripe signature, assigns order number, decrements stock & emails
 */

const SITE_URL = 'https://latelierdamla.com';
const STUDIO_EMAIL = 'info@latelierdamla.com';
const DEFAULT_FROM_EMAIL = "L'Atelier Damla <orders@latelierdamla.com>";
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

// Shipping rules (amounts in EUR cents)
const FREE_SHIPPING_THRESHOLD_CENTS = 5000; // Free shipping for orders higher than €50.00
const STANDARD_SHIPPING = {
    displayName: 'Standard Tracked Shipping',
    amount: 800, // €8.00
    minDays: 3,
    maxDays: 7
};
const FREE_SHIPPING = {
    displayName: 'Free Tracked Shipping (Orders over €50)',
    amount: 0,
    minDays: 3,
    maxDays: 7
};

function getOrdersKv(env) {
    return env.ORDERS || env.INVENTORY || null;
}

function getProcessedKv(env) {
    return env.PROCESSED || env.ORDERS || env.INVENTORY || null;
}

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
    const ordersKv = getOrdersKv(env);
    if (!ordersKv) {
        return `${ORDER_PREFIX}-${Date.now().toString().slice(-6)}`;
    }
    const raw = await ordersKv.get('order:counter');
    const current = raw !== null ? parseInt(raw, 10) : ORDER_START_NUMBER;
    const next = Number.isInteger(current) && current >= ORDER_START_NUMBER ? current + 1 : ORDER_START_NUMBER + 1;
    await ordersKv.put('order:counter', String(next));
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

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatMoneyCents(cents, currency = 'eur') {
    return new Intl.NumberFormat('en-IE', {
        style: 'currency',
        currency: (currency || 'eur').toUpperCase()
    }).format((cents || 0) / 100);
}

function formatShippingLines(address) {
    if (!address) return [];
    const cityLine = [address.postalCode, address.city, address.state].filter(Boolean).join(' ');
    return [address.line1, address.line2, cityLine, address.country].filter(Boolean);
}

function buildCustomerOrderEmail(order) {
    const firstName = (order.customerName || '').trim().split(/\s+/)[0] || 'there';
    const orderDate = new Date(order.createdAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });

    const itemRowsHtml = (order.items || []).map(item => `
        <tr>
            <td style="padding:10px 0;border-bottom:1px solid #E2E6FE;font-size:14px;color:#161722;">
                ${escapeHtml(item.name)} <span style="color:#5C5F73;">&times; ${item.quantity}</span>
            </td>
            <td style="padding:10px 0;border-bottom:1px solid #E2E6FE;font-size:14px;color:#161722;text-align:right;white-space:nowrap;">
                ${escapeHtml(formatMoneyCents(item.amountTotal, order.currency))}
            </td>
        </tr>
    `).join('');

    const shippingLines = formatShippingLines(order.shippingAddress);
    const shippingHtml = shippingLines.length
        ? `<div style="margin-top:22px;padding-top:18px;border-top:1px solid #E2E6FE;">
               <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#7B89EB;margin-bottom:6px;">Shipping Address</div>
               <div style="font-size:14px;line-height:1.6;color:#5C5F73;">
                   ${order.customerName ? `${escapeHtml(order.customerName)}<br>` : ''}${shippingLines.map(escapeHtml).join('<br>')}
               </div>
           </div>`
        : '';

    const subtotalStr = formatMoneyCents(order.amountSubtotal, order.currency);
    const shippingStr = order.amountShipping > 0 ? formatMoneyCents(order.amountShipping, order.currency) : 'Free';
    const totalStr = formatMoneyCents(order.amountTotal, order.currency);

    const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px 12px;background-color:#F3F5FF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#161722;">
  <div style="max-width:580px;margin:0 auto;background:#FFFFFF;border:1px solid #9BA7FA;">
    <div style="padding:28px 32px;background:#F3F5FF;border-bottom:1px solid #E2E6FE;text-align:center;">
      <div style="font-size:12px;letter-spacing:0.26em;text-transform:uppercase;color:#161722;font-weight:600;">L'ATELIER DAMLA</div>
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#7B89EB;margin-top:6px;">Order Confirmation</div>
    </div>

    <div style="padding:32px;">
      <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:28px;color:#161722;">
        Thank you, ${escapeHtml(firstName)}.
      </h1>
      <p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#5C5F73;">
        Your order has been received and confirmed. Each ceramic piece is packed with care in our studio—we will send you tracking details as soon as it ships.
      </p>

      <div style="display:inline-block;padding:8px 16px;background:#F3F5FF;border:1px solid #9BA7FA;border-radius:50px;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#161722;margin-bottom:22px;">
        Order <strong style="color:#7B89EB;">#${escapeHtml(order.orderNumber)}</strong> &middot; ${escapeHtml(orderDate)}
      </div>

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        ${itemRowsHtml}
        <tr>
          <td style="padding:12px 0 4px;font-size:13px;color:#5C5F73;">Subtotal</td>
          <td style="padding:12px 0 4px;font-size:13px;color:#5C5F73;text-align:right;">${escapeHtml(subtotalStr)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0 10px;font-size:13px;color:#5C5F73;">Shipping</td>
          <td style="padding:4px 0 10px;font-size:13px;color:#5C5F73;text-align:right;">${escapeHtml(shippingStr)}</td>
        </tr>
        <tr>
          <td style="padding:12px 0 0;border-top:1px solid #9BA7FA;font-size:15px;font-weight:600;color:#161722;">Total Paid</td>
          <td style="padding:12px 0 0;border-top:1px solid #9BA7FA;font-size:15px;font-weight:600;color:#161722;text-align:right;">${escapeHtml(totalStr)}</td>
        </tr>
      </table>

      ${shippingHtml}

      <p style="margin:26px 0 0;font-size:13px;line-height:1.6;color:#5C5F73;">
        Have a question about your order? Simply reply to this email or write to
        <a href="mailto:${STUDIO_EMAIL}" style="color:#7B89EB;">${STUDIO_EMAIL}</a> with order number <strong>#${escapeHtml(order.orderNumber)}</strong>.
      </p>
    </div>

    <div style="padding:18px 32px;background:#9BA7FA;color:#FFFFFF;text-align:center;font-size:11px;letter-spacing:0.14em;">
      L'ATELIER DAMLA &middot; <a href="${SITE_URL}" style="color:#FFFFFF;text-decoration:none;">latelierdamla.com</a>
    </div>
  </div>
</body>
</html>`;

    const itemsText = (order.items || [])
        .map(i => `- ${i.name} x${i.quantity}: ${formatMoneyCents(i.amountTotal, order.currency)}`)
        .join('\n');

    const text = [
        `Thank you for your order from L'Atelier Damla!`,
        ``,
        `Order Number: #${order.orderNumber}`,
        `Date: ${orderDate}`,
        ``,
        `Items:`,
        itemsText,
        ``,
        `Subtotal: ${subtotalStr}`,
        `Shipping: ${shippingStr}`,
        `Total Paid: ${totalStr}`,
        shippingLines.length ? `\nShipping Address:\n${order.customerName ? order.customerName + '\n' : ''}${shippingLines.join('\n')}` : '',
        ``,
        `We will send tracking details as soon as your pieces ship.`,
        `Questions? Reply to this email or contact ${STUDIO_EMAIL} with #${order.orderNumber}.`
    ].filter(Boolean).join('\n');

    return {
        subject: `Order Confirmed — #${order.orderNumber} | L'Atelier Damla`,
        html,
        text
    };
}

function buildStudioOrderEmail(order) {
    const shippingLines = formatShippingLines(order.shippingAddress);
    const itemsListHtml = (order.items || [])
        .map(i => `<li><strong>${escapeHtml(i.name)}</strong> &times; ${i.quantity} (${escapeHtml(formatMoneyCents(i.amountTotal, order.currency))})</li>`)
        .join('');

    const stripeLink = order.paymentIntentId
        ? `<p style="margin-top:16px;"><a href="https://dashboard.stripe.com/payments/${encodeURIComponent(order.paymentIntentId)}" style="color:#7B89EB;">View Payment in Stripe Dashboard &rarr;</a></p>`
        : '';

    const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#161722;line-height:1.6;">
            <h2>New Order #${escapeHtml(order.orderNumber)}</h2>
            <p><strong>Total Paid:</strong> ${escapeHtml(formatMoneyCents(order.amountTotal, order.currency))}</p>
            <h3>Items to Pack</h3>
            <ul>${itemsListHtml}</ul>
            <h3>Customer</h3>
            <p>
                Name: ${escapeHtml(order.customerName || '—')}<br>
                Email: ${escapeHtml(order.customerEmail || '—')}<br>
                Phone: ${escapeHtml(order.customerPhone || '—')}
            </p>
            <h3>Shipping Address</h3>
            <p>${shippingLines.length ? shippingLines.map(escapeHtml).join('<br>') : '—'}</p>
            ${stripeLink}
        </div>
    `;

    const text = [
        `New Order #${order.orderNumber}`,
        `Total Paid: ${formatMoneyCents(order.amountTotal, order.currency)}`,
        ``,
        `Items:`,
        ...(order.items || []).map(i => `- ${i.name} x${i.quantity}`),
        ``,
        `Customer: ${order.customerName || '—'} (${order.customerEmail || '—'}, ${order.customerPhone || '—'})`,
        `Shipping: ${shippingLines.join(', ') || '—'}`
    ].join('\n');

    return {
        subject: `New Order #${order.orderNumber} (${formatMoneyCents(order.amountTotal, order.currency)})`,
        html,
        text
    };
}

async function sendViaResend(env, payload) {
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    return res.ok;
}

async function sendOrderEmails(env, order) {
    if (!env.RESEND_API_KEY) {
        return { customerSent: false, studioSent: false, skipped: true };
    }

    const processedKv = getProcessedKv(env);
    const emailKey = `emailed:${order.sessionId}`;
    if (processedKv && await processedKv.get(emailKey)) {
        return { customerSent: false, studioSent: false, duplicate: true };
    }

    const from = env.EMAIL_FROM || DEFAULT_FROM_EMAIL;
    let customerSent = false;
    let studioSent = false;

    if (order.customerEmail) {
        const customerMsg = buildCustomerOrderEmail(order);
        customerSent = await sendViaResend(env, {
            from,
            to: [order.customerEmail],
            reply_to: STUDIO_EMAIL,
            subject: customerMsg.subject,
            html: customerMsg.html,
            text: customerMsg.text
        }).catch(() => false);
    }

    const studioMsg = buildStudioOrderEmail(order);
    studioSent = await sendViaResend(env, {
        from,
        to: [STUDIO_EMAIL],
        reply_to: order.customerEmail || STUDIO_EMAIL,
        subject: studioMsg.subject,
        html: studioMsg.html,
        text: studioMsg.text
    }).catch(() => false);

    if (processedKv && (customerSent || studioSent)) {
        await processedKv.put(emailKey, new Date().toISOString(), {
            expirationTtl: 60 * 60 * 24 * 30
        });
    }

    return { customerSent, studioSent };
}

/**
 * Idempotently finalizes a paid Checkout Session:
 * - Assigns sequential order number (LAD-1001, LAD-1002, ...) in ORDERS KV
 * - Decrements item stock once per session in INVENTORY KV
 * - Tracks processed/emailed/session lookup keys in PROCESSED KV (auto-expiring after 30 days)
 * - Saves order number & items summary onto Stripe PaymentIntent (so it shows in Stripe Dashboard)
 */
async function finalizePaidSession(env, session) {
    const ordersKv = getOrdersKv(env);
    const processedKv = getProcessedKv(env);
    const sessionOrderKey = `session:${session.id}`;
    const processedKey = `processed:${session.id}`;

    // If already finalized, return the saved order record immediately
    if (processedKv) {
        const existingRaw = await processedKv.get(sessionOrderKey);
        if (existingRaw) {
            try {
                return { order: JSON.parse(existingRaw), duplicate: true };
            } catch {
                // Continue if malformed
            }
        }
    }

    // Fetch finalized line items from Stripe
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

    // Decrement stock in INVENTORY KV only once per session (tracked in PROCESSED KV)
    const alreadyDecremented = processedKv ? Boolean(await processedKv.get(processedKey)) : false;
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

        if (processedKv) {
            await processedKv.put(processedKey, new Date().toISOString(), {
                expirationTtl: 60 * 60 * 24 * 30
            });
        }
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

    const serialized = JSON.stringify(orderRecord);
    const writes = [];
    if (ordersKv) {
        writes.push(ordersKv.put(`order:number:${orderNumber}`, serialized));
    }
    if (processedKv) {
        writes.push(processedKv.put(sessionOrderKey, serialized, {
            expirationTtl: 60 * 60 * 24 * 30
        }));
    }
    if (writes.length) {
        await Promise.all(writes);
    }

    // Send branded confirmation email to customer + order alert to studio (via Resend)
    const emailStatus = await sendOrderEmails(env, orderRecord);

    return { order: orderRecord, updatedStock, emailStatus, duplicate: false };
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

    // Fast path: already saved in PROCESSED KV
    const processedKv = getProcessedKv(env);
    if (processedKv) {
        const cached = await processedKv.get(`session:${sessionId}`);
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
    let subtotalCents = 0;

    for (const [id, quantity] of Object.entries(mergedQuantities)) {
        const product = CATALOG[id];
        subtotalCents += product.unitAmount * quantity;

        params.append(`line_items[${lineIndex}][price_data][currency]`, 'eur');
        params.append(`line_items[${lineIndex}][price_data][unit_amount]`, String(product.unitAmount));
        params.append(`line_items[${lineIndex}][price_data][product_data][name]`, product.name);
        params.append(`line_items[${lineIndex}][price_data][product_data][description]`, product.description);
        params.append(`line_items[${lineIndex}][price_data][product_data][images][0]`, product.image);
        params.append(`line_items[${lineIndex}][price_data][product_data][metadata][catalog_id]`, id);
        params.append(`line_items[${lineIndex}][quantity]`, String(quantity));

        lineIndex++;
    }

    // Collect shipping address & phone number
    SHIPPING_COUNTRIES.forEach((code, idx) => {
        params.append(`shipping_address_collection[allowed_countries][${idx}]`, code);
    });
    params.append('phone_number_collection[enabled]', 'true');

    // Free shipping for orders higher than €50.00, otherwise €8.00 standard tracked shipping
    const shippingOption = subtotalCents > FREE_SHIPPING_THRESHOLD_CENTS ? FREE_SHIPPING : STANDARD_SHIPPING;
    params.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    params.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(shippingOption.amount));
    params.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'eur');
    params.append('shipping_options[0][shipping_rate_data][display_name]', shippingOption.displayName);
    params.append('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]', 'business_day');
    params.append('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]', String(shippingOption.minDays));
    params.append('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]', 'business_day');
    params.append('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]', String(shippingOption.maxDays));

    // Clear customer guidance directly on Stripe's hosted checkout page
    params.append(
        'custom_text[shipping_address][message]',
        'Each ceramic piece is carefully hand-wrapped in protective packaging and dispatched tracked within 2–3 business days.'
    );
    params.append(
        'custom_text[submit][message]',
        "Once payment completes, you'll be redirected back to L'Atelier Damla with your order number and email confirmation."
    );

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
                ordersKvBound: Boolean(env.ORDERS),
                processedKvBound: Boolean(env.PROCESSED),
                webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
                emailConfigured: Boolean(env.RESEND_API_KEY)
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
