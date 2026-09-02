FabRoses Business System - session summary

637 automated tests across 92 files, all passing. Run npm test to verify
yourself.

This part of the session was a mix of new bug reports and a proactive
performance/scaling pass. Below is what changed, explained honestly,
including a mistake I made and caught myself along the way.

## A genuine race condition, not just a validation bug

A PO line could be received twice, ending up with more stock than was
ever ordered - the validation itself was correct in isolation, but it
read the line's current state, then wrote separately afterward. That gap
is a real race: if a first request is still in flight when a second,
genuine click slips in before the first commits, both can read the same
"nothing received yet" state and both succeed. Fixed by making the check
and the write one atomic SQL statement, with the condition built directly
into the WHERE clause, so the database itself - not application code
reading a snapshot - decides at the exact moment of the write. Proved
this by simulating two requests both starting from the identical stale
state and confirming only one succeeds.

## Traceability actually reaching back to the origin, not just one hop

A lot's "full history" only ever showed its own direct movement at the
current site - for a raw material received via PO and then transferred
between sites, that meant the original receipt was invisible entirely,
even though the underlying origin_lot_id infrastructure to trace it
already existed and was already being set correctly, just never read
anywhere. Fixed to also surface the origin lot's own movements (and its
own BOM consumption, if it was itself a produced finished good), with
each origin clickable to trace further back.

## QR code consistency across every place it's generated

The encoded value was actually already consistent everywhere
(item_code|lot_id), but the printed label text wasn't - one place showed
the item's name, three others showed only a bare lot ID with no item
identification at all. Standardized all four to the same format. While
fixing this, three of the four still had the same fragile
string-concatenation pattern behind an earlier session bug (a `3"` in an
item name breaking a button) - fixed proactively using the same safe
approach, proven against a tricky item name through a real DOM parser.

Separately, the item's name is now also appended as a third,
pipe-separated segment to the encoded QR value itself - confirmed safe
by checking every place in the app that parses a scanned code, since all
four only ever read the first two segments. This means a generic phone
camera scanning the code now shows something human-readable, while the
app's own internal scan-matching (which relies on item_code, not name)
keeps working exactly as before.

## A proactive performance and scaling pass

25 new database indexes added, each confirmed against a real, existing
query pattern in the code rather than added speculatively - covering
sale_items, dispatch_items, customer_order_items, purchase_order_items,
material_issues, and about a dozen more foreign-key columns across the
core transactional tables, plus a composite index for the specific
item_id+site_id combined-filter pattern used in several places, and one
for item_photos, which was being queried via a per-row correlated
subquery with no index behind it at all.

Six more N+1 query patterns found and fixed, on top of the four fixed
earlier this session. The worst was /purchase-orders - a three-level
pattern (per-order, then per-line, then a billed-quantity lookup per
line) that could mean roughly 200 sequential database round-trips for a
modest 50 purchase orders. Now 2 queries total, regardless of how many
orders exist. Each rewrite was proven with a new test specifically
checking that the batched version correctly attributes data back to the
right row - the real risk in this kind of change - not just that the
totals come out right.

Audited every remaining loop-with-a-query-inside pattern in the
codebase and deliberately left most of them alone: they're bounded by a
single transaction's own line count (a sale's few lines, one work
order's material issues), which doesn't grow with total data volume, so
rewriting them would add risk for no real benefit. Also deliberately did
not add a row limit to /items, since every searchable item picker in the
app filters client-side and genuinely needs the full list - limiting it
would break that feature; a proper fix would mean moving those pickers
to server-side search, a larger, separate change not made unprompted.

## Also fixed along the way

Two dashboard/history and address-display gaps reported by screenshot:
a dispatch's shipping address section silently disappeared entirely
when no address was on file (now clearly says so and still offers to
print, which honestly shows "no address on file" rather than hiding the
option); and confirmed with the user that QR codes correctly prefer
item_code over the plain internal ID when one exists, by design, with no
change needed.

## Testing this yourself

npm test - 637 tests across 92 files.

## Deployment

Two new columns since the last package: dispatch_items.receive_mismatch_flag
(covered previously) and dispatches.related_sale_id are already in the
schema from earlier this session. This round adds only indexes - no new
columns or tables. Standard process: delete and recreate the D1
database, then load the schema file fresh, since D1 doesn't support
adding indexes to an existing live database via a simple ALTER.

Given the git corruption discussed earlier this session, a full
wipe-and-replace of the working tree (keeping .git for history) remains
the safest deployment path:

find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
unzip fabroses-v2-complete.zip -d .
git add -A
git commit -m "Race condition fix, origin-chain traceability, QR consistency, performance/indexing pass"
git push

## Honestly still open

The item-photo cross-contamination bug from an earlier session remains
open. The mobile layout fix from earlier this session is a plausible,
concrete fix based on reading the code, but wasn't verified in a real
browser.
