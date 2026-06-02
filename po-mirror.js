// po-mirror.js
// Bridges World B (production_orders / factory_shipments — the factory flow)
// into World A (po_headers / po_items — what the Dashboard + Stock report read).
//
// Model: ONE po_headers PO per shipment (+ a remainder PO for the not-yet-shipped
// part of an order). Each mirror row is identified by a STABLE link column, never
// by its renamable po_number:
//   - remainder PO : production_order_id set, factory_shipment_id NULL.
//                    po_number = production_orders.order_number (PROD-...),
//                    status Ordered, items = remaining qty per SKU. Deleted once
//                    the order is fully shipped.
//   - shipment PO  : factory_shipment_id set, production_order_id NULL.
//                    po_number = factory_shipments.shipment_number (4E...),
//                    status mirrors the shipment, items = ship_qty per SKU.
//                    Deleted when the shipment is cancelled.
//
// Legacy manual POs (both link columns NULL) are NEVER touched by the mirror.
//
// Every function takes a `conn` (a transaction connection) so the mirror writes
// happen inside the caller's transaction.

// factory_shipments.status -> po_headers.status (1:1 for non-cancelled).
const SHIPMENT_TO_PO_STATUS = {
  Shipped_CN: 'Shipped_CN',
  Thai_Customs: 'Thai_Customs',
  Arrived: 'Arrived',
  Completed: 'Completed',
};

// Stock-report ETA baseline: ETA = departure_date + est_lead_time (days).
const EST_LEAD_TIME = 25;

// Tables carrying a po_number column, enumerated from information_schema
// (2026-06): po_items & receiving_logs have an FK (ON DELETE CASCADE,
// ON UPDATE NO ACTION); po_images & po_status_history have the column but no FK.
// renamePo must repoint all of them; deletePoCascade must clear the FK-less ones.
const PO_NUMBER_CHILD_TABLES = ['po_items', 'receiving_logs', 'po_images', 'po_status_history'];

// Rename a po_number across po_headers + every child table, in one transaction.
// The FKs are ON UPDATE NO ACTION, so an in-place UPDATE of the parent key would
// fail while children exist. Instead we copy the header to the new key, repoint
// the children (now valid — the new parent exists), then drop the old header.
// This avoids toggling FOREIGN_KEY_CHECKS (unsafe on a pooled connection) and
// preserves receiving_logs / po_images / po_status_history (which a delete+
// recreate would cascade away).
async function renamePo(conn, oldNo, newNo) {
  if (oldNo === newNo) return;

  const [cols] = await conn.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'po_headers'
        AND column_name <> 'po_id'
      ORDER BY ordinal_position`
  );
  const names = cols.map((c) => c.column_name || c.COLUMN_NAME);
  const insertList = names.map((n) => `\`${n}\``).join(', ');
  const selectList = names.map((n) => (n === 'po_number' ? '?' : `\`${n}\``)).join(', ');

  await conn.query(
    `INSERT INTO po_headers (${insertList})
     SELECT ${selectList} FROM po_headers WHERE po_number = ?`,
    [newNo, oldNo]
  );
  for (const t of PO_NUMBER_CHILD_TABLES) {
    await conn.query(`UPDATE \`${t}\` SET po_number = ? WHERE po_number = ?`, [newNo, oldNo]);
  }
  await conn.query('DELETE FROM po_headers WHERE po_number = ?', [oldNo]);
}

// Delete a mirror PO and all its child rows. po_items & receiving_logs cascade
// from po_headers; po_images & po_status_history have no FK so are cleared first.
async function deletePoCascade(conn, po_number) {
  await conn.query('DELETE FROM po_images WHERE po_number = ?', [po_number]);
  await conn.query('DELETE FROM po_status_history WHERE po_number = ?', [po_number]);
  await conn.query('DELETE FROM po_headers WHERE po_number = ?', [po_number]);
}

// Resolve the po_number a shipment PO should use. Normally the shipment_number,
// but if that string already belongs to a DIFFERENT po_headers row (a legacy
// manual PO or another shipment), we do not steal it: skip + suffix with the
// shipment id so the key stays unique. (Collision policy: skip + suffix.)
async function resolveShipmentPoNumber(conn, shipment_id, shipmentNumber) {
  const [[clash]] = await conn.query(
    'SELECT factory_shipment_id FROM po_headers WHERE po_number = ?',
    [shipmentNumber]
  );
  if (!clash || clash.factory_shipment_id === shipment_id) return shipmentNumber;
  console.warn(
    `[po-mirror] shipment_number "${shipmentNumber}" collides with an existing po_number; ` +
      `using "${shipmentNumber}#${shipment_id}" for shipment ${shipment_id}`
  );
  return `${shipmentNumber}#${shipment_id}`;
}

// Rebuild po_items for a mirror PO from a [{sku, qty}] list.
async function rebuildItems(conn, po_number, items) {
  await conn.query('DELETE FROM po_items WHERE po_number = ?', [po_number]);
  for (const it of items) {
    await conn.query(
      'INSERT INTO po_items (po_number, sku, order_qty) VALUES (?, ?, ?)',
      [po_number, it.sku, it.qty]
    );
  }
}

// Maintain the remainder (Ordered) PO for a production order: qty = order_qty -
// shipped (non-cancelled) per SKU. Removed entirely once nothing remains.
async function syncRemainderPo(conn, order_id) {
  const [[order]] = await conn.query(
    `SELECT order_id, order_number, project_name, order_date, est_ready_date
       FROM production_orders WHERE order_id = ?`,
    [order_id]
  );
  if (!order) return;

  // Remaining qty per SKU. shipped is summed per order_item across non-cancelled
  // shipments, then aggregated by SKU alongside order_qty.
  const [rows] = await conn.query(
    `SELECT poi.sku,
            SUM(poi.order_qty)        AS order_qty,
            COALESCE(SUM(s.shipped), 0) AS shipped
       FROM production_order_items poi
       LEFT JOIN (
         SELECT fsi.order_item_id, SUM(fsi.ship_qty) AS shipped
           FROM factory_shipment_items fsi
           JOIN factory_shipments fs
             ON fs.shipment_id = fsi.shipment_id AND fs.status <> 'Cancelled'
          GROUP BY fsi.order_item_id
       ) s ON s.order_item_id = poi.item_id
      WHERE poi.order_id = ?
      GROUP BY poi.sku`,
    [order_id]
  );

  const remaining = rows
    .map((r) => ({ sku: r.sku, qty: Math.max(0, Number(r.order_qty) - Number(r.shipped)) }))
    .filter((r) => r.qty > 0);

  const [[existing]] = await conn.query(
    'SELECT po_number FROM po_headers WHERE production_order_id = ?',
    [order_id]
  );

  if (remaining.length === 0) {
    if (existing) await deletePoCascade(conn, existing.po_number);
    return;
  }

  let po_number;
  if (!existing) {
    po_number = order.order_number;
    await conn.query(
      `INSERT INTO po_headers
         (po_number, production_order_id, project_name, order_date, status, est_lead_time, departure_date)
       VALUES (?, ?, ?, ?, 'Ordered', ?, ?)`,
      [po_number, order_id, order.project_name, order.order_date || null, EST_LEAD_TIME, order.est_ready_date || null]
    );
  } else {
    po_number = existing.po_number;
    // departure_date baseline = est_ready_date so the Stock report can show an
    // approximate pre-ship ETA. Status stays Ordered (shipped goods live on
    // their own shipment POs now).
    await conn.query(
      `UPDATE po_headers
          SET project_name = ?, order_date = ?, status = 'Ordered', departure_date = ?
        WHERE production_order_id = ?`,
      [order.project_name, order.order_date || null, order.est_ready_date || null, order_id]
    );
  }

  await rebuildItems(conn, po_number, remaining);
}

// Maintain the single shipment PO for a factory shipment: po_number =
// shipment_number, items = ship_qty per SKU (aggregated across the whole
// shipment, which may span multiple orders), status/departure from the shipment.
// Cancelled shipment -> its PO is removed.
async function syncShipmentPo(conn, shipment_id) {
  const [[ship]] = await conn.query(
    `SELECT shipment_id, shipment_number, status, ship_out_date
       FROM factory_shipments WHERE shipment_id = ?`,
    [shipment_id]
  );
  if (!ship) return;

  const [[existing]] = await conn.query(
    'SELECT po_number FROM po_headers WHERE factory_shipment_id = ?',
    [shipment_id]
  );

  if (ship.status === 'Cancelled') {
    if (existing) await deletePoCascade(conn, existing.po_number);
    return;
  }

  const status = SHIPMENT_TO_PO_STATUS[ship.status] || 'Shipped_CN';

  // project_name from any order the shipment draws from.
  const [[proj]] = await conn.query(
    `SELECT po.project_name
       FROM factory_shipment_items fsi
       JOIN production_order_items poi ON poi.item_id = fsi.order_item_id
       JOIN production_orders po ON po.order_id = poi.order_id
      WHERE fsi.shipment_id = ?
      LIMIT 1`,
    [shipment_id]
  );
  const project_name = (proj && proj.project_name) || 'Production';

  const desiredNo = await resolveShipmentPoNumber(conn, shipment_id, ship.shipment_number);

  let po_number;
  if (!existing) {
    po_number = desiredNo;
    await conn.query(
      `INSERT INTO po_headers
         (po_number, factory_shipment_id, project_name, status, est_lead_time, departure_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [po_number, shipment_id, project_name, status, EST_LEAD_TIME, ship.ship_out_date || null]
    );
  } else {
    po_number = existing.po_number;
    if (po_number !== desiredNo) {
      // shipment_number was edited -> cascade-rename, preserving warehouse data.
      await renamePo(conn, po_number, desiredNo);
      po_number = desiredNo;
    }
    await conn.query(
      `UPDATE po_headers
          SET project_name = ?, status = ?, departure_date = ?
        WHERE factory_shipment_id = ?`,
      [project_name, status, ship.ship_out_date || null, shipment_id]
    );
  }

  const [items] = await conn.query(
    `SELECT sku, SUM(ship_qty) AS qty
       FROM factory_shipment_items
      WHERE shipment_id = ?
      GROUP BY sku`,
    [shipment_id]
  );
  await rebuildItems(conn, po_number, items.map((i) => ({ sku: i.sku, qty: i.qty })));
}

// Full reconcile for one production order: its remainder PO + every shipment PO
// for shipments that include any of its items.
async function syncOrderMirror(conn, order_id) {
  await syncRemainderPo(conn, order_id);

  const [ships] = await conn.query(
    `SELECT DISTINCT fsi.shipment_id
       FROM factory_shipment_items fsi
       JOIN production_order_items poi ON poi.item_id = fsi.order_item_id
      WHERE poi.order_id = ?`,
    [order_id]
  );
  for (const s of ships) await syncShipmentPo(conn, s.shipment_id);
}

// Reconcile everything a shipment affects: the shipment PO itself, plus the
// remainder PO of every order the shipment draws from.
async function syncMirrorForShipment(conn, shipment_id) {
  await syncShipmentPo(conn, shipment_id);

  const [rows] = await conn.query(
    `SELECT DISTINCT poi.order_id
       FROM factory_shipment_items fsi
       JOIN production_order_items poi ON poi.item_id = fsi.order_item_id
      WHERE fsi.shipment_id = ?`,
    [shipment_id]
  );
  for (const r of rows) await syncRemainderPo(conn, r.order_id);
}

module.exports = {
  SHIPMENT_TO_PO_STATUS,
  renamePo,
  deletePoCascade,
  syncRemainderPo,
  syncShipmentPo,
  syncOrderMirror,
  syncMirrorForShipment,
};
