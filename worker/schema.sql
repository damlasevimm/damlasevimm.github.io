-- L'Atelier Damla — Cloudflare D1 Database Schema
-- Run this once in Cloudflare Dashboard -> Storage & Databases -> D1 -> latelier-db -> Console

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    unit_amount INTEGER NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE,
    stripe_session_id TEXT NOT NULL UNIQUE,
    payment_intent_id TEXT,
    status TEXT NOT NULL DEFAULT 'paid',
    tracking_number TEXT,
    currency TEXT NOT NULL DEFAULT 'eur',
    amount_subtotal INTEGER NOT NULL DEFAULT 0,
    amount_shipping INTEGER NOT NULL DEFAULT 0,
    amount_total INTEGER NOT NULL DEFAULT 0,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_email TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    shipping_address_json TEXT,
    emailed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    amount_total INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- Initial product catalog (prices in EUR cents; safe to re-run)
INSERT OR IGNORE INTO products (id, name, description, unit_amount, image, stock) VALUES
    ('ocean-cup-01', 'No. 01 — The Ocean Cup', 'Hand-thrown speckled stoneware vessel with satin glaze.', 3000, 'https://latelierdamla.com/images/ocean_cup.jpeg', 3),
    ('shore-cup-02', 'No. 02 — Shore Cup', 'Wheel-thrown stoneware cup with overlapping volcanic shore inspired glazes.', 3000, 'https://latelierdamla.com/images/shore_cup.jpeg', 3),
    ('meadow-cups-03', 'No. 03 — The Meadow Cups', 'Sculptural cups shaped from raw stoneware.', 3000, 'https://latelierdamla.com/images/green_cups.jpeg', 3),
    ('cotton-candy-plate-04', 'No. 04 — Cotton Candy Plate', 'Hand-built dessert plate.', 3500, 'https://latelierdamla.com/images/colored_plate.jpeg', 2);
