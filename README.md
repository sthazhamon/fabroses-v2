# FabRoses Business System — this session's build

**360 automated tests, all passing.** Run `npm test` to verify yourself
before trusting this with real data.

This was the largest single batch of this project — 13 distinct items,
found through actual use of the previous build rather than planned in
advance. Below is what changed, with the two hardest problems explained
in enough detail to actually trust the fix, not just the pass count.

## The most important fix: Mark Job Done was consuming too much

Reported directly: issuing 10m of raw material for a job whose BOM only
needed 6m left zero remaining stock instead of the expected 4m leftover.
The cause was worse than a display bug — the function closing out
material issues was built for a different situation (the old
confirm-receive flow, where by that point anything unreturned really was
gone) and got reused here without noticing that assumption doesn't hold.
It was consuming the *entire* issued amount, not just what the job
actually needed.

Fixed with a proper per-BOM-line allocation: for each raw material, exactly
the BOM-expected amount is consumed across the job's open issues (oldest
first), and anything issued beyond that stays genuinely untouched as real
leftover stock — nothing needs to be "returned," since it never physically
moved. Proven against the exact reported numbers, plus a second test
allocating correctly across two separate issues at once.

## Real accounting, not just inventory tracking

Raw material cost and labor cost were always tracked on lots and work
orders for display purposes, but neither had ever once been posted as an
actual ledger entry — COGS on the P&L was always going to show zero,
regardless of anything else. Mark Job Done now posts both:

- **Raw material**: debits Raw Material Consumed, credits the raw-material
  inventory asset, using each lot's own recorded cost.
- **Labor**: entered per job at Mark Job Done, mirroring exactly how a
  Supplier Bill works — debits Labor COGS, credits the worker's own party
  account, creating a liability that a normal Worker Payment settles. The
  existing pending-payment window for workers keeps working unchanged.

## The material-return correction mechanism

A wrong quantity entered on a return had no way to be fixed and no
confirmation step to catch it before it happened. This turned out to need
several connected pieces:

- A review step before any return commits, showing exactly what's about
  to be recorded.
- Past return entries are now visible for the first time — there was
  previously no way to even see one, let alone correct it.
- A correction action that computes the difference automatically (you
  enter what the figure *should* have been, not the delta yourself), and
  — this is the part worth trusting the tests for — refuses to correct
  downward once any of that returned stock has already been consumed,
  shipped, or sold elsewhere. The original entry is never rewritten; a
  correction sits alongside it, visible in the trail.

## Everything else in this batch

- **Dispatch cancellation** — while still pending_pick, proven to touch
  nothing and correctly blocked once anything's been picked.
- **Five display fixes** — part numbers and lot numbers now show on the
  Receive confirm screen (with a QR available before confirming, not
  after) and in Stock by Site; the Supplier Bills PO checklist shows the
  full ordered/received/billed/outstanding breakdown; a bill date field
  and a live computed amount now exist.
- **Customer Order reference price** — purely informational, proven to
  have zero effect on Sales billing.
- **Supplier Bills tax** — a real per-line tax field, with the journal
  entry correctly split between the base expense and a new Tax Input
  Credit account, mirroring how Sales tax already works.
- **PO short-close** — a partially-received line can be deliberately
  marked done without needing the rest, correctly resolving the PO's
  overall status while keeping the original figures on record.
- **PO line editing** — allowed only before any receiving or billing has
  happened against a line, to avoid silently disagreeing with history.
- **The Material Movement Register** — a new dedicated tab, filterable by
  date, item, and site, built entirely from data this system was already
  recording comprehensively but never surfaced as its own report.

## Testing this yourself

```
npm test
```
360 tests across 41 files.

## Deployment

The schema changed meaningfully this round — new columns on
`customer_order_items`, `supplier_bill_items`, and `material_return_events`,
a new `short_closed` status value, and two new chart-of-accounts entries
(Tax Input Credit, and the pre-existing Raw Material/Labor COGS accounts
are now actually used). Same process as always:
```
wrangler d1 delete fabroses-db
wrangler d1 create fabroses-db
wrangler d1 execute fabroses-db --file=./schema.sql --remote
```
If updating a live database rather than deploying fresh, these column
additions won't apply automatically — D1's schema file only creates
tables that don't exist yet, it doesn't alter existing ones.

## Honestly still open

- The item-photo cross-contamination bug from earlier in this project.
- The mobile card/bottom-nav layout still hasn't been confirmed on an
  actual phone by a human.
- Rework jobs still use the old single-item ship-back flow, unchanged —
  the Mark Job Done redesign only ever covered production jobs.
