# Plan: Mirror = one PO per shipment (rename PO number to shipping number)

**Decision (locked):** When a factory ships a production order and enters a
shipment number (e.g. `4E11111111`), the Dashboard PO should appear under that
shipping number — **one po_headers PO per shipment**, not one per order. The
not-yet-shipped remainder stays as the `PROD-...` "Ordered" PO.

**Repos**
- master_web: `C:\Users\008\Desktop\master web` — `po-mirror.js`, `routes/*`, migrations
- project_dashboard: reads `po_tracking` (po_headers/po_items) for Stock report + dashboard

**DB:** `po_tracking` on 139.144.119.186 (creds in master_web `.env`). BACKUP before ALTER.

## Current state (already shipped & merged — PR #3)
- `po-mirror.js` mirrors **one po_headers per production order**, keyed by
  `po_headers.po_number = production_orders.order_number` (PROD-...).
- `ensureMirrorHeader(conn, order_id)` creates the Ordered mirror + po_items.
- `syncMirror(conn, order_id)` recomputes status/departure_date from the order's
  non-cancelled shipments (most-advanced status; earliest ship_out_date;
  est_ready_date as pre-ship departure baseline).
- `syncMirrorForShipment(conn, shipment_id)` → finds order_ids of a shipment, syncs each.
- Called from: `routes/production-orders.js` POST (ensureMirrorHeader),
  `routes/shipments.js` POST + PATCH /:id/status + PATCH /:id/items + ready-date.

## Why this is not trivial
- po_number is the JOIN key for `po_items`, `po_status_history`, `po_images`.
  Renaming requires cascading those tables in one transaction.
- After rename, lookups keyed on `po_number = order_number` break → would create
  duplicate "Ordered" rows. Need a STABLE link that survives renames.

## Target design — one PO per shipment
World A rows after this change, per production order:
- **Remainder PO** (key = order_number `PROD-...`, status `Ordered`): qty =
  order_qty - shipped_qty (per SKU). Removed/zeroed when fully shipped.
- **Shipment PO** (one per non-cancelled factory_shipment, key = shipment_number
  `4E...`): qty = that shipment's ship_qty per SKU; status mirrors the shipment
  (Shipped_CN/Thai_Customs/Arrived/Completed); departure_date = ship_out_date.

## Steps
1. **Migration** (guarded, BACKUP first): add stable links to po_headers
   - `ALTER TABLE po_headers ADD COLUMN production_order_id INT NULL;`
   - `ALTER TABLE po_headers ADD COLUMN factory_shipment_id INT NULL;`
   - Backfill existing mirrored rows: set production_order_id by matching
     po_number = production_orders.order_number.
2. **Rewrite po-mirror.js** to key everything on the new columns (NOT po_number):
   - `syncOrderMirror(conn, order_id)`:
     - Ensure/maintain the **remainder** row (production_order_id set,
       factory_shipment_id NULL). po_number = order_number. Items = remaining qty
       per SKU. If remaining all 0 -> delete remainder row + its po_items.
     - For each non-cancelled shipment of the order: ensure a **shipment PO**
       (factory_shipment_id set). po_number = shipment_number. If po_number must
       change (shipment_number edited), cascade-update po_items/po_status_history/
       po_images. Items = ship_qty per SKU. status/departure from the shipment.
     - For cancelled shipments: delete their shipment PO (+ cascade) or skip.
   - Replace `ensureMirrorHeader` / `syncMirror` / `syncMirrorForShipment` callers
     with `syncOrderMirror`. Keep all writes in the caller's transaction.
3. **Cascade helper** `renamePo(conn, oldNo, newNo)`: UPDATE po_number in
   po_headers, po_items, po_status_history, po_images (verify full set first via
   information_schema - there may also be receiving_logs).
4. **Collision guard:** if a shipment_number already exists as a manual po_number,
   decide (prefix, or skip rename). Confirm with user.
5. **Backfill script** to rebuild mirrors for existing orders under the new model.

## Test (against live DB, ALWAYS rollback)
- Order with 100 qty, ship 60 (4E-A) -> remainder PROD row 40 (Ordered) + shipment
  PO 4E-A 60 (Shipped_CN). Ship remaining 40 (4E-B) -> remainder removed; two
  shipment POs. Advance/cancel a shipment -> its PO updates/removed; remainder
  recomputes. Edit ship_qty -> both recompute. Verify no duplicate Ordered rows.

## Risks
| Risk | Mitigation |
|---|---|
| Cascade rename misses a table referencing po_number | enumerate via information_schema first |
| Duplicate Ordered rows after rename | key all lookups on production_order_id/factory_shipment_id |
| Production data corruption | all in transactions; test via rollback; BACKUP before ALTER |

## Also done this session (context)
- project_dashboard `STOCK_REPORT.html`: PO Breakdown popup is now JS-driven
  (position:fixed, flip, 300ms close delay, selectable text) - committed on
  branch `claude/sharp-maxwell-05f67b`. Not yet merged.
