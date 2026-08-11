# FabRoses Business System — this session's build

**310 automated tests, all passing.** Run `npm test` to verify yourself
before trusting this with real data.

This session's centerpiece is a genuine redesign of how a worker
completes a job: raw material now consumes at a deliberate "Mark Job
Done" action rather than being folded into shipping, and shipping itself
becomes a plain, bundleable stock transfer — a worker can now select
several finished pieces and leftover raw material together and send them
back in one dispatch, rather than one action per item. Below is what
changed, followed by the real conflicts this redesign surfaced with
things built earlier — worth reading, since several were only caught by
tests actually failing, not by inspection.

## The redesigned worker flow

- **Mark Job Done** is a new action, available once work has started. It
  consumes the BOM-expected raw material and creates the finished-good
  lot right at the worker's own site — plain stock from that point on,
  not a special "in transit" state.
- **My Own Stock is now a single, unified, multi-select list** — finished
  goods and leftover raw material together, each with a checkbox and an
  editable quantity. One "Ship selected" action bundles whatever's
  checked into one dispatch.
- **Confirming a bundle credits each work order independently** — if two
  different jobs' outputs travel in the same shipment, each one's
  progress and closure is tracked correctly on its own, with no
  cross-contamination between them. This is proven directly: a dedicated
  test bundles two jobs' outputs plus raw material into one dispatch and
  confirms each work order closes independently.
- The old single-item "Ship the finished piece back" screen is now shown
  only for rework jobs, which still work exactly as before — production
  jobs use the new flow throughout.

## Four real bugs this session's own tests caught in a row — worth reading

Building Mark Job Done wasn't a single clean addition — it surfaced a
chain of real conflicts with mechanisms built earlier this session, each
one only found because a test failed, not because it was anticipated:

1. **The existing BOM auto-fulfillment was already immediately consuming
   raw material the moment a job was created** — directly contradicting
   the new premise that consumption happens later, at Mark Job Done.
2. **Fixing that reintroduced an overcommitment bug** fixed earlier this
   session, just in a new place — two jobs could both see the same
   "available" stock and both reserve it, since reservation no longer
   immediately decremented.
3. **That fix itself had a real flaw** — it was attributing an item's
   entire site-wide reservation against whichever single lot happened to
   be checked, which would have wrongly blocked a valid return from a
   completely unrelated, genuinely-free lot of the same item.
4. **A timestamp tie-breaking bug** in the FIFO reconciliation logic —
   SQLite's per-second precision meant rapid test operations could tie,
   making "oldest issue first" non-deterministic. Fixed here and in two
   other places with the same underlying vulnerability.

Five pre-existing tests needed real updates as a direct, correct
consequence of the new design — some were simply outdated assumptions
("balance drops immediately") that needed correcting, and two needed
their actual test narratives reworked because earlier steps now
legitimately behave differently than they used to.

## Everything else fixed this session

- **The Dispatch/Store role is now genuinely restricted** to Sites,
  Dispatch, and Receive — enforced in the backend, not just hidden from
  the nav. Issuing material stays an admin/accountant decision made from
  Work Orders; the redesigned form there now uses a proper BOM-driven
  raw-material dropdown, then a lot dropdown showing quantity at both the
  store and the worker's site, capped correctly either way.
- **Customer Order shipping is a real two-step dispatch now**, not a
  direct status flip — billing picks a lot from a dropdown and
  auto-creates the shipment; the Dispatch role never touches Sales or
  Customer Orders directly.
- **Resellers can now place Customer Orders** — the same gap Sales had
  already been fixed for, now closed here too.
- **Purchase Orders can reference finished goods**, for suppliers who
  deliver something already complete.
- **The systemic overcommitment bug** — the same lot being claimable by
  two pending actions at once — is fixed everywhere it could occur.
- **Confirm-receive now uniformly returns every newly-created lot**,
  shows where a shipment is coming from, and offers a correctly-encoded
  QR right after confirming — for raw material arriving, not just
  finished goods.
- **The previously-missing PO-receiving control** now exists directly in
  the Receive tab, with its own inline quantity-and-receive action.
- The tab order now follows the confirmed business workflow sequence.

## Testing this yourself

```
npm test
```
310 tests across 33 files, including a real end-to-end suite that starts
an actual HTTP server and drives it with the exact request shapes the
frontend sends — including the complete new Mark-Job-Done-to-bundled-ship
flow.

## Deployment

The schema changed this session (a new `Work Done` stage value, a
reseller field on customer orders — no new tables). Same deploy process
as always:
```
wrangler d1 delete fabroses-db
wrangler d1 create fabroses-db
wrangler d1 execute fabroses-db --file=./schema.sql --remote
```

## Honestly still open

- The item-photo cross-contamination bug from earlier in this project —
  still needs the URL comparison originally asked for.
- The mobile card/bottom-nav layout still hasn't been confirmed on an
  actual phone by a human.
- Rework jobs deliberately still use the old single-item ship-back flow,
  unchanged — this redesign only covers production jobs, matching what
  was actually discussed.
