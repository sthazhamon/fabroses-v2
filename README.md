FabRoses Business System - this session's build

554 automated tests, all passing. Run npm test to verify yourself.

This batch worked through a second, 17-issue review document in full,
item by item, each traced against the actual running code before
anything was changed.

Real bugs found and fixed, not just features added:

- The QR mobile bug's actual cause - window.open() was being called
  asynchronously inside a setTimeout, which mobile browsers reliably
  block as an unauthorized popup. Fixed by opening the window
  synchronously, immediately, within the original click - the standard
  fix - with a guard against the resulting uncaught error that likely
  explains the "app refreshes" symptom.
- The QR-per-lot bug - the button was sitting on the aggregate item row,
  encoding only the item code with no lot at all. Moved to each
  individual expanded lot row, now correctly encoding item+lot together.
- A missing production stage - the first draft of the new Production
  Dashboard only accounted for four work order stages; a direct check
  against every actual stage-setting location in the codebase found a
  fifth (Material Received) that would have silently disappeared from
  the dashboard. Caught by a dedicated test before it shipped.
- A dropped function signature - while inserting the new CRM function, a
  str_replace edit accidentally deleted the line declaring the adjacent
  loadResellerLeaderboard function. Caught immediately and fixed before
  running the test suite.

The two substantial new pieces:

Production Dashboard - every work order grouped by real stage, with
customer/reseller name, expected delivery date, and overdue highlighting
pulled from the linked customer order, plus text search and a worker
filter.

CRM page - cumulative order value and approximate profit margin per
customer/reseller for a selectable period. The profit figure traces
genuine production cost through each sold item's own specific lot back
to its actual recorded Mark Job Done cost (raw material + labor), not an
estimate - proven with a test running a real production job through the
full costing pipeline.

Also new: the reseller leaderboard, ranked by current-period points,
with an up/down/same trend computed against the correct prior rolling
window - proven with resellers designed specifically to test the rising,
declining, and flat cases.

Every other item from the review document: the full navigation
restructured into six category dropdowns (Master, Purchase, Sales,
Production, SCM, Accounts). Catalogue filtering by category/fabric/work
type/pattern. Change PIN moved behind the login name. Party addresses,
with delivery-address override on Customer Orders, plus an address
print-out option while dispatching. The worker's material-receive
confirmation now genuinely requires scanning the item before accepting
it. The My Work page's action cards hide entirely when empty, start
collapsed, and include a past-records toggle. A "last shipments" list on
the worker's page reuses the exact tracking mechanism already built for
the store side.

Testing this yourself: npm test - 554 tests across 76 files.

Deployment: the schema changed this round - a delivery_address column on
customer orders and an address column on parties. Same process as
always: delete and recreate the D1 database, then load the schema file
fresh. If updating a live database in place instead, two ALTER TABLE
statements cover it.

Honestly still open: the item-photo cross-contamination bug from earlier
sessions. The nav restructure is a purely visual change that couldn't be
verified in an actual browser - the dropdown behavior is worth checking
by hand before fully trusting it.
