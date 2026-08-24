FabRoses Business System - this session's build

570 automated tests, all passing. Run npm test to verify yourself.

This session started as bug reports against the previous deployment and
grew into a genuine workflow redesign, plus real performance work. Below
is what changed, with the hardest problems explained honestly, including
mistakes caught and fixed along the way rather than hidden.

## The two hardest, most consequential changes

Work order material linking was redesigned at the user's explicit
direction. Previously, creating a work order automatically dispatched
raw material based on the BOM the moment it was created - picking a lot
and moving stock without anyone choosing which specific lot to use or
confirming the quantity first. That's now gone entirely. Creating a work
order only computes and shows a material suggestion (item + quantity
from the BOM); nothing is reserved or moved until someone explicitly
confirms it on the work order itself, choosing a real lot. This was a
genuine behavior change, not a bug fix - it broke 7 existing test files
that depended on the old automatic behavior, and one function
(fulfillBomLines) had zero remaining callers afterward and was removed
entirely rather than left as dead code. Every one of the 7 tests was
rewritten to exercise the new, explicit flow and verified passing before
moving on.

Three real performance problems were found and fixed, not just
theorized about. /parties (called constantly by nearly every dropdown
in the app) was issuing two separate database round-trips per party -
for 30-50 parties, that's 60-100+ round-trips on a single call.
/reports/pnl (loaded on every dashboard visit) issued a separate
round-trip per account. /crm had a three-level nested pattern - per
customer, per sale, per line item - easily 300+ round-trips for a
modest customer base. All three are now 2-3 queries total, regardless
of how much data exists. Each rewrite was checked two ways: the
existing tests for that endpoint still pass with identical output, and
a new test proves the batched math matches the original per-row
computation exactly.

## Real bugs found and fixed, not just features added

A receipt could silently record more or less than what was actually
shipped, with nothing to catch it - confirmed against the user's own
exact reported case (1 sent, 2 received). Now flagged clearly, both on
the dispatch itself and in the dispatch history list, without blocking
the receipt (since legitimate over/under-shipments can happen).

The "Print address" button did nothing when clicked. The actual cause:
the address was embedded directly into an inline onclick string with
only double-quotes escaped - any address with an apostrophe or a line
break (i.e. almost any real postal address) silently broke the
JavaScript syntax. Rebuilt using data attributes instead of string
concatenation, with a proper HTML-escaping helper. This was verified
with a real DOM parser, not just by reading the code - the exact
tricky case (an address with both an apostrophe and multiple lines) was
round-tripped through jsdom and confirmed to match the original exactly.

The nav dropdown menus weren't opening at all. The cause:
overflow-x:auto on the nav bar, with no overflow-y set, which the CSS
spec forces into a scroll container on both axes - silently clipping
any dropdown menu extending below the bar's own height. Fixed by
letting the nav wrap to a second line instead of scrolling, sidestepping
the spec ambiguity entirely rather than working around it.

apiFetch called res.json() unconditionally, without checking if the
response was actually JSON first. Any server-side problem (a bad
deployment, a crashed function) surfaced as a cryptic
"unexpected character at line 1" error with zero useful information.
Now reports the actual HTTP status and the start of the raw response,
which should make any future issue like this immediately diagnosable
instead of a mystery.

A work order created "from" a customer order was traced precisely: it
goes through the exact same code path as a manually-created one - there
was no separate CO-specific shortcut causing the reported behavior, it
was the shared work order creation logic itself.

## Also built this session

A shared, reusable searchable-item-picker pattern, applied consistently
across work order creation, sales lines, customer order lines, and
purchase order lines - typing filters the list instead of scrolling
through the entire catalogue. Built to avoid touching any existing
value-reading code: the underlying select elements keep their original
IDs and behavior, so nothing downstream needed to change.

The reseller portal's "My orders" was missing any sale that never had a
customer order created for it - confirmed directly from a screenshot
where a sale appeared in the account ledger but nowhere in the orders
list. Now includes both, with each order clickable to reveal ship date,
courier, and tracking - discovered that this data already existed
directly on the customer order record and just needed surfacing, which
meant less backend work than originally expected.

The sale price field now correctly pre-fills from the customer order's
own recorded price when billing is done via that order, while staying
fully editable - traced to a single missing field in the prefill object,
where both sides of the data already existed but were never connected.

## Testing this yourself

npm test - 570 tests across 80 files.

## Deployment

Two new columns since the last package: dispatch_items.receive_mismatch_flag
and item_lots/dispatch related fields already covered in the schema. No new
tables this round. Standard process: delete and recreate the D1 database,
then load the schema file fresh.

Given the suspected git merge corruption discussed this session, a full
wipe-and-replace of the working tree (keeping .git for history) is the
safest path back to a known-good state:

find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
unzip fabroses-v2-complete.zip -d .
git add -A
git commit -m "Reset to known-good build after this session's fixes"
git push

## Honestly still open

The item-photo cross-contamination bug from earlier sessions remains
open. The nav restructure's dropdown behavior (now fixed for the
overflow bug specifically) is still worth a final click-through on a
real device, since visual/interactive behavior is the one category of
bug these automated tests cannot catch.
