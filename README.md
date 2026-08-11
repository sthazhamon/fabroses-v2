# FabRoses Business System — v3, this session's build

**248 automated tests, all passing.** Run `npm test` to verify yourself
before trusting this with real data.

This session worked through a long list of real, reported problems one at
a time, then built them in order: photo visibility, Sales Return as its
own action, Customer Order billing routed through the real Sales form,
a worker-initiated raw material return, BOM-based reconciliation folded
into confirming a finished good, and a scan-to-verify gate before work can
start. Below is what actually changed, followed by two real bugs this
session's own testing caught and fixed along the way — worth reading, not
just the feature list.

## Work order and material flow

- **WIP photos are now actually viewable.** They were always being saved
  correctly — the display only ever showed a count. Real thumbnails with
  click-to-enlarge now appear in both the admin and worker views.
- **The "Start Work" gate is now consistent everywhere**, and it does more
  than it used to: before a worker can start, they scan or enter the item
  and lot for *every* raw material line issued on that job. Get it wrong,
  and they see exactly that — wrong material for this job — not a generic
  error. Get it right on every line, and only then does "Start Work"
  appear. A rework job with nothing to verify is never blocked.
- **BOM-based reconciliation is now folded into confirming a finished
  good.** When the store confirms a finished piece back, it now sees, for
  every raw material issued on that job: how much was issued, how much
  the BOM says should have been used, and a suggested return-to-stock
  figure — editable, not forced. Confirming the finished good and
  reconciling the raw material happen in one action, not two separate
  visits to two different screens.
- **Work orders now show the finished item's part number**, not just its
  name, and the "Material issued" table now shows which specific lot was
  used — the data was already being captured, it just was never displayed.

## Sales and billing

- **Sales Return is now its own action**, completely independent of
  Refund. Returning an item creates a new lot (never silently merged into
  the one it was originally sold from), moves no money, and is capped
  precisely by what was actually sold on that line — you can't return more
  than you sold, and can't return the same units twice.
- **Customer Order billing now goes through the real Sales form**, not a
  locked-down shortcut. A "Bill via Sales" button pre-fills the order's
  lines into Sales, with full control over tax and pricing, and a visible
  "This fulfills CO-XXXX" toggle — on by default, but you can turn it off
  if this particular sale shouldn't close out that order. The old
  shortcut endpoint is gone; every existing test that used it now goes
  through the real path instead.
- **Supplier Bills no longer requires a PO line to be fully received
  before it can be billed** — a real, confirmed bug. Billing now works
  correctly against whatever's actually been received and not yet billed,
  computed from genuine billing history rather than a status flag that
  billing never actually updated.
- **The outstanding-bills screen no longer shows "undefined"** — a
  genuine regression from when Sales became multi-line — and the
  confusing amount field that looked like an inert "Apply" button is now
  clearly labeled for what it actually is.

## Two real bugs this session's own tests caught — worth reading in full

**Reconciling a material issue was silently creating stock out of thin
air.** This bug predates this session — it's been sitting in the
reconciliation logic since it was first built — and it took building the
new BOM-reconciliation feature, with a test that actually checks total
stock conservation end-to-end, to catch it. My first attempted fix was
itself wrong: I decremented the issue's own `lot_id`, which turned out to
be a stable *reference* to the original store lot for lookup purposes —
never the worker's actual physical stock. A separate, older test (about a
lot deliberately split across two workers) caught that mistake immediately
by failing in a completely different way once I ran the full suite. The
corrected fix decrements the worker's real stock for that item via FIFO —
the same pattern already used correctly elsewhere in this exact codebase —
rather than touching an unrelated lot.

**The reconciliation model had no way to say "this was simply used up as
intended."** It could only understand explicit returns and wastage, which
meant a job where the raw material was cleanly and fully consumed, with
nothing left over to report, could never actually close. Fixed with a
`close_fully` mode, used specifically when reconciliation happens as part
of confirming a finished good — the point at which a job's material story
really is complete, whether or not every gram was formally categorized.

Both fixes are proven with tests, and every pre-existing test that
exercised this code — including the one that first caught the mistake —
still passes.

## Worker-initiated raw material return

Checked against what was already built: this turned out to already
exist, fully working, from earlier in this project — a worker can send
leftover raw material back to the store as a plain stock transfer, not
tied to any specific job, going through the real two-step dispatch
process, with FIFO reconciliation against whichever open material issues
are oldest. Nothing needed to be built here; it was verified and left
untouched.

## Real mistakes caught and fixed along the way, this session

A malformed variable reference left over from a rename (caught by the
syntax checker immediately), a wrong assumption about which quantity is
returnable versus billed, and several test-math errors in my own new
tests (an incorrect assumption about how `sale_price` is stored, a POST
response that never claimed to return an ID it was assumed to have) — all
caught by actually running things rather than assuming they'd work, and
all fixed before being called done.

## Testing this yourself

```
npm test
```
248 tests across 25 files, including a real end-to-end suite
(`frontend-integration-test-v2.mjs`) that starts an actual HTTP server and
drives it with the exact request shapes the frontend itself sends —
including every new feature from this session.

## Deployment

The schema changed again this session (sales returns, verification
timestamps) — if deploying fresh:
```
wrangler d1 delete fabroses-db
wrangler d1 create fabroses-db
wrangler d1 execute fabroses-db --file=./schema.sql --remote
```
Then bootstrap your admin login and push, same as every time before.

## Honestly still open

- **The item-photo cross-contamination bug** from earlier in this project
  — still unresolved, still needs the URL comparison originally asked for
  before it can be diagnosed rather than guessed at.
- **Whether Customer Order *shipping* itself should become a real
  two-step dispatch** — raised as a question this session, never
  explicitly answered before we moved on to other things. Left alone
  rather than decided unilaterally.
- The mobile card/bottom-nav layout from the prior session still hasn't
  been confirmed on an actual phone by a human.
