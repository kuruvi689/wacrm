-- ============================================================
-- 039_products_orders.sql — Catalog + orders (Sales Autopilot, phase 1)
--
--   1. products     — what the account sells and at what price. The
--                     single source of truth for prices: the AI must
--                     quote from here, never from its own text.
--   2. orders       — a priced basket for one contact. Totals are
--                     computed server-side and stored, never taken
--                     from the client or the model.
--   3. order_items  — line items with the product's name / price / tax
--                     SNAPSHOTTED, so editing a product later never
--                     changes an order that is already open or paid.
--
-- Money is stored as BIGINT minor units (paise, cents; whole yen for
-- zero-decimal currencies) to avoid floating-point rounding.
-- Prices are tax-exclusive; `tax_rate` is a percentage (18 = 18%).
--
-- Payments (Razorpay links, webhooks) arrive in a later migration.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Products --------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Author / audit only — never used for tenancy isolation.
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- Optional; when set it is unique per account and is the CSV upsert key.
  sku TEXT CHECK (sku IS NULL OR length(btrim(sku)) BETWEEN 1 AND 64),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  -- The most discount the AI may offer on its own; above this it hands off.
  max_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (max_discount_pct >= 0 AND max_discount_pct <= 100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A plain UNIQUE (not a partial index) so PostgREST upserts can target
  -- it; NULL skus never collide in Postgres.
  CONSTRAINT products_account_sku_key UNIQUE (account_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_products_account_active ON products(account_id, is_active);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Any member can read the catalog; only admin+ can change prices.
DROP POLICY IF EXISTS products_select ON products;
DROP POLICY IF EXISTS products_insert ON products;
DROP POLICY IF EXISTS products_update ON products;
DROP POLICY IF EXISTS products_delete ON products;
CREATE POLICY products_select ON products FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY products_insert ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY products_update ON products FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY products_delete ON products FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. Orders ----------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'awaiting_payment', 'paid', 'expired', 'cancelled', 'refunded', 'cod_confirmed'
  )),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL CHECK (total_minor >= 0),
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (discount_pct >= 0 AND discount_pct <= 100),
  created_via TEXT NOT NULL DEFAULT 'agent' CHECK (created_via IN ('agent', 'ai', 'api')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT orders_total_consistent
    CHECK (total_minor = subtotal_minor - discount_minor + tax_minor)
);

CREATE INDEX IF NOT EXISTS idx_orders_account_created ON orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_conversation ON orders(conversation_id);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Members read. There are deliberately NO write policies: totals and
-- status are financial facts, so every write goes through the server
-- (service role), which prices with priceOrder() and, later, marks an
-- order paid only from a verified payment webhook. A user JWT talking
-- to PostgREST directly must not be able to insert a ₹1 order or flip
-- one to 'paid'.
DROP POLICY IF EXISTS orders_select ON orders;
DROP POLICY IF EXISTS orders_insert ON orders;
DROP POLICY IF EXISTS orders_update ON orders;
DROP POLICY IF EXISTS orders_delete ON orders;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON orders FROM anon, authenticated;

DROP TRIGGER IF EXISTS set_updated_at ON orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 3. Order items -----------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Denormalised so RLS is a single cheap check, like the parent.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL,
  sku_snapshot TEXT,
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  qty INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 10000),
  discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Read-only to users for the same reason as orders.
DROP POLICY IF EXISTS order_items_select ON order_items;
DROP POLICY IF EXISTS order_items_insert ON order_items;
DROP POLICY IF EXISTS order_items_update ON order_items;
DROP POLICY IF EXISTS order_items_delete ON order_items;
CREATE POLICY order_items_select ON order_items FOR SELECT
  USING (is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON order_items FROM anon, authenticated;

-- An item must belong to the same account as its order, so a crafted
-- insert can't attach a line to another tenant's order.
CREATE OR REPLACE FUNCTION public.order_items_same_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM orders WHERE id = NEW.order_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'order_items.account_id must match its order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.order_items_same_account() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS order_items_same_account ON order_items;
CREATE TRIGGER order_items_same_account
  BEFORE INSERT OR UPDATE OF order_id, account_id ON order_items
  FOR EACH ROW EXECUTE FUNCTION public.order_items_same_account();
