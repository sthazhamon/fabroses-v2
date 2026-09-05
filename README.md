FabRoses Business System - session summary

742 automated tests across 100 files, all passing. Run npm test to verify
yourself.

This part of the session covered a major architectural redesign (lot
number stability) at explicit user direction, followed by a full pass
through the fabro5.pdf bug batch (items #1-#11) plus three items added
later in the same report (#12-#14), then an extension of #13's account
selection to the other cash-movement screens. Below is what changed,
explained honestly. Everything in that report is now addressed except the
two long-standing carryovers noted at the bottom.

## The lot number stability redesign

Previously, every time material physically moved between sites, a brand
new lot ID was created at the destination - meaning the same physical
batch of material had a DIFFERENT number depending on where it currently
sat, and a QR code printed today could show a "stale" number tomorrow if
the material moved again before that label was used. This was traced
directly to two real bugs reported earlier: confusion over which lot
number to scan, and an encoded QR value silently mismatching its own
printed label.

At the user's explicit direction, after discussing the tradeoffs
(specifically: a lot can genuinely split across multiple sites at once,
so it can't become one single mutable "current site" field), the fix
uses infrastructure that already existed but was never surfaced: a
stable "origin" identifier that already tracked a batch through every
transfer, quietly in the background. That origin ID is now the number
shown and scanned everywhere - QR codes, stock lists, work order
material, dispatch views - while the underlying per-site records
(needed to support real partial splits) became an internal detail.

This was proven, not just asserted, with a test simulating the exact
real-world case: material transferred twice since a QR was first
printed, confirming that scanning the ORIGINAL number still correctly
matches a dispatch two moves later. A second test proves a genuine
partial split (4 of 10 units transferred, 6 staying behind) correctly
shows as the same stable number sitting at two sites simultaneously,
with quantities adding up correctly. Movement history and BOM-level
traceability were both explicitly re-verified intact throughout this
change, per the user's requirement.

## New work order material-status indicator

A work order's own progress stage (Order Placed, Work Started, etc.)
only tracks the JOB's progress, not the material's own journey - meaning
a job could have material already assigned, in transit, or received,
while still displaying as if nothing had happened. Added a separate,
explicit indicator computed from the actual dispatch and material-issue
state (not assigned -> assigned -> in transit -> received, awaiting
worker verification -> verified). Proved all 5 real-world stages
individually with a dedicated test, including the "material already at
the worker's own site" shortcut case.

## Dashboard work order cards now show what job this actually is

Previously showed only the WO's own generic description text (typically
just "For order CO-XXXXXX"), with no indication of which item was
actually being produced or for whom. Now shows the item name and, for
a CO-linked job, the customer or reseller name. Checked directly, not
assumed: this dashboard is already restricted to admin/accountant roles
in the navigation, so worker logins never see this tab at all - the
customer-privacy concern the user raised turned out to already be
structurally satisfied by an existing restriction, not something that
needed new code.

## Two smaller, real fixes

The item search field (built earlier this session) had a genuine bug,
not just a rough edge: focusing an already-filled search box re-showed
the current selection as if it were a "matching result of itself,"
creating a confusing appearance of two separate item fields. Fixed by
only auto-showing the full list on focus when nothing is selected yet.

Added an explicit refresh button to the header, since iOS Safari is
documented to be unreliable at automatically detecting PWA updates -
this gives a manual, reliable way to force a fresh load when the
automatic mechanism doesn't catch it.

## Testing this yourself

npm test - 667 tests across 98 files.

## Deployment

No new database columns or tables this round - this is a pure code and
query change on top of infrastructure that already existed in the schema.
Standard delete-and-recreate-database process still applies if
deploying alongside any earlier, not-yet-live schema changes from this
session.

Given the git corruption discussed earlier this session, a full
wipe-and-replace of the working tree (keeping .git for history) remains
the safest deployment path:

find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
unzip fabroses-v2-complete.zip -d .
git add -A
git commit -m "Lot number stability redesign, WO material status, dashboard item/customer visibility"
git push

## fabro5.pdf items #3-#14 — all addressed this session

- **#3 Cancel a pick** — new "Undo pick" action on a picked-but-not-yet-shipped
  dispatch. Clears the scan and drops it back to pending_pick, distinct from
  "Cancel this dispatch" (which cancels the whole thing outright).
- **#4 Site addresses on dispatch notes** — sites now capture address and
  phone at creation; dispatch/receive screens show both the ship-from and
  ship-to address, not just the destination.
- **#5 Dashboard material in transit** — new "Material in transit between
  sites" list on the dashboard (internal transfers only; customer shipments
  are covered by the delivery-confirmation item below instead).
- **#6 Customer delivery confirmation** — customer shipments now have an
  explicit "Confirm delivered" step, separate from just having been shipped.
  The order only reaches a genuinely final 'delivered' status once someone
  confirms it; a new dashboard list shows what's still awaiting that.
- **#9 Photos on material movement pages** — photo upload added to both the
  dispatch pick/ship screen and the receive-confirm screen.
- **#10 Photo/product context on the worker's verify screen** — the raw
  material's own catalogue photo now shows next to each item to verify, and
  the finished item's photo shows at the top of the job.
- **#11 User-defined item codes** — item code/SKU is now a normal editable
  field the user fills in (e.g. an existing online-store SKU); leaving it
  blank still falls back to the old auto-generated combo code.
- **#12 Named cash/bank account heads** — admin can now add accounts like
  "Bank A" / "Cash B" from the Journal tab, alongside the built-in Cash and
  Bank.
- **#13 Payment account selection** — recording a payment received or paid
  now asks which cash/bank account it actually moved through, instead of
  silently assuming the one built-in Cash account.
- **#14 Address/phone edit for parties and sites** — parties already had
  this; sites now have the same edit capability.

43 new automated tests cover items #3-#14 (test/system-test-fabro5-followups.mjs), plus 4 more covering the extension below.

Per your follow-up, #13's account selection is now consistent everywhere money
actually moves: Expenses, Refunds, Supplier Bills (cash purchases), and
walk-in Sales all now have their own "which account" dropdown in the form
itself, right alongside the three original payment screens. Every one of
them still defaults to the built-in Cash account if nothing's chosen, so
nothing changes for existing data.

## Cross-system consistency check (test/system-test-cross-system-consistency.mjs)

Requested explicitly this session: one integrated test walking QR/scan
resolution, stable lot numbers, material movement, and payments through a
single realistic scenario together, rather than as isolated unit tests.
It covers:

- A raw material lot moving store → workerA → workerB (three distinct lot
  ids at the three sites), scanned at each hop by item_code and, on the
  second hop, by the ORIGINAL stable lot number printed on day one — still
  resolves correctly two hops later.
- A dispatch photo and from/to site addresses stay correctly scoped to
  their own dispatch — no cross-contamination between two separate
  shipments of the same material.
- The full work order lifecycle at the final site: issue → scan-verify →
  work started → mark done, consuming exactly the BOM-required amount.
- The origin lot's history correctly shows movement through every site it
  actually passed through.
- A global ledger trial balance (sum of every debit vs every credit
  across the ENTIRE journal) after mixing sales, refunds, expenses,
  supplier bills, and payments through two custom accounts plus the
  built-in ones — confirming the account-selection work added this
  session hasn't broken double-entry consistency anywhere.
- Each individual account's own running balance reconciles to exactly
  what was actually routed through it.

28 checks, all passing.

## Still genuinely open

The item-photo cross-contamination bug from an earlier session remains
open, as does final verification of the mobile layout fix from earlier
this session in an actual browser.
