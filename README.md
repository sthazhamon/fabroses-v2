# FabRoses Business System - this session's build

**439 automated tests, all passing.** Run `npm test` to verify yourself
before trusting this with real data.

This is the largest single batch in this project's history - thirteen
distinct items, most found through actual use of the previous build
rather than planned in advance. The centerpiece is a complete reseller
gamification system, built alongside a genuine traceability redesign and
several real correction mechanisms. Below is what changed, with the
hardest problems explained in enough detail to actually trust the fix.

## The reseller gamification system

A dedicated portal (fixing a "plain page" gap that dated back to the very
start of this project), points earned proportional to order value but
only once a sale is genuinely fully paid (not at billing), a yearly-
resetting level standing completely independent of a never-resetting
spendable balance, an admin-curated rewards catalog with an approval-and-
ship fulfillment flow, and time-bound milestones an admin can target at
specific resellers.

Three real bugs surfaced while building this, all caught by tests
actually failing, not by guessing:

1. A column-name collision - selecting rmt.*, m.* together silently let
   m.id overwrite rmt.id in the resulting row, meaning the "achieved"
   marker on a milestone was never actually being written, despite the
   code appearing to set it correctly.
2. An overly-restrictive date check - requiring "today" to fall within a
   milestone's window broke any scenario testing a different month than
   the real current date, when the only thing that should matter is
   whether the milestone has expired.
3. A real security gap - the redemption-request endpoint originally
   accepted any reseller_party_id in the request body, meaning a
   reseller login could technically request rewards, or view redemption
   history, on behalf of a completely different reseller. Fixed by
   forcing a reseller-role login to only ever act on their own identity.

Also proven directly: overcommitment protection across multiple pending
reward requests, and the genuine independence of level standing from
spendable balance.

## The traceability redesign

Every lot now carries a permanent origin reference, inherited unchanged
through every split and transfer, proven with a test tracking the same
physical batch through three real hops and confirming the same original
delivery stays the recorded origin the entire way. QR printing now
encodes that origin rather than a transient lot ID, and Mark Job Done
now prominently displays the finished piece's ID for a worker to write
down before shipping.

## Correction and safety mechanisms

- Void a wrong receipt - safely reverses either a PO-line receipt or a
  dispatch confirmation, checking first that nothing's already been
  consumed from what it created.
- Dispatch cancellation extended to "picked," not just "pending_pick" -
  the boundary now correctly sits at "shipped."
- Admin close-as-loss for a shipped-but-never-confirmed dispatch - posts
  a real ledger entry, visible in the movement register.

## Everything else in this batch

Dashboard highlights for unactioned orders and overdue work orders, a
Customer Order cancellation button, and the discount auto-apply at
billing for a reseller's current level.

## Testing this yourself

npm test - 439 tests across 51 files.

## Deployment

The schema changed substantially this round - six new tables for
gamification, a new origin field on lots, a new system_settings table,
and a new loss-tracking account. Same process as always: delete and
recreate the D1 database, then load the schema file.

## Honestly still open

- The item-photo cross-contamination bug from earlier in this project.
- The mobile layout fix from last round still needs confirming on a
  real phone.
- Rework jobs still use the old ship-back flow, unchanged.
