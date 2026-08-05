# FabRoses Business System v3

This is a complete redesign, not a patch — the schema changed again, more
substantially than the previous rebuild. **Nothing carries over from
before.** Every table, every endpoint, and the entire frontend were rebuilt
against a long, detailed list of real problems and design decisions worked
through step by step, covering:

- Real **double-entry bookkeeping** — a proper Chart of Accounts extended
  through inventory/COGS, with every party (customer, reseller, supplier,
  *and worker*) getting their own sub-account automatically
- **Bill-level payment tracking** — Payments Receivable, Payable, and
  Worker Payments all use the identical mechanism: select one bill or
  several, apply a payment, overpay and it becomes an advance, manually
  applied later, never automatically
- A genuine **two-step Dispatch/Receive process** — nothing credits the
  destination the moment something ships; it sits "in transit" until
  someone at the other end actually confirms it arrived
- **Raw material return reconciliation** — a lot's identity stays stable
  across its whole journey, so scanning it finds every open issue against
  it (even split across multiple workers), and a return can be partial,
  with wastage tracked separately from what's actually usable
- **Work Orders now require a worker at creation** — this closes off, at
  the root, a real bug from the previous version where auto-created work
  orders could exist with nobody assigned
- **Customer Orders are fully manual now** — no automatic stock check, no
  auto-created work order, no auto-attaching to an existing one. Viewing an
  order just shows current stock and any open work orders as information;
  a person decides what to do
- Master-list **dropdowns everywhere** a name used to be typed — customers,
  suppliers, resellers, expense categories — each with an inline "+new"
  option
- **QR codes** — every item gets one at creation, encoding its part number
  plus lot identity together, and can be reprinted at any time, not just once
- Two real, previously-reported bugs fixed at the source: the CSS
  specificity bug that stretched every small button to full width, and the
  missing edit option on Catalogue items

## What's actually been tested

**77 automated tests, all passing** — including a genuine end-to-end test
that starts a real HTTP server hosting every backend endpoint and drives it
with the *exact* request bodies from the frontend's own JS, over real HTTP.
This process caught three real bugs before you ever saw this: a wrong
import path (a syntax checker can't catch that — only actually running the
code can), a missing default that would have broken billing on any
customer order that only had an item selected with no free-text
description, and a completely missing reseller-performance report that had
been deleted during cleanup and never rebuilt — plus, once rebuilt, the
Sales tab had no way to actually select a reseller party at all, which
would have made the report permanently show zero regardless.

**What this does NOT prove:** that clicking through the actual UI in a
browser feels right. The integration test proves the frontend and backend
agree on every field name and response shape it covers — it doesn't replace
you actually using it.

## Setup

This is a from-scratch schema again — if you're reusing the same D1/R2
resource names as before, they need wiping the same way as last time:

```
wrangler d1 delete fabroses-db
wrangler d1 create fabroses-db
```
Paste the new `database_id` into `wrangler.toml`, then:
```
wrangler d1 execute fabroses-db --file=./schema.sql --remote
```
R2 needs no changes — same reasoning as before, different key names, no
collision risk.

Bootstrap your first login exactly as before:
```
node scripts/create-admin.js "Your Name" youradminusername yourSecurePin123
wrangler d1 execute fabroses-db --remote --file=./create-admin.sql
```

Push to GitHub, connect Cloudflare Pages, bind `DB`/`PHOTOS`/`AUTH_SECRET`,
redeploy — identical steps to the previous deployment guide.

## Testing this yourself before real use

```
npm test
```
or individually:
```
node test/system-test-ledger-engine.mjs       # Balance enforcement, party sub-accounts
node test/system-test-worker-party.mjs        # Worker <-> Site <-> Party linkage
node test/system-test-sales.mjs               # Tax calc, FIFO vs scanned-lot override
node test/system-test-payments.mjs            # Bill-level allocation, advances
node test/system-test-two-step-dispatch.mjs   # In-transit state, mismatch detection
node test/system-test-material-return.mjs     # Split-lot reconciliation with wastage
node test/system-test-reseller.mjs            # Reseller sales attribution via party, not free text
node test/frontend-integration-test-v2.mjs    # Real HTTP, real frontend request shapes
```

## Known gaps, stated honestly

- **Stage automation** — moving a work order's stage forward automatically
  on real events (material issued, dispatched) wasn't built; stages are
  still advanced manually via the pill buttons. The "which stages should be
  automatic" question was never fully answered, so nothing was guessed at.
- **The Purchase Tab and Catalogue Tab's own specific mind-map workflows**
  (from the original requirements doc) were never confirmed against your
  actual intent — this build follows the problem-list conversation instead,
  which superseded a lot of that earlier planning.
- **No visual polish toward the purple reference mockup** — still purely
  functional, not styled to match.
