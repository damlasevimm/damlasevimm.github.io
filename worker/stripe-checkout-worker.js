/**
 * L'Atelier Damla — Stripe Checkout, D1 SQL Inventory, Orders & Emails Worker
 * Zero dependencies — copy-paste directly into the Cloudflare Worker editor.
 *
 * Required Cloudflare Worker bindings / secrets (Settings -> Bindings / Variables and Secrets):
 *   1. D1 Database:  DB                     (Cloudflare D1 database initialized with worker/schema.sql)
 *   2. Secret:       STRIPE_SECRET_KEY      (sk_test_... or sk_live_...)
 *   3. Secret:       STRIPE_WEBHOOK_SECRET  (whsec_... from Stripe Developers -> Webhooks)
 *   4. Secret:       RESEND_API_KEY         (re_... from https://resend.com — enables automatic emails)
 *   5. Optional Var: EMAIL_FROM             (defaults to "L'Atelier Damla <orders@latelierdamla.com>")
 *
 * Endpoints:
 *   GET  /                        -> Health & D1/Stripe/Email status check
 *   GET  /inventory               -> Instant live stock counts from D1 `products` table
 *   GET  /order?session_id=cs_... -> Order receipt + sequential order number (LAD-1001) for /success
 *   POST /create-checkout-session -> Validates live D1 stock & creates Stripe Checkout session
 *   POST /stripe-webhook          -> Verifies Stripe signature, creates D1 order, decrements stock & emails
 */

const SITE_URL = 'https://latelierdamla.com';
const STUDIO_EMAIL = 'info@latelierdamla.com';
const DEFAULT_FROM_EMAIL = "L'Atelier Damla <orders@latelierdamla.com>";

const ORDER_PREFIX = 'LAD';
const ORDER_BASE_OFFSET = 1000; // Order id 1 -> LAD-1001, id 2 -> LAD-1002, ...

const ALLOWED_ORIGINS = new Set([
    'https://latelierdamla.com',
    'https://www.latelierdamla.com',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
]);

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

// ===== HTTP Helpers =====

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

// ===== D1 Database Helpers =====

async function getCatalogMap(env) {
    const { results } = await env.DB
        .prepare('SELECT id, name, description, unit_amount, image, stock FROM products')
        .all();

    const map = {};
    for (const row of results || []) {
        map[row.id] = {
            id: row.id,
            name: row.name,
            description: row.description || '',
            unitAmount: Number(row.unit_amount),
            image: row.image || '',
            stock: Math.max(0, Number(row.stock) || 0)
        };
    }
    return map;
}

async function getAllStock(env) {
    const { results } = await env.DB
        .prepare('SELECT id, stock FROM products')
        .all();

    const stock = {};
    for (const row of results || []) {
        stock[row.id] = Math.max(0, Number(row.stock) || 0);
    }
    return stock;
}

async function getOrderBySessionId(env, sessionId) {
    const orderRow = await env.DB
        .prepare('SELECT * FROM orders WHERE stripe_session_id = ?')
        .bind(sessionId)
        .first();

    if (!orderRow) return null;

    const { results: itemRows } = await env.DB
        .prepare('SELECT product_id, name, quantity, amount_total FROM order_items WHERE order_id = ? ORDER BY id ASC')
        .bind(orderRow.id)
        .all();

    let shippingAddress = null;
    if (orderRow.shipping_address_json) {
        try {
            shippingAddress = JSON.parse(orderRow.shipping_address_json);
        } catch {
            shippingAddress = null;
        }
    }

    return {
        id: orderRow.id,
        orderNumber: orderRow.order_number || `${ORDER_PREFIX}-${ORDER_BASE_OFFSET + orderRow.id}`,
        sessionId: orderRow.stripe_session_id,
        paymentIntentId: orderRow.payment_intent_id,
        status: orderRow.status,
        trackingNumber: orderRow.tracking_number,
        createdAt: orderRow.created_at,
        currency: orderRow.currency,
        amountSubtotal: Number(orderRow.amount_subtotal) || 0,
        amountShipping: Number(orderRow.amount_shipping) || 0,
        amountTotal: Number(orderRow.amount_total) || 0,
        customerName: orderRow.customer_name || '',
        customerEmail: orderRow.customer_email || '',
        customerPhone: orderRow.customer_phone || '',
        shippingAddress,
        emailedAt: orderRow.emailed_at,
        items: (itemRows || []).map(row => ({
            id: row.product_id,
            name: row.name,
            quantity: Number(row.quantity) || 1,
            amountTotal: Number(row.amount_total) || 0
        }))
    };
}

// ===== Stripe Helpers =====

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

async function fetchStripeSession(env, sessionId) {
    const res = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
        {
            headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
        }
    );
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}

async function fetchStripeLineItems(env, sessionId) {
    const res = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100&expand[]=data.price.product`,
        {
            headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
        }
    );
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.error?.message || 'Failed to fetch Stripe line items.');
    }
    return data.data || [];
}

async function tagStripePaymentIntent(env, paymentIntentId, orderNumber, items) {
    if (!paymentIntentId) return;

    const itemsSummary = items.map(i => `${i.name} x${i.quantity}`).join(', ').slice(0, 480);
    const piParams = new URLSearchParams();
    piParams.append('description', `Order ${orderNumber} — L'Atelier Damla`);
    piParams.append('metadata[order_number]', orderNumber);
    piParams.append('metadata[items]', itemsSummary);

    await fetch(
        `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
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

// ===== Email Helpers (Resend) =====

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
    if (order.emailedAt) {
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

    if (customerSent || studioSent) {
        await env.DB
            .prepare("UPDATE orders SET emailed_at = datetime('now') WHERE id = ?")
            .bind(order.id)
            .run()
            .catch(() => {});
    }

    return { customerSent, studioSent };
}

// ===== Order Finalization (Atomic & Idempotent via D1 UNIQUE stripe_session_id) =====

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

async function finalizePaidSession(env, session) {
    // Fast path: order already created in D1
    const existing = await getOrderBySessionId(env, session.id);
    if (existing) {
        return { order: existing, duplicate: true };
    }

    // Fetch finalized line items from Stripe
    const rawLineItems = await fetchStripeLineItems(env, session.id);
    const lineItems = rawLineItems.map(li => ({
        id: li.price?.product?.metadata?.catalog_id || null,
        name: li.description || li.price?.product?.name || 'Ceramic Piece',
        quantity: parseInt(li.quantity, 10) || 1,
        amountTotal: typeof li.amount_total === 'number' ? li.amount_total : 0
    }));

    const shipping = session.shipping_details || session.collected_information?.shipping_details || null;
    const address = shipping?.address || null;
    const shippingAddress = address ? {
        line1: address.line1 || '',
        line2: address.line2 || '',
        city: address.city || '',
        state: address.state || '',
        postalCode: address.postal_code || '',
        country: address.country || ''
    } : null;

    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
    const createdAt = new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();

    // Atomic idempotency gate: UNIQUE(stripe_session_id) guarantees only one insert succeeds
    const insertRes = await env.DB
        .prepare(`
            INSERT OR IGNORE INTO orders (
                stripe_session_id,
                payment_intent_id,
                status,
                currency,
                amount_subtotal,
                amount_shipping,
                amount_total,
                customer_name,
                customer_email,
                customer_phone,
                shipping_address_json,
                created_at
            ) VALUES (?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
            session.id,
            paymentIntentId,
            session.currency || 'eur',
            session.amount_subtotal || 0,
            session.total_details?.amount_shipping || 0,
            session.amount_total || 0,
            shipping?.name || session.customer_details?.name || '',
            session.customer_details?.email || '',
            session.customer_details?.phone || '',
            shippingAddress ? JSON.stringify(shippingAddress) : null,
            createdAt
        )
        .run();

    // Another concurrent call (e.g. webhook + /success simultaneously) already created this order
    if (!insertRes.meta || insertRes.meta.changes === 0) {
        const winner = await getOrderBySessionId(env, session.id);
        return { order: winner, duplicate: true };
    }

    const orderId = insertRes.meta.last_row_id;
    const orderNumber = `${ORDER_PREFIX}-${ORDER_BASE_OFFSET + orderId}`;

    // Batch: assign order_number, insert order_items, and atomically decrement stock in D1
    const statements = [
        env.DB
            .prepare('UPDATE orders SET order_number = ? WHERE id = ?')
            .bind(orderNumber, orderId)
    ];

    const purchasedCounts = {};
    for (const item of lineItems) {
        statements.push(
            env.DB
                .prepare('INSERT INTO order_items (order_id, product_id, name, quantity, amount_total) VALUES (?, ?, ?, ?, ?)')
                .bind(orderId, item.id, item.name, item.quantity, item.amountTotal)
        );
        if (item.id && item.quantity > 0) {
            purchasedCounts[item.id] = (purchasedCounts[item.id] || 0) + item.quantity;
        }
    }

    for (const [productId, qty] of Object.entries(purchasedCounts)) {
        statements.push(
            env.DB
                .prepare("UPDATE products SET stock = MAX(0, stock - ?), updated_at = datetime('now') WHERE id = ?")
                .bind(qty, productId)
        );
    }

    await env.DB.batch(statements);

    const orderRecord = {
        id: orderId,
        orderNumber,
        sessionId: session.id,
        paymentIntentId,
        status: 'paid',
        createdAt,
        currency: session.currency || 'eur',
        amountSubtotal: session.amount_subtotal || 0,
        amountShipping: session.total_details?.amount_shipping || 0,
        amountTotal: session.amount_total || 0,
        customerName: shipping?.name || session.customer_details?.name || '',
        customerEmail: session.customer_details?.email || '',
        customerPhone: session.customer_details?.phone || '',
        shippingAddress,
        emailedAt: null,
        items: lineItems
    };

    // Tag PaymentIntent in Stripe Dashboard & send confirmation emails
    await tagStripePaymentIntent(env, paymentIntentId, orderNumber, lineItems);
    const emailStatus = await sendOrderEmails(env, orderRecord);

    return { order: orderRecord, emailStatus, duplicate: false };
}

// ===== Route Handlers =====

async function handleGetOrder(request, env, origin) {
    if (!env.DB) return jsonResponse({ error: 'Missing D1 DB binding.' }, 500, origin);
    if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Missing STRIPE_SECRET_KEY.' }, 500, origin);

    const url = new URL(request.url);
    const sessionId = (url.searchParams.get('session_id') || '').trim();

    if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(sessionId)) {
        return jsonResponse({ error: 'Invalid session_id.' }, 400, origin);
    }

    // Fast path: already in D1
    const existing = await getOrderBySessionId(env, sessionId);
    if (existing) {
        return jsonResponse({ order: publicOrderReceipt(existing) }, 200, origin);
    }

    // Otherwise verify directly with Stripe and finalize immediately
    const { ok, data: session } = await fetchStripeSession(env, sessionId);
    if (!ok) {
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
    if (!env.DB) return jsonResponse({ error: 'Missing D1 DB binding.' }, 500, origin);
    if (!env.STRIPE_WEBHOOK_SECRET) return jsonResponse({ error: 'Missing STRIPE_WEBHOOK_SECRET.' }, 500, origin);
    if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Missing STRIPE_SECRET_KEY.' }, 500, origin);

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
            orderNumber: result.order?.orderNumber || null
        }, 200, origin);
    } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to finalize order.' }, 500, origin);
    }
}

async function handleCreateCheckoutSession(request, env, origin) {
    if (!env.DB) return jsonResponse({ error: 'Server missing D1 DB binding.' }, 500, origin);
    if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Server missing STRIPE_SECRET_KEY secret.' }, 500, origin);

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

    const catalog = await getCatalogMap(env);
    const liveStock = Object.fromEntries(
        Object.entries(catalog).map(([id, prod]) => [id, prod.stock])
    );

    const mergedQuantities = {};
    for (const item of rawItems) {
        const id = item && typeof item.id === 'string' ? item.id : '';
        const quantity = Number.isInteger(item?.quantity) ? item.quantity : parseInt(item?.quantity, 10);

        if (!catalog[id]) {
            return jsonResponse({ error: `Unknown product: ${id}` }, 400, origin);
        }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
            return jsonResponse({ error: `Invalid quantity for ${catalog[id].name}` }, 400, origin);
        }
        mergedQuantities[id] = (mergedQuantities[id] || 0) + quantity;
    }

    for (const [id, quantity] of Object.entries(mergedQuantities)) {
        const available = catalog[id].stock;
        if (available <= 0) {
            return jsonResponse(
                { error: `${catalog[id].name} is currently sold out.`, stock: liveStock },
                409,
                origin
            );
        }
        if (quantity > available) {
            return jsonResponse(
                { error: `Only ${available} left for ${catalog[id].name}.`, stock: liveStock },
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
        const product = catalog[id];
        subtotalCents += product.unitAmount * quantity;

        params.append(`line_items[${lineIndex}][price_data][currency]`, 'eur');
        params.append(`line_items[${lineIndex}][price_data][unit_amount]`, String(product.unitAmount));
        params.append(`line_items[${lineIndex}][price_data][product_data][name]`, product.name);
        params.append(`line_items[${lineIndex}][price_data][product_data][description]`, product.description);
        if (product.image) {
            params.append(`line_items[${lineIndex}][price_data][product_data][images][0]`, product.image);
        }
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

// ===== Entrypoint =====

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        // Health check
        if (request.method === 'GET' && path === '/') {
            let dbReady = false;
            let productCount = 0;

            if (env.DB) {
                try {
                    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM products').first();
                    productCount = Number(row?.count) || 0;
                    dbReady = true;
                } catch {
                    dbReady = false;
                }
            }

            return jsonResponse({
                ok: true,
                service: "L'Atelier Damla Stripe Checkout",
                database: 'Cloudflare D1',
                dbBound: Boolean(env.DB),
                dbReady,
                productCount,
                stripeConfigured: Boolean(env.STRIPE_SECRET_KEY),
                webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
                emailConfigured: Boolean(env.RESEND_API_KEY)
            }, 200, origin);
        }

        // Instant live stock from D1
        if (request.method === 'GET' && path === '/inventory') {
            if (!env.DB) return jsonResponse({ error: 'Missing D1 DB binding.' }, 500, origin);
            const stock = await getAllStock(env);
            return jsonResponse({ stock }, 200, origin);
        }

        // Order receipt lookup for /success
        if (request.method === 'GET' && path === '/order') {
            return handleGetOrder(request, env, origin);
        }

        // Stripe webhook
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
