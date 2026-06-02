# Plan: Factory/PO 6 Fixes — master_web (+ project_dashboard impact)

**Repos**
- master_web: `C:\Users\008\Desktop\master web` (Node/Express, frontend `js/app.js` + `factory.html`)
- project_dashboard: dashboard + stock report (reads DB `po_tracking`)

**Status:** Planned & decisions locked. NOT yet implemented. Implement in this order: 1 → 3 → 4 → 6 → 2 → 5.

---

## Architecture (critical context)
DB `po_tracking` has **two disconnected worlds**:
- **World A** (Dashboard + Stock report read this): `po_headers` / `po_items` / `receiving_logs`.
  `po_headers.status` ENUM = `Draft, Ordered, Shipped_CN, Thai_Customs, Arrived, Completed`; has `departure_date`, `est_lead_time` (default 25). Stock report ETA = `departure_date + est_lead_time days`.
- **World B** (new factory flow): `production_orders` / `production_order_items` / `factory_shipments` / `factory_shipment_items`.
  `production_orders.status` ENUM = `Pending, Partial, Fulfilled, Cancelled`; has `order_number` (PRD-...), `project_name`, `priority`, `order_date`, `due_date`.
  `factory_shipments.status` ENUM = `Shipped_CN, Thai_Customs, Arrived, Completed, Cancelled`; has `logistics_provider`, `tracking_number`, `ship_out_date`, `est_arrival_date`, `actual_arrival_date`.

Creating a production order writes World B only → Dashboard/Stock report (World A) never see it. **This is Issue 6.**

---

## Issue 1 — F5 on /factory.html forces re-login · Low
Cause: `let token = null` in memory only (`factory.html:231`). Login sets `token = data.token` (`:259`); logout sets null (`:272`).
**Fix (4 edits in `factory.html`):**
1. After `token = data.token;` (~:259) add:
   ```js
   localStorage.setItem('factory_token', token);
   localStorage.setItem('factory_user', username);
   ```
2. In `logout()` after `token = null;` (~:272) add:
   ```js
   localStorage.removeItem('factory_token');
   localStorage.removeItem('factory_user');
   ```
3. After `logout()` (~:277) add + call:
   ```js
   function restoreSession() {
     const saved = localStorage.getItem('factory_token');
     if (!saved) return;
     token = saved;
     document.getElementById('hdr-user').textContent = localStorage.getItem('factory_user') || '';
     document.getElementById('login-screen').style.display = 'none';
     document.getElementById('app').style.display = 'block';
     loadPending();
   }
   restoreSession();
   ```
4. In `apiFetch` after `const res = await fetch(...)` (~:284) add:
   ```js
   if (res.status === 401) { logout(); throw new Error('กรุณาเข้าสู่ระบบใหม่'); }
   ```

## Issue 3 — shipment_number == tracking_number; tracking optional · Low
Cause: UI has 2 fields; `tracking_number` already optional in backend (`routes/shipments.js:163` `tracking_number || null`).
**Fix:** Remove the "เลขพัสดุ/tracking" input from the shipment form (in `factory.html` or `js/app.js` shipment form). Backend: default `tracking_number = tracking_number || shipment_number`. Do NOT change validation (`shipment_number` stays required, `routes/shipments.js:98`).

## Issue 4 — Logistics dropdown · Medium · DECISION: **company only** (no shipping_method, no ALTER)
**Fix:** In the shipment form, change `logistics_provider` free-text → `<select>`/datalist. Source options from `/api/logistics-rates` (mirror the PO create form which already fetches logistics options). `factory_shipments.logistics_provider` already exists — no schema change.

## Issue 6 — production order not shown as "Ordered" in Dashboard · High · DECISION: **A. Mirror → po_headers**
**Fix:** When a production order is created (`routes/production-orders.js` POST, ~:51), also insert a matching `po_headers` row with `status='Ordered'` + `po_items` (sku, order_qty) — in the SAME transaction. Decide po_number mapping: reuse `order_number` as `po_number` (simplest) OR map. When factory ships / updates shipment status, also update the mirrored `po_headers.status` (Shipped_CN/Thai_Customs/Arrived/Completed) so Dashboard + Stock report reflect it.
Status mapping World B→A:
- production_order created → po_headers `Ordered`
- factory_shipment `Shipped_CN` → set `po_headers.departure_date = ship_out_date`, status `Shipped_CN`
- `Thai_Customs` / `Arrived` / `Completed` → mirror same status
- `Cancelled` → mirror/cancel
Do all mirror writes in transactions. Verify after: Stock report `qty_ordered` (status='Ordered') and `qty_incoming` (Shipped_CN/Thai_Customs/Arrived) populate.

## Issue 2 — Factory estimate finish date before shipping · Medium
**Fix:**
- Migration: `ALTER TABLE production_orders ADD COLUMN est_ready_date DATE NULL` (วันคาดว่าผลิตเสร็จ). Use guard / `IF NOT EXISTS`; BACKUP first.
- Endpoint: factory can PATCH `est_ready_date` on their order (auth = factory owner).
- UI: show/edit in factory portal + show in admin PO list.
- Flow to World A: map `est_ready_date` into the mirrored `po_headers` so Stock report ETA can use it pre-shipment (e.g. treat as expected arrival baseline).

## Issue 5 — ship_qty exceeds remaining · Medium · DECISION: **warn but allow + factory can edit later & sync to PO**
Cause: `routes/shipments.js:136-141` blocks `ship_qty > remaining` with 400.
**Fix:**
- Change block → allow: when `ship_qty > remaining`, do NOT 400; include a `warnings[]` array in the 201 response (e.g. `over-shipped by N`).
- Add **PATCH /api/shipments/:id/items** (factory owner only) to edit `ship_qty` of shipment items after creation.
- On create AND on edit, **sync to the mirrored PO** (World A) per Issue 6 (recompute mirrored qty/status).

---

## Migrations (run once, BACKUP first)
- `ALTER TABLE production_orders ADD COLUMN est_ready_date DATE NULL;` (Issue 2)
- (No other ALTER. Issue 4 = no schema change; Issue 6 reuses existing po_headers/po_items.)

## Key files
- `routes/shipments.js` — POST shipment (Issues 3, 5), new PATCH items (Issue 5)
- `routes/production-orders.js` — POST (Issue 6 mirror, Issue 2 field)
- `factory.html` — auth persistence (Issue 1), shipment form (Issues 3, 4)
- `js/app.js` — shipment form / logistics dropdown (Issues 3, 4), PO/dashboard reads
- `server.js` — `/api/po`, `/api/logistics-rates` (Issue 4 source reference)

## Risks
| Risk | Level | Mitigation |
|---|---|---|
| Mirror sync incomplete across create/edit/cancel/ship | High | All mirror writes in transactions; explicit status map |
| ALTER on production DB | Med | Guarded/IF NOT EXISTS + backup |
| order_number vs po_number mapping | Med | Decide: reuse order_number as po_number |
| Cannot test locally (needs live DB) | Med | User tests after deploy |

## Acceptance
- [ ] factory.html survives F5 (no re-login)
- [ ] Shipment form: single number field; logistics = company dropdown
- [ ] Over-ship allowed with warning; factory can edit ship_qty; PO updates
- [ ] Factory can set est_ready_date before shipping; shows in admin
- [ ] Creating production order shows as "Ordered" in Dashboard + Stock report; status advances on shipment

## Git workflow (per prior sessions)
- master_web: branch off main, commit, push, `gh pr create/merge` (gh logged in via keyring). Co-Author trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Already merged previously: production-order save fix, Ordered column + ETA (dashboard), factory_id + project dropdown fix.
