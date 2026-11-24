# L'Atelier Damla — Cloudflare D1 + Stripe Checkout Worker

Your backend uses **Cloudflare D1** (a real, strongly consistent SQLite database on Cloudflare's free tier) instead of KV namespaces:
- **Instant stock updates** (zero 60-second KV lag)
- **One database** with 3 clean relational tables: `products`, `orders`, and `order_items`
- **Atomic duplicate protection** via `UNIQUE(stripe_session_id)`
- **Free shipping automatically over €50** (€8 below €50) + Resend confirmation emails

---

## 1. Create the D1 Database & Tables (~2 minutes)
1. In [dash.cloudflare.com](https://dash.cloudflare.com/), go to **Storage & Databases → D1 SQL Database → Create**.
   - Name: `latelier-db`
   - Click **Create**.
2. Open `latelier-db` → **Console** tab.
3. Copy the entire contents of [`schema.sql`](./schema.sql), paste it into the Console, and click **Execute**.
   - This creates the `products`, `orders`, and `order_items` tables and inserts your 4 products.

## 2. Bind `DB` to Your Worker
1. Go to **Workers & Pages → `latelierdamla-checkout` → Settings → Bindings**.
2. Click **Add → D1 database**:
   - Variable name: **`DB`** *(exact spelling, all caps)*
   - D1 database: `latelier-db`
3. *(Optional cleanup)* Once D1 is verified, you can remove the old `INVENTORY`, `ORDERS`, and `PROCESSED` KV bindings.

## 3. Deploy the Updated Worker Code
1. Open **Workers & Pages → `latelierdamla-checkout` → Edit code**.
2. Replace the code with [`stripe-checkout-worker.js`](./stripe-checkout-worker.js) and click **Deploy**.
3. Confirm your secrets are still set under **Settings → Variables and Secrets**:
   - `STRIPE_SECRET_KEY` (`sk_test_...` or `sk_live_...`)
   - `STRIPE_WEBHOOK_SECRET` (`whsec_...`)
   - `RESEND_API_KEY` (`re_...`, optional for automatic emails)

## 4. Verify Everything Is Live
Open `https://latelierdamla-checkout.damlasevimm.workers.dev/` in your browser:
```json
{
  "ok": true,
  "service": "L'Atelier Damla Stripe Checkout",
  "database": "Cloudflare D1",
  "dbBound": true,
  "dbReady": true,
  "productCount": 4,
  "stripeConfigured": true,
  "webhookConfigured": true,
  "emailConfigured": true
}
```

---

## Managing Stock, Products & Orders in Cloudflare D1 Console
Open **D1 → `latelier-db` → Tables** (visual table editor) or **Console**:

- **Update stock (instant, no redeploy needed):**
  ```sql
  UPDATE products SET stock = 5 WHERE id = 'ocean-cup-01';
  ```
- **Add a new ceramic piece** *(price in EUR cents, e.g. `4500` = €45.00)*:
  ```sql
  INSERT INTO products (id, name, description, unit_amount, image, stock)
  VALUES ('new-vase-05', 'No. 05 — Studio Vase', 'Hand-built stoneware vase.', 4500, 'https://latelierdamla.com/images/new_vase.jpeg', 2);
  ```
- **View recent orders:**
  ```sql
  SELECT order_number, status, customer_name, customer_email, amount_total / 100.0 AS eur, tracking_number, created_at
  FROM orders
  ORDER BY id DESC;
  ```
- **Mark an order as shipped & save tracking number:**
  ```sql
  UPDATE orders SET status = 'shipped', tracking_number = 'TRACK123456' WHERE order_number = 'LAD-1001';
  ```
