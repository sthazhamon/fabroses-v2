# FabRoses Business System - this session's build

**511 automated tests, all passing.** Run `npm test` to verify yourself.

This batch worked through a full 19-issue review document, item by item,
each traced against the actual running code before anything was changed,
plus a substantial revision to the gamification system built in the
prior session.

## The root cause of "Mark Job Done cancels the WO"

Traced precisely: cancelled_at is only ever set by the dedicated "Cancel
this job" button - nowhere else in the codebase touches it. So Mark Job
Done itself never cancelled anything; the work order must have been
separately cancelled first. The real, underlying problem was that a
production job could be created at all for an item with no Bill of
Materials defined. Fixed by blocking that at creation time - rework
jobs are correctly unaffected.

Fixing this triggered a wide ripple: 11 existing test files had been
creating work orders against BOM-less items, and it surfaced one
genuine, latent fragility in production code - an unguarded property
access that had never been reached before, since the BOM loop it lived
inside had nothing to iterate over until now.

## The gamification revision

Tiers can now be freely relabeled (Regular, Silver, Gold, or anything
else) with no schema change. Level standing now uses an admin-
configurable rolling window instead of a calendar-year reset. A manual
override lets an admin restrict a reseller's level for outstanding
payments - proven directly that this only ever pushes a level down,
never inflates it. Alongside the existing rewards catalog, resellers
can now redeem points directly for a cash credit, posted as a real,
immediate ledger entry.

Building this surfaced a significant gap: the entire admin side of the
gamification system had been pure backend with no way to actually use
it. A complete "Reseller Program" admin tab now covers levels, the
rewards catalog, approving redemptions, and milestone creation.

The reseller's own portal now shows their outstanding balance and
account ledger, with the top ribbon color changing based on their level.

## Every other item from the review document

Auto-scroll to newly opened detail screens. Dispatch pick confirmations
show part number, description, origin ID, and a photo thumbnail. The
stock list shows a photo, receipt date, and QR per item. Party and user
editing, including self-service PIN changes. A genuine review-then-
confirm step for receiving, with a working site selector. A standalone
stock transfer between sites, proven to require the same physical
pick/ship/confirm flow as everything else. Full detail on Supplier
Bills. Party and date search applied consistently across four listings
using one shared filter. P&L figures now drill into the real underlying
ledger entries. The worker's own page now has clear, separated cards
per section instead of running-together plain text.

## Testing this yourself

```
npm test
```
511 tests across 66 files.

## Deployment

The schema changed again - a new manual_level_override column on
parties, and one new chart-of-accounts entry for cash-credit
redemptions. Same process as always: delete and recreate the D1
database, then load the schema file fresh.

## Honestly still open

The item-photo cross-contamination bug and the mobile layout
confirmation are both still open from earlier sessions.
