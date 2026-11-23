# Stripe Checkout & Automatic Inventory Setup (Cloudflare Worker)

Your Cloudflare Worker handles both **Stripe Checkout** and **automatic live inventory** using Cloudflare KV (free tier) + a Stripe Webhook.

## 1. Update the Worker Code
1. Open your Worker (`latelierdamla-checkout`) in [dash.cloudflare.com](https://dash.cloudflare.com/) → **Workers & Pages**.
2. Click **Edit code**, replace everything with the contents of [`stripe-checkout-worker.js`](./stripe-checkout-worker.js), and click **Deploy**.

## 2. Create & Bind Your Cloudflare KV Inventory Store
1. In Cloudflare Dashboard, go to **Storage & Databases → KV** → **Create a namespace**.
   - Name it: `latelier-inventory`
2. Open the namespace → **KV Pairs** and add one entry per product (using the exact product IDs):
   | Key | Value (current stock) |
   | --- | --- |
   | `ocean-cup-01` | `3` |
   | `shore-cup-02` | `3` |
   | `meadow-cups-03` | `3` |
   | `cotton-candy-plate-04` | `2` |
   *(You can edit these numbers anytime right in the Cloudflare Dashboard—no code redeploy needed!)*
3. Attach the KV namespace to your Worker:
   - Go to **Workers & Pages → `latelierdamla-checkout` → Settings → Bindings → Add**.
   - Choose **KV Namespace**.
   - Variable name: `INVENTORY` *(exact spelling, all caps)*
   - KV namespace: `latelier-inventory`
   - Click **Save / Deploy**.

## 3. Connect the Stripe Webhook (Auto-Decrement Stock on Paid Orders)
1. Go to [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks) *(make sure the Test/Live toggle matches your `STRIPE_SECRET_KEY`)*.
2. Click **Add destination / Add endpoint**:
   - Endpoint URL:
     ```
     https://latelierdamla-checkout.damlasevimm.workers.dev/stripe-webhook
     ```
   - Events to listen to:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
3. After creating the webhook, reveal and copy its **Signing secret** (`whsec_...`).
4. In Cloudflare Dashboard → **`latelierdamla-checkout` → Settings → Variables and Secrets → Add**:
   - Type: **Secret**
   - Variable name: `STRIPE_WEBHOOK_SECRET`
   - Value: your `whsec_...` signing secret
   - Click **Deploy**.

## 4. Verify Everything Is Connected
Open your Worker URL in a browser:
`https://latelierdamla-checkout.damlasevimm.workers.dev/`

You should see:
```json
{
  "ok": true,
  "service": "L'Atelier Damla Stripe Checkout",
  "stripeConfigured": true,
  "inventoryKvBound": true,
  "webhookConfigured": true
}
```
And visiting `https://latelierdamla-checkout.damlasevimm.workers.dev/inventory` shows your live stock counts!

## Adding New Products Later
1. Add the product card to `shop.html` (and `index.html` if featured).
2. Add its matching ID, EUR price (in cents), and `defaultStock` to `CATALOG` in [`stripe-checkout-worker.js`](./stripe-checkout-worker.js) and click **Deploy**.
3. Add its stock key/value in Cloudflare KV (`latelier-inventory`).
