# FabRoses Business System — this session's build

**280 automated tests, all passing.** Run `npm test` to verify yourself
before trusting this with real data.

This session restructured how the Dispatch/Store role works, and rebuilt
Customer Order shipping to go through a real, verifiable two-step
dispatch instead of a shortcut. Below is what actually changed, in the
order it was built, followed by two things worth reading carefully: a
real double-decrement risk this session had to design around, and a
genuine gap found in the pick step that had been sitting unnoticed.

## A quick note on recovery

Partway through this session, the working environment reset and the
in-progress project was lost. It was recovered from the last delivered
zip and the full test suite was re-verified clean (244/244) before any
new work began, so everything below builds on a confirmed foundation.

## The Dispatch/Store role is now genuinely restricted

Previously "Dispatch" had access to Catalogue, Sites, Purchase Orders,
Work Orders, Customer Orders, and Sales. It's now trimmed to exactly
Sites, Dispatch, and Receive, enforced in the backend middleware, not
just hidden from the nav. A dedicated test proves this with real signed
tokens: Sales and Customer Orders now return a genuine 403, while Sites,
Dispatch, Receive, and PO receiving still work correctly.

This meant two capabilities had to be rebuilt so the role could still do
its job:

- Issuing raw material was redesigned entirely: pick the raw material
  from the job's BOM, then pick a lot from a dropdown showing every lot
  at either the store or the worker's site with quantity shown, capped to
  what that lot actually has. A lot already at the worker creates a
  direct issue with no pointless self-dispatch; a store lot still creates
  a real dispatch as before.
- Customer Order shipping is now a real two-step dispatch, not a direct
  status flip. Billing (choosing a lot from a dropdown) auto-creates a
  real customer_shipment dispatch. The Dispatch role never touches Sales
  or Customer Orders directly; the shipment just appears in their queue.
  The old shortcut endpoint is deleted, not just unused.

## Two things worth reading in full

Billing already removes stock from inventory, so shipping must not do it
again. Building the new dispatch naively would have decremented the same
lot twice for one sale. Fixed: shipping a customer_shipment dispatch
specifically skips the stock decrement, since billing already did it. A
dedicated test checks the exact lot balance at both points to prove this.

The pick step wasn't actually verifying anything. It was quietly sending
the dispatch's own expected item and lot straight back to the
mismatch-detection endpoint, rather than asking the picker to enter
anything themselves. The safety check worked correctly, it just never
had a chance to catch anything. Fixed with real, blank input fields and a
scan button matching the pattern used elsewhere in this app.

## Smaller confirmed fixes

- Reseller logins can now actually be created. The role existed but
  nothing collected which reseller party the login belonged to.
- Purchase Orders can now reference finished goods, not just raw
  materials, for suppliers who deliver an already-finished product.
- Confirmed already working, no changes needed: billing a raw material
  directly, and producing a finished item with no BOM at all.

## One interpretive call worth double-checking

Issue Material was kept in Work Orders rather than relocated into
Receive or Dispatch, reasoning it's an allocation decision best made
where admin/accountant already work. If that's not the intended
placement, it's a contained change to move.

## Testing this yourself

```
npm test
```
280 tests across 28 files, including a real end-to-end suite that starts
an actual HTTP server and drives it with the exact request shapes the
frontend sends, including the full billing-to-shipped flow.

## Deployment

No schema changes this session, same deploy steps as the last delivery.

## Honestly still open

- The item-photo cross-contamination bug from earlier in this project.
- The exact placement of Issue Material, flagged above as an assumption.
- The mobile card/bottom-nav layout still hasn't been confirmed on an
  actual phone by a human.
