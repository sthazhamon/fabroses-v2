# FabRoses Business System — v3, complete build

**194 automated tests, all passing.** Run `npm test` to verify yourself
before trusting this with real data.

This session covered a long list of real, reported problems and design
decisions, worked through one at a time and built in the same order:
worker-flow bugs, form-reset and dropdown-default bugs, camera scanning,
multi-line documents, work-order cancellation, party-site linking,
tracking history, full lot traceability, a real Bill-of-Materials system
with automatic stock checking, rework tracking, and a full visual redesign
into a card-based, bottom-nav mobile layout. Below is what actually
changed, organized by area, followed by what's honestly still open.

## Work order lifecycle — the biggest structural change

- **Reassignment is gone entirely.** It used to be possible to reassign a
  worker mid-job, which left material tracking silently pointing at the
  wrong site. Now a work order is either cancelled (freeing up its
  customer-order line for a fresh one) or it stays with the worker it
  started with. A real test proves reassignment is rejected outright.
- **Cancelling** frees the linked customer-order line so a new work order
  can be created for someone else. Any material already issued stays
  exactly where it is — cancelling never touches it; it's resolved
  independently through the normal material-return process. Blocked once
  the job's already shipped back.
- **A finished item is now mandatory on every work order**, not optional —
  this is what makes the Bill of Materials system below possible.
- **The worker-facing "Ship the finished piece back" screen used to allow
  shipping the same job twice.** Both the frontend (the whole page now
  goes read-only once shipped) and the backend (a hard rejection) close
  this off. It also no longer asks the worker to identify the item — it
  already knows, from the work order itself.

## Bill of Materials — real, tested, three-way stock logic

Catalogue items can now carry a BOM (multiple raw materials, each with its
own required quantity). Creating a work order automatically:
1. Checks the **worker's own site** first — if they already have enough
   left over from a previous job, a real, reconcilable material issue gets
   created with **no physical movement** at all.
2. Otherwise checks the **store**, auto-creating a pending stock-transfer
   dispatch — genuinely combining **multiple lots** if one alone isn't
   enough, each becoming its own line so the normal pick/ship process
   still applies to every one of them.
3. If neither has enough, the line is left **genuinely unmet** — no fake
   dispatch, no fake issue — and it surfaces through the *existing*
   dispatch queue, the same detection that was already there.

The work order form shows this live: suggested quantities computed from
the BOM, current stock at both locations, and the creator can override
any quantity before submitting.

## Rework tracking

A finished piece needing correction now goes through its own tracking
(`rework_issues`), structurally mirroring raw material but for a specific
already-made lot — supporting more than one correction cycle before a
piece is actually right, and showing up alongside ordinary movements when
that lot's full history is viewed.

## Multi-line documents

Purchase Orders, Sales, Customer Orders, and Supplier Bills are all
genuinely multi-line now — different PO lines can be received on
different days, each sale line carries its own tax rate, and billing a
multi-item customer order creates one matching multi-line sale. A real
customer-order bug from testing — creating a work order for one line was
silently hiding a second, still-unaddressed line from ever showing up
again — is fixed and specifically tested, with the order's status now
correctly showing **partially_fulfilled** when only some lines are covered.

## Party, site, and tracking fixes

- **Sites can now be linked to a user** — either at creation or after the
  fact. This capability didn't exist at all before; there was no way to
  attach a login to an already-existing site.
- **Tracking info is now immutable once first entered.** Every correction
  after that becomes a permanent, dated note rather than silently
  overwriting the original — applied to every dispatch type, not just one.
- **Full lot traceability** — every movement a lot has ever made, plus any
  rework cycles, viewable by clicking into that specific lot, using data
  that was already being captured but never surfaced anywhere.

## Camera scanning and other real bugs

- Real camera QR scanning wired into every field that previously just
  said "Scan or enter" without any actual capability behind it — fixed a
  genuine inconsistency in the QR payload format along the way.
- **Every one of the 12 creation forms now resets** after saving — 11 of
  12 previously reset nothing at all.
- **Dropdowns no longer silently default** to the first alphabetical
  entry — this was a real risk of billing, paying, or assigning work to
  the wrong person.
- **Cache-busting** added on every API call, both client-side and via an
  explicit header at the middleware level, addressing observed staleness
  when switching tabs.
- Item photo cover now updates on a new upload; full-size photo viewing
  added; Stock-by-Site is aggregate-by-default with click-to-expand into
  individual, directly-editable lots.

## Visual redesign

- **Bottom tab bar on mobile** (icon-led, role-aware, with a "More" sheet
  for anything that doesn't fit), **top strip retained on desktop**.
- **Every list in the app is now card-based** — Work Orders, the Dispatch
  and Receive queues and their history, Purchase Orders, Sales, Customer
  Orders, Supplier Bills, Expenses, Parties, Users, Sites, My Work's four
  lists, and outstanding-bill selection in Payments.
- Left deliberately as tables, since they're genuinely tabular data, not
  browsable lists: the P&L/Ledger financial views, line-item tables inside
  an already-open detail card (a PO's lines, a sale's lines), and
  Stock-by-Site's aggregate-then-expand structure.

## Real mistakes caught and fixed along the way

Worth naming plainly rather than glossing over: a foreign-key ordering bug
in the sales engine, an unhandled crash in customer-order billing, a wrong
import path, orphaned dead code left behind after removing reassignment,
a malformed-quote JavaScript syntax error, and an empty-string falsy-value
bug in the card-list helper. Every one was caught by actually running the
tests or the syntax checker — not assumed away — and each has a test
covering it now so it can't silently come back.

## Testing this yourself

```
npm test
```
194 tests across 20 files, including a real end-to-end suite
(`frontend-integration-test-v2.mjs`) that starts an actual HTTP server and
drives it with the exact request shapes the frontend itself sends.

## Deployment

The schema changed again this session (BOM, rework, multi-line documents,
tracking notes, cancellation) — if deploying fresh:
```
wrangler d1 delete fabroses-db
wrangler d1 create fabroses-db
wrangler d1 execute fabroses-db --file=./schema.sql --remote
```
Then bootstrap your admin login and push, same as every time before.

## Honestly still open

- **The item-photo cross-contamination bug** reported early in this
  project — still can't diagnose it without the URL comparison originally
  asked for. Guessing at a fix here risks papering over the real cause.
- The bottom-nav "More" sheet and card conversions haven't been seen in an
  actual mobile browser by a human yet — only verified through code review
  and the test suite. Please look at it on a real phone before relying on
  the layout.
- Reseller-role logins currently have no tabs defined for them in the
  navigation at all — a pre-existing gap noticed while building the nav,
  not something introduced this session, but worth knowing about.
