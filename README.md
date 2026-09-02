FabRoses Business System - session summary

610 automated tests across 87 files, all passing. Run npm test to verify
yourself.

This session had two batches of work: an initial round of workflow and
performance fixes, followed by a 12-issue batch from a fuller bug report
(fabro3.pdf). Below is what changed, with the hardest problems explained
honestly, including mistakes caught and corrected along the way rather
than hidden.

## The hardest problem this session: raw material cost never reaching COGS

Confirmed by tracing the actual code, not guessing: every raw material lot
in the entire system had cost_total = null, regardless of when a supplier
bill was entered. The receive endpoint only set cost from an explicit
value the frontend never actually sent. Fixed to default to the PO's own
agreed rate at receive time, then retroactively refine to the real billed
rate when a bill later arrives - but only for stock not yet consumed,
since anything already used in a completed job keeps its originally
locked-in cost.

While proving that fix end-to-end, a SECOND, separate bug turned up: even
with a lot correctly costed, that cost silently vanished every time
material physically moved between sites via a dispatch, because the new
lot created at the destination never inherited it. Both are now fixed and
proven together through a full PO -> receive -> dispatch to worker ->
consumption -> Mark Job Done pipeline test.

## Other confirmed bugs, traced to their exact root cause

An item name containing a double-quote character (a "3 inch" fabric)
silently broke the receive button - exactly as diagnosed in the report.
The onclick handler embedded the raw name in a string that only escaped
single quotes, not double quotes. Same fragile pattern as an earlier
"print address" bug this session, fixed the same way: real HTML
attributes plus proper escaping instead of string concatenation, proven
against the exact reported item name through a real DOM parser.

A duplicate "confirm receipt" click showed "hasn't been shipped yet" even
though the first click had already succeeded and added the stock - which
looked like data corruption but wasn't. Fixed with an app-wide,
capture-phase click guard that briefly disables any button after it's
clicked (proven with a real DOM simulation: 3 rapid clicks now correctly
fire the handler exactly once), plus a distinct, honest "already done"
message instead of a confusing generic failure.

A sale from a worker's own stock (no formal customer order behind it)
created no dispatch at all - the worker was never notified anything
needed to ship. The existing shipment-dispatch logic only ever fired when
a sale was formally linked to a CO. Fixed to also fire whenever stock
genuinely came from a worker site. Caught and corrected two of my own
mistakes while building this: an over-narrow first pass broke the
existing CO-based case entirely (caught immediately by the regression
count dropping), and my own test then found a second gap where a
customer's name wasn't resolving when only a party link existed with no
separate name text.

Selling an item that came from a sales return was blocked with "each line
needs a description and sale_price" - traced back to description being
mandatory but never auto-filled from the selected item, blocking any sale
where someone picked an item without also manually retyping its name.
Fixed on both ends: the backend now derives a sensible description from
the item's own name, and the frontend auto-fills it visibly.

## Real, app-wide UX and robustness fixes

Error messages were small text at the top of the page that auto-hid in 6
seconds, often unseen. Now they scroll into view and require explicit
dismissal.

Every button that triggers an action now briefly dims and blocks a second
click, preventing accidental duplicate entries app-wide.

A "shipping to" section on dispatches would silently disappear entirely
when a destination had no address on file, with no explanation. Now it
clearly says so and still offers to print, which honestly shows "no
address on file" rather than hiding the option.

A worker's scan-confirmation table used fixed-width inputs across 5
columns that could exceed a narrow mobile viewport, combined with no
overflow protection on the page at all - the most plausible concrete
cause of a reported layout/clipping issue on mobile. Fixed the table to
scroll within itself and added the missing page-level safety net. Honest
caveat: this can't be verified in a real browser, so it's the most
plausible fix found in the code, not a certainty.

## Real enhancements, built and tested

A shared, reusable searchable-item-picker pattern, applied consistently
across work order creation, sales lines, and customer/purchase order
lines - typing filters the list instead of scrolling through the whole
catalogue.

Work order material linking was redesigned at explicit direction: no more
automatic dispatching at creation. It now only suggests material from the
BOM; nothing moves until someone explicitly confirms it, choosing a real
lot themselves. This was a genuine behavior change - it broke 7 existing
tests that depended on the old automatic behavior, and one function had
zero remaining callers afterward and was removed entirely rather than
left as dead code.

Three genuine performance problems were fixed with measured, proven
improvement, not just theorized: /parties, /reports/pnl, and /crm were
each issuing dozens to hundreds of sequential database round-trips per
call. Now 2-3 queries each, regardless of data volume, with tests proving
the batched math matches the original per-row computation exactly.

Lot traceability now shows what a finished item was actually made from -
tracing back through the specific raw material lots consumed during
production, not just the finished lot's own movement history.

The dispatch list and tracking modal now show shipping name and item,
not just a DSP number. The dashboard's "needs attention" section gained
three new categories: work orders still in progress, finished goods
sitting unsold, and finished items with no BOM entered at all (which
silently blocks work order creation).

The reseller portal's "My orders" was missing any sale that never had a
formal customer order - confirmed directly from a screenshot where a sale
appeared in the ledger but nowhere in the orders list. Now includes both,
clickable to reveal ship date, courier, and tracking.

The sale price field now correctly pre-fills from a customer order's own
recorded price when billing through that order, staying fully editable.

## Also fixed along the way

One unrelated, pre-existing test bug: a milestone test hardcoded a
calendar date range that had simply expired as real time passed it -
now uses relative dates so it can't break again regardless of when it
runs.

## Testing this yourself

npm test - 610 tests across 87 files.

## Deployment

New columns since the last package: dispatches.related_sale_id. Schema
already includes the earlier receive_mismatch_flag columns too. No new
tables this round. Standard process: delete and recreate the D1
database, then load the schema file fresh.

Given the git corruption discussed earlier this session, a full
wipe-and-replace of the working tree (keeping .git for history) remains
the safest deployment path:

find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
unzip fabroses-v2-complete.zip -d .
git add -A
git commit -m "This session's fixes: COGS pipeline, worker dispatch notification, UX robustness"
git push

## Honestly still open

The item-photo cross-contamination bug from an earlier session remains
open. The mobile layout fix (issue 3) is a plausible, concrete fix based
on reading the code, but wasn't verified in a real browser - worth a
click-through on an actual device.
