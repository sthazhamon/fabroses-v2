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

## QR camera scanning — added, but with a real limit on how it's been verified

Every field that previously said "Scan or enter" without any actual scan
capability behind it now has a real 📷 **Scan** button — Issue Material's
lot field, the material return lookup, the Sales lot-override, Customer
Order billing's lot-override, and My Work's ship-back item field. Scanning
opens the camera, and for a field expecting an item's real internal ID
(not its part-number code), it automatically looks up the code back to the
right ID rather than just dropping raw scanned text into a field expecting
a primary key.

While fixing this, I also found and corrected a real inconsistency: the
three places QR payloads get generated (right after creating an item, an
item-only QR from the detail view, and an item+lot QR) used two different,
incompatible formats. All three are now consistent.

**Important honest limitation:** camera scanning requires an actual browser
with camera and DOM access — neither exists in my testing environment, so
this has only been verified by static code review (syntax, correct wiring,
consistent payload format) — **not** by an actual scan. Please test this
directly on a phone or laptop with a camera before relying on it; if the
camera doesn't open, or a scan doesn't fill the right field, that's exactly
the kind of thing that needs a real device to catch.

## This round: everything deferred, now done — except one

**Multi-line items**, across all four documents (Purchase Orders, Sales,
Customer Orders, Supplier Bills) — each restructured into a real
header-plus-line-items shape:
- Purchase Orders: each line receives independently — different items can
  arrive on different days, and the whole order's status is *derived* from
  its lines, not set separately.
- Sales: each line carries its own tax rate, its own stock consumption
  (FIFO or scan-to-override), summing to one grand total.
- Customer Orders: multiple items per order, billed all at once into a
  single matching multi-line sale.
- Supplier Bills: line up against specific PO lines — bill a partial
  delivery without waiting for the rest.

Two real bugs came out of testing this properly: a foreign-key ordering
bug in the sales engine (line items were being inserted before the parent
sale existed), and an unhandled crash in the customer-order billing
endpoint (a validation check that threw outside any try/catch). Both
fixed, both now covered by tests that would catch a regression.

**Stock-by-Site** is now aggregate-by-default — one row per item per site,
click "Show lots" to expand into the individual lots making up that total.

**Lot quantities are now directly editable** — a real, previously-missing
capability, with the correction logged (old value, new value) exactly like
any other edit, plus a movement record showing the actual delta.

## Still open — the one thing I genuinely can't fix without your help

**The item-photo cross-contamination bug.** I've checked the upload
endpoint and the cover-photo query multiple times now and both look
correct on paper. Without the URL comparison I asked for early on (right-
click each thumbnail, "copy image address," tell me if they're identical
or different), I can't tell whether this is a data bug or something in how
photos get served back out — and guessing at a fix for something I haven't
actually diagnosed risks papering over the real cause.

## This round: the worker flow, unblocked, plus real bug fixes

You were specifically blocked on testing because the worker's side of the
loop didn't exist — confirming material receipt, starting work, and
shipping the finished piece back all had no real path. Fixed properly, not
shortcut:

- **Stages simplified to three, all but one automatic**: Order Placed →
  Material Received (set when the worker confirms raw material arrived,
  not when the store ships it) → Work Started (the one genuinely manual
  step) → Work Shipped (set when the worker's return dispatch actually
  ships). A test specifically proves you *can't* manually set Material
  Received or Work Shipped directly — only the dispatch engine can.
- **A real "My Work" tab for workers** — their own scoped queue, separate
  from the store's Dispatch/Receive tabs entirely.
- **The finished-good return is now genuinely two-step**, matching raw
  material exactly: worker ships → nothing credited yet → store confirms →
  *that's* the moment stock, cost, and labor get credited and the work
  order closes. A test proves stock is still zero right up until that
  final confirmation.
- **Mismatch checking against the work order's intended item** — a
  warning, overridable, with a `force:false` option if you actually want
  it to hard-block instead.
- **WIP photo upload** — this endpoint didn't exist at all; the work order
  detail page was already trying to read photos from a table nothing
  could ever write to.

Plus real, confirmed bugs from testing:
- **Every one of the 12 creation forms now actually resets** after saving
  — previously 11 of 12 reset nothing at all, and the 12th reset one field
  out of ten.
- **Party and site dropdowns no longer silently default to the first
  alphabetical entry** — this was a real risk of billing, paying, or
  assigning work to the wrong person by simple inattention. Every one now
  requires deliberate selection.
- **Uploading a new item photo now actually updates what's shown** — it
  was hardcoded to always show the very first photo ever uploaded,
  regardless of anything added since.
- **Full-size photo viewing** — click any thumbnail to see it enlarged;
  previously only a small thumbnail existed anywhere, with no way to see
  a photo properly.

## Still open, not forgotten

- **Multi-line items** for Purchase Orders, Sales, Customer Orders, and
  Supplier Bills — a real structural change, deliberately not rushed
  alongside everything else in this round.
- **Camera-based scanning** — genuinely doesn't exist anywhere yet, despite
  some labels implying it does.
- **Stock-by-Site's aggregate-then-expand view**, and **lot quantity
  editing** — confirmed real gaps, not yet built.
- **The item-photo cross-contamination bug** — still can't diagnose this
  one without the URL comparison originally asked for. If you can get me
  that, I can actually fix it instead of guessing.

## Testing this yourself before real use

```
npm test
```
97 tests across nine files. `test/system-test-worker-flow.mjs` is the one
that specifically proves the worker loop end-to-end.

## Known gaps, stated honestly

- **The Purchase Tab and Catalogue Tab's own specific mind-map workflows**
  (from the original requirements doc) were never confirmed against your
  actual intent — this build follows the problem-list conversation instead,
  which superseded a lot of that earlier planning.
- **No visual polish toward the purple reference mockup** — still purely
  functional, not styled to match.
