# Stripe Checkout, Inventory & Order Management Setup (Cloudflare Worker)

Your Cloudflare Worker handles **Stripe Checkout**, **automatic live inventory**, and **sequential order numbers (`LAD-1001`, `LAD-1002`, …)** using Cloudflare KV (free tier) + a Stripe Webhook.

## 1. Update the Worker Code
1. Open your Worker (`latelierdamla-checkout`) in [dash.cloudflare.com](https://dash.cloudflare.com/) → **Workers & Pages**.
2. Click **Edit code**, replace everything with the contents of [`stripe-checkout-worker.js`](./stripe-checkout-worker.js), and click **Deploy**.

## 2. Create & Bind Your Cloudflare KV Store
1. In Cloudflare Dashboard, go to **Storage & Databases → KV** → **Create a namespace** named `latelier-inventory`.
2. Open **KV Pairs** and set your starting stock counts:
   | Key | Value (current stock) |
   | --- | --- |
   | `ocean-cup-01` | `3` |
   | `shore-cup-02` | `3` |
   | `meadow-cups-03` | `3` |
   | `cotton-candy-plate-04` | `2` |
3. Attach the KV namespace to your Worker under **Settings → Bindings → Add → KV Namespace**:
   - Variable name: **`INVENTORY`** *(exact spelling, all caps)*
   - KV namespace: `latelier-inventory`

## 3. Connect the Stripe Webhook
1. Go to [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks) *(matching your Test/Live mode)*.
2. Add endpoint:
   ```
   https://latelierdamla-checkout.damlasevimm.workers.dev/stripe-webhook
   ```
   Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`.
3. Copy the **Signing secret** (`whsec_...`) and add it to your Worker under **Settings → Variables and Secrets** as Secret **`STRIPE_WEBHOOK_SECRET`**.

## 4. Managing Orders & Order Numbers
- **Order numbers (`LAD-1001`, `LAD-1002`, …):** Generated automatically on every paid order and saved to:
  1. **Customer `/success` page**: Shows `#LAD-1001`, itemized receipt, shipping city/country, and a **Print Receipt** button.
  2. **Stripe Dashboard → Payments**: Each payment's description is automatically set to `Order LAD-1001 — L'Atelier Damla` (with `metadata.order_number` and `metadata.items`), so you can search by `LAD-1001`, see the buyer's shipping address & phone, and issue refunds.
  3. **Cloudflare KV (`latelier-inventory`)**: Full order JSON is also saved under `order:number:LAD-1001`.
- **Email alerts & branded receipts in Stripe Dashboard:**
  - **Settings → Emails → Customer emails**: Turn on **Successful payments** so buyers receive Stripe's automatic email receipt.
  - **Settings → Branding**: Upload your logo and set your lilac color (`#9BA7FA`).
  - **Profile (top-right) → Communication preferences**: Turn on **Successful payments** email notifications so Stripe alerts you on every new order.

## 5. Verify Everything Is Connected
Open `https://latelierdamla-checkout.damlasevimm.workers.dev/` in your browser—you should see:
```json
{
  "ok": true,
  "service": "L'Atelier Damla Stripe Checkout",
  "stripeConfigured": true,
  "inventoryKvBound": true,
  "webhookConfigured": true
}
```

## Adding New Products Later
1. Add the product card to `shop.html` (and `index.html` if featured).
2. Add its matching ID, EUR price (in cents), and `defaultStock` to `CATALOG` in [`stripe-checkout-worker.js`](./stripe-checkout-worker.js) and click **Deploy**.
3. Add its stock key/value in Cloudflare KV (`latelier-inventory`).
