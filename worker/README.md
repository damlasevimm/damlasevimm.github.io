# Stripe Checkout Cloudflare Worker Setup

Because GitHub Pages is static-only, your **Stripe Secret Key** (`sk_test_...` or `sk_live_...`) must live in a tiny serverless Worker rather than in your public HTML/JS. Cloudflare Workers' free tier gives you 100,000 requests/day at $0/month.

## 5-Minute Setup (No CLI Required)

1. **Get your Stripe Secret Key**
   - Go to [Stripe Dashboard → Developers → API keys](https://dashboard.stripe.com/apikeys).
   - Start in **Test mode** (`sk_test_...`) to verify checkout end-to-end, then swap to your **Live** key (`sk_live_...`) when ready.

2. **Deploy the Worker on Cloudflare**
   - Sign in (or create a free account) at [dash.cloudflare.com](https://dash.cloudflare.com/).
   - Go to **Workers & Pages → Create → Create Worker**.
   - Name it (for example, `latelier-checkout`) and click **Deploy**.
   - Click **Edit code**, delete the sample code, paste the full contents of [`stripe-checkout-worker.js`](./stripe-checkout-worker.js), and click **Deploy**.

3. **Add your Stripe Secret Key**
   - In your Worker page, go to **Settings → Variables and Secrets → Add**.
   - Type: **Secret**
   - Variable name: `STRIPE_SECRET_KEY`
   - Value: your `sk_test_...` (or `sk_live_...`) key
   - Click **Deploy**.

4. **Connect your website**
   - Copy your Worker URL (e.g. `https://latelier-checkout.yourname.workers.dev`).
   - Open [`../cart.js`](../cart.js) and replace `CHECKOUT_API_URL` on line 3 with:
     ```js
     const CHECKOUT_API_URL = 'https://latelier-checkout.yourname.workers.dev/create-checkout-session';
     ```
   - Commit and push to GitHub.

## Customizing Products & Shipping
- **Shipping cost / countries**: Edit `SHIPPING_OPTIONS` and `SHIPPING_COUNTRIES` near the top of [`stripe-checkout-worker.js`](./stripe-checkout-worker.js).
- **Adding new items**: Add the item to `shop.html` (and `index.html` if featured) **and** add its matching ID & EUR price (in cents) to `CATALOG` in `stripe-checkout-worker.js`.
