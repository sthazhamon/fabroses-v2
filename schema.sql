-- FabRoses Business System — schema v3
--
-- This replaces schema.sql entirely (nothing has been deployed, so this is
-- a direct redesign, not a migration). Every table here reflects a specific
-- decision worked through in detail: real double-entry bookkeeping, bill-
-- level payment tracking (not just a party balance), a genuine two-step
-- dispatch/receive process, partial raw-material return reconciliation with
-- wastage tracked at the return step (not at finished-goods receiving), and
-- fully manual work order creation/linking (no automatic cascade).

-- ============================================================
-- AUTH & USERS
-- ============================================================

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE,
  pin_hash TEXT,
  pin_salt TEXT,
  role TEXT NOT NULL,              -- admin | accountant | worker | dispatch | reseller
  reseller_party_id TEXT,
  site_id TEXT,                    -- set for role = 'worker'
  token_version INTEGER DEFAULT 1,
  failed_attempts INTEGER DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_users_username ON users(username);

CREATE TABLE edit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  edited_by TEXT,
  edited_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_editlog_entity ON edit_log(entity_type, entity_id);

-- ============================================================
-- SITES
-- ============================================================

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site_type TEXT NOT NULL,          -- store | worker
  worker_user_id INTEGER REFERENCES users(id),
  worker_party_id TEXT,             -- links to parties.id — every worker site has a party for payments/advances
  address TEXT,
  notes TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- PART-NUMBERING MASTER LISTS
-- ============================================================

CREATE TABLE item_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE item_fabrics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE item_work_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE item_patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE item_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  default_category_id INTEGER REFERENCES item_categories(id),
  default_fabric_id INTEGER REFERENCES item_fabrics(id),
  default_work_type_id INTEGER REFERENCES item_work_types(id),
  default_pattern_id INTEGER REFERENCES item_patterns(id),
  sketch_r2_key TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  account_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO item_categories (name, code) VALUES
  ('Cutwork', 'CTW'), ('Embroidery', 'EMB'), ('Handwork', 'HWK'), ('Kerala', 'KER'),
  ('Party Wear', 'PTY'), ('Dress Material', 'DRM'), ('Daily Wear', 'DLY'), ('Custom / Bespoke', 'CUS'), ('Raw Material', 'RAW');
INSERT INTO item_fabrics (name, code) VALUES ('Kota', 'KTA'), ('Organza', 'ORG'), ('Linen', 'LIN'), ('Semi Silk', 'SSK'), ('Silk', 'SLK'), ('Kasavu Cotton', 'KAS');
INSERT INTO item_work_types (name, code) VALUES ('Cutwork', 'CTW'), ('Embroidery', 'EMB'), ('Applique', 'APL'), ('Floral-work', 'FLW'), ('Handwork', 'HDW'), ('Plain / none', 'PLN');
INSERT INTO item_patterns (name, code) VALUES ('Floral', 'FLR'), ('Peacock / bird motif', 'PEA'), ('Paisley', 'PAI'), ('Geometric', 'GEO'), ('Border only', 'BRD'), ('Traditional', 'TRD'), ('Mixed / combination', 'MIX'), ('Other', 'OTH');
INSERT INTO expense_categories (name) VALUES ('Rent'), ('Utilities'), ('Salaries'), ('Transport'), ('Miscellaneous');

-- ============================================================
-- ITEMS, LOTS, MOVEMENTS
-- ============================================================

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES item_categories(id),
  fabric_id INTEGER REFERENCES item_fabrics(id),
  work_type_id INTEGER REFERENCES item_work_types(id),
  pattern_id INTEGER REFERENCES item_patterns(id),
  design_id INTEGER REFERENCES item_designs(id),
  item_code TEXT,
  color TEXT,
  price REAL,
  cost REAL,
  description TEXT,
  unit_of_measure TEXT DEFAULT 'piece',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_type ON items(item_type);

CREATE TABLE item_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES items(id), r2_key TEXT NOT NULL, uploaded_at TEXT DEFAULT (datetime('now')));

-- Bill of Materials: which raw materials, and how much of each, a finished
-- good is made from. Multiple rows per finished item.
CREATE TABLE item_bom (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finished_item_id TEXT NOT NULL REFERENCES items(id),
  raw_material_item_id TEXT NOT NULL REFERENCES items(id),
  quantity_required REAL NOT NULL
);
CREATE INDEX idx_bom_finished ON item_bom(finished_item_id);

CREATE TABLE item_lots (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  quantity_original REAL NOT NULL,
  quantity_balance REAL NOT NULL,
  source_type TEXT NOT NULL,
  source_reference TEXT,
  origin_lot_id TEXT REFERENCES item_lots(id),
  cost_total REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_lots_item ON item_lots(item_id);
CREATE INDEX idx_lots_origin ON item_lots(origin_lot_id);
CREATE INDEX idx_lots_site ON item_lots(site_id);

CREATE TABLE item_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id TEXT REFERENCES item_lots(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  event_type TEXT NOT NULL,
  from_site_id TEXT REFERENCES sites(id),
  to_site_id TEXT REFERENCES sites(id),
  quantity REAL NOT NULL,
  work_order_id TEXT,
  dispatch_id TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_movements_lot ON item_movements(lot_id);
CREATE INDEX idx_movements_wo ON item_movements(work_order_id);

-- ============================================================
-- DISPATCH — genuine two-step. Nothing lands at the destination until
-- someone there confirms it.
-- ============================================================

CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  dispatch_type TEXT NOT NULL,
  from_site_id TEXT REFERENCES sites(id),
  to_site_id TEXT REFERENCES sites(id),
  related_customer_order_id TEXT,
  related_work_order_id TEXT,
  related_purchase_order_id TEXT,
  status TEXT DEFAULT 'pending_pick',
  courier TEXT,
  tracking_id TEXT,
  shipped_at TEXT,
  received_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE dispatch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
  item_id TEXT REFERENCES items(id),
  lot_id TEXT REFERENCES item_lots(id),
  expected_quantity REAL,
  scanned_quantity REAL,
  received_quantity REAL,
  mismatch_flag INTEGER DEFAULT 0
);

CREATE TABLE dispatch_tracking_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
  courier TEXT,
  tracking_id TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- WORK ORDERS — worker mandatory at creation. No auto-attach.
-- ============================================================

CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  work_instructions TEXT,
  sketch_r2_key TEXT,
  worker_site_id TEXT NOT NULL REFERENCES sites(id),
  job_type TEXT DEFAULT 'production',
  intended_item_id TEXT REFERENCES items(id),
  rework_lot_id TEXT REFERENCES item_lots(id),
  output_item_id TEXT REFERENCES items(id),
  target_quantity REAL DEFAULT 1,
  received_quantity_total REAL DEFAULT 0,
  due_date TEXT,
  priority TEXT DEFAULT 'normal',
  stage TEXT DEFAULT 'Order Placed',
  labor_cost REAL,
  related_customer_order_id TEXT,
  order_date TEXT,
  closed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE stage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, work_order_id TEXT REFERENCES work_orders(id), stage TEXT, changed_by TEXT, changed_at TEXT DEFAULT (datetime('now')));

CREATE TABLE material_issues (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  lot_id TEXT NOT NULL REFERENCES item_lots(id),
  quantity_issued REAL NOT NULL,
  quantity_returned_stock REAL DEFAULT 0,
  quantity_wasted REAL DEFAULT 0,
  worker_site_id TEXT REFERENCES sites(id),
  status TEXT DEFAULT 'with_worker',
  verified_at TEXT,
  issued_at TEXT DEFAULT (datetime('now')),
  received_at TEXT,
  notes TEXT
);

CREATE TABLE material_return_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_issue_id TEXT NOT NULL REFERENCES material_issues(id),
  quantity_returned_stock REAL DEFAULT 0,
  quantity_wasted REAL DEFAULT 0,
  destination_site_id TEXT REFERENCES sites(id),
  created_lot_id TEXT REFERENCES item_lots(id),
  corrected_at TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- A finished-good lot sent out for rework — mirrors material_issues, but
-- for a specific already-made piece rather than raw material. A lot can
-- go through this more than once if it needs correcting again.
CREATE TABLE rework_issues (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  lot_id TEXT NOT NULL REFERENCES item_lots(id),
  quantity_issued REAL NOT NULL,
  quantity_returned REAL DEFAULT 0,
  quantity_wasted REAL DEFAULT 0,
  worker_site_id TEXT REFERENCES sites(id),
  status TEXT DEFAULT 'with_worker',
  issued_at TEXT DEFAULT (datetime('now')),
  received_at TEXT,
  notes TEXT
);

CREATE TABLE rework_return_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rework_issue_id TEXT NOT NULL REFERENCES rework_issues(id),
  quantity_returned REAL DEFAULT 0,
  quantity_wasted REAL DEFAULT 0,
  destination_site_id TEXT REFERENCES sites(id),
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE photos (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, stage TEXT, r2_key TEXT NOT NULL, uploaded_at TEXT DEFAULT (datetime('now')));

-- ============================================================
-- CUSTOMER ORDERS — simplified, fully manual.
-- ============================================================

CREATE TABLE customer_orders (
  id TEXT PRIMARY KEY,
  customer_party_id TEXT,
  customer_name TEXT,
  reseller_name TEXT,
  customer_phone TEXT,
  order_date TEXT,
  promised_delivery_date TEXT,
  status TEXT DEFAULT 'received',
  sale_id TEXT,
  courier TEXT,
  tracking_id TEXT,
  dispatch_date TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE customer_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_order_id TEXT NOT NULL REFERENCES customer_orders(id),
  item_id TEXT REFERENCES items(id),
  description TEXT,
  quantity REAL DEFAULT 1,
  unit_price REAL,
  tax_rate REAL DEFAULT 0,
  linked_work_order_id TEXT REFERENCES work_orders(id)
);

CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  supplier_party_id TEXT,
  supplier_name TEXT NOT NULL,
  expected_date TEXT,
  status TEXT DEFAULT 'ordered',
  bill_status TEXT DEFAULT 'not_billed',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  item_id TEXT REFERENCES items(id),
  quantity_ordered REAL NOT NULL,
  rate REAL,
  quantity_received REAL DEFAULT 0,
  status TEXT DEFAULT 'ordered'
);

-- ============================================================
-- CHART OF ACCOUNTS & DOUBLE-ENTRY LEDGER
-- ============================================================

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  parent_account_id INTEGER REFERENCES accounts(id),
  party_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL,
  description TEXT,
  reference_type TEXT,
  reference_id TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0
);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX idx_journal_lines_entry ON journal_lines(journal_entry_id);

INSERT INTO accounts (code, name, account_type) VALUES
  ('1000', 'Cash', 'asset'),
  ('1010', 'Bank', 'asset'),
  ('1100', 'Accounts Receivable', 'asset'),
  ('1200', 'Inventory — Raw Material', 'asset'),
  ('1300', 'Tax Input Credit', 'asset'),
  ('1210', 'Inventory — Finished Goods', 'asset'),
  ('2000', 'Accounts Payable', 'liability'),
  ('2050', 'Wages Payable', 'liability'),
  ('2100', 'Advances from Customers', 'liability'),
  ('2200', 'Tax Payable', 'liability'),
  ('3000', 'Sales Revenue', 'revenue'),
  ('3100', 'Sales Refunds', 'revenue'),
  ('4000', 'Raw Material Consumed', 'cogs'),
  ('4100', 'Labor', 'cogs'),
  ('4200', 'Inventory Loss', 'cogs'),
  ('5000', 'Expenses', 'expense');

-- ============================================================
-- BILLS & PAYMENT ALLOCATION
-- ============================================================

CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  work_order_id TEXT,
  customer_party_id TEXT,
  customer_name TEXT,
  reseller_name TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  sale_date TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  item_id TEXT REFERENCES items(id),
  lot_id TEXT REFERENCES item_lots(id),
  description TEXT NOT NULL,
  quantity REAL DEFAULT 1,
  sale_price REAL NOT NULL,
  tax_rate REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  line_total REAL NOT NULL
);

-- A physical return of a sold item back into stock — deliberately separate
-- from refunds, which only move money. This only moves inventory.
CREATE TABLE sale_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  lot_id TEXT REFERENCES item_lots(id),
  quantity REAL NOT NULL,
  destination_site_id TEXT REFERENCES sites(id),
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  sale_id TEXT REFERENCES sales(id),
  customer_party_id TEXT,
  amount REAL NOT NULL,
  reason TEXT,
  refund_date TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE supplier_bills (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT REFERENCES purchase_orders(id),
  supplier_party_id TEXT,
  supplier_name TEXT NOT NULL,
  bill_number TEXT,
  bill_date TEXT,
  amount REAL NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE supplier_bill_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_bill_id TEXT NOT NULL REFERENCES supplier_bills(id),
  purchase_order_item_id INTEGER REFERENCES purchase_order_items(id),
  item_id TEXT REFERENCES items(id),
  quantity REAL,
  rate REAL,
  tax_rate REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  line_total REAL NOT NULL
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  date TEXT,
  description TEXT,
  expense_category_id INTEGER REFERENCES expense_categories(id),
  paid_by TEXT,
  amount REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  party_name TEXT,
  direction TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_date TEXT,
  method TEXT,
  reference TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  bill_type TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  amount_applied REAL NOT NULL
);

CREATE TABLE worker_payments (
  id TEXT PRIMARY KEY,
  work_order_id TEXT REFERENCES work_orders(id),
  worker_site_id TEXT REFERENCES sites(id),
  amount REAL NOT NULL,
  payment_date TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- PARTIES — pure master data. Balances are derived, never stored.
-- ============================================================

CREATE TABLE parties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  opening_balance REAL DEFAULT 0,
  discount_tier INTEGER,
  target_amount REAL,
  target_period TEXT,
  bonus_rule TEXT,
  account_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- RESELLER GAMIFICATION
-- ============================================================

-- Append-only log of every points-affecting event. The reseller's
-- spendable balance is the sum of everything here, and never resets.
-- Level standing is computed separately, from just the 'earned' rows
-- within the current year — see reseller_level_config below.
CREATE TABLE reseller_points_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_party_id TEXT NOT NULL REFERENCES parties(id),
  event_type TEXT NOT NULL, -- earned | spent | milestone_bonus
  points REAL NOT NULL, -- positive for earned/bonus, negative for spent
  reference_type TEXT, -- sale | redemption | milestone
  reference_id TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_points_ledger_reseller ON reseller_points_ledger(reseller_party_id);

-- Admin-configured level thresholds and discounts. min_points_this_year
-- is compared against a reseller's SUM of 'earned' points within the
-- current calendar year only — this is what resets yearly, completely
-- separate from the spendable balance above.
CREATE TABLE reseller_level_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level_name TEXT NOT NULL UNIQUE,
  min_points_this_year REAL NOT NULL,
  discount_percent REAL NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

-- Admin-curated catalog of specific products a reseller can redeem
-- points for — not run through the full Sales/tax machinery, since a
-- reward isn't really an invoiced transaction.
CREATE TABLE reseller_reward_items (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id),
  name TEXT NOT NULL,
  points_cost REAL NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- A reseller's request to redeem a reward. Points are only deducted once
-- admin approves — see reseller-reward-redemptions.js for that logic.
CREATE TABLE reseller_reward_redemptions (
  id TEXT PRIMARY KEY,
  reseller_party_id TEXT NOT NULL REFERENCES parties(id),
  reward_item_id TEXT NOT NULL REFERENCES reseller_reward_items(id),
  points_spent REAL NOT NULL,
  status TEXT DEFAULT 'requested',
  courier TEXT,
  tracking_id TEXT,
  requested_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT,
  shipped_at TEXT
);

-- Time-bound campaigns an admin announces, targeted at specific
-- resellers, with an Rs-value goal and a perk on completion.
CREATE TABLE reseller_milestones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_value REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  perk_type TEXT NOT NULL,
  perk_points REAL,
  perk_reward_item_id TEXT REFERENCES reseller_reward_items(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Which specific resellers a milestone applies to, and whether each has
-- achieved it yet.
CREATE TABLE reseller_milestone_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id TEXT NOT NULL REFERENCES reseller_milestones(id),
  reseller_party_id TEXT NOT NULL REFERENCES parties(id),
  achieved_at TEXT,
  redemption_id TEXT REFERENCES reseller_reward_redemptions(id)
);

-- Simple key-value store for small, single-value admin settings, like the
-- reseller points-per-rupee rate.
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
