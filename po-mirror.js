// po-mirror.js
// Bridges World B (production_orders / factory_shipments — the factory flow)
// into World A (po_headers / po_items — what the Dashboard + Stock report read).
//
// A production order is mirrored as a po_headers row whose po_number reuses the
// production order's order_number (PROD-/PRD-...). The mirror status is always
// RECOMPUTED from the order's live factory shipments, so create / ship / status
// change / cancel / qty edit all converge to a correct state when synced.
//
// Every function takes a `conn` (a transaction connection) so the mirror writes
// happen inside the caller's transaction.

// World A status progression rank (higher = further along).
const STATUS_RANK = {
  Ordered: 0,
  Shipped_CN: 1,
  Thai_Customs: 2,
  Arrived: 3,
  Completed: 4,
};

// Ensure a mirrored po_headers row (+ po_items) exists for a production order.
// Idempotent: if the row already exists it is left untouched here (status is
// managed by syncMirror). Returns the mirrored po_number, or null if the
// production order does not exist.
async function ensureMirrorHeader(conn, order_id) {
  const [[order]] = await conn.query(
    `SELECT order_number, project_name, order_date, est_ready_date
     FROM production_orders WHERE order_id = ?`,
    [order_id]
  );
  if (!order) return null;

  const po_number = order.order_number;

  const [[existing]] = await conn.query(
    'SELECT po_id FROM po_headers WHERE po_number = ?',
    [po_number]
  );
  if (existing) return po_number;

  // Pre-shipment, use est_ready_date as the departure baseline so the Stock
  // report can show an approximate ETA (departure_date + est_lead_time) before
  // a real shipment exists. syncMirror overwrites it once goods ship.
  await conn.query(
    `INSERT INTO po_headers (po_number, project_name, order_date, status, est_lead_time, departure_date)
     VALUES (?, ?, ?, 'Ordered', 25, ?)`,
    [po_number, order.project_name, order.order_date || null, order.est_ready_date || null]
  );

  const [items] = await conn.query(
    'SELECT sku, order_qty FROM production_order_items WHERE order_id = ?',
    [order_id]
  );
  for (const it of items) {
    await conn.query(
      'INSERT INTO po_items (po_number, sku, order_qty) VALUES (?, ?, ?)',
      [po_number, it.sku, it.order_qty]
    );
  }

  return po_number;
}

// Recompute the mirrored po_headers.status + departure_date for a production
// order from its non-cancelled factory shipments. Creates the mirror if needed.
//   - no shipments  -> Ordered, departure_date NULL
//   - has shipments -> most-advanced shipment status,
//                      departure_date = earliest ship_out_date
async function syncMirror(conn, order_id) {
  const po_number = await ensureMirrorHeader(conn, order_id);
  if (!po_number) return;

  const [shipments] = await conn.query(
    `SELECT fs.status, fs.ship_out_date
     FROM factory_shipments fs
     JOIN factory_shipment_items fsi ON fsi.shipment_id = fs.shipment_id
     JOIN production_order_items poi ON poi.item_id = fsi.order_item_id
     WHERE poi.order_id = ? AND fs.status <> 'Cancelled'`,
    [order_id]
  );

  let status = 'Ordered';
  let departure_date = null;
  for (const s of shipments) {
    const rank = STATUS_RANK[s.status];
    if (rank !== undefined && rank > STATUS_RANK[status]) status = s.status;
    if (s.ship_out_date && (!departure_date || s.ship_out_date < departure_date)) {
      departure_date = s.ship_out_date;
    }
  }

  // No real shipment yet -> fall back to the factory's est_ready_date as the
  // pre-ship ETA baseline (Stock report ETA = departure_date + est_lead_time).
  if (!departure_date) {
    const [[order]] = await conn.query(
      'SELECT est_ready_date FROM production_orders WHERE order_id = ?',
      [order_id]
    );
    departure_date = (order && order.est_ready_date) || null;
  }

  await conn.query(
    'UPDATE po_headers SET status = ?, departure_date = ? WHERE po_number = ?',
    [status, departure_date, po_number]
  );
}

// Sync the mirror for every production order touched by a shipment.
async function syncMirrorForShipment(conn, shipment_id) {
  const [rows] = await conn.query(
    `SELECT DISTINCT poi.order_id
     FROM factory_shipment_items fsi
     JOIN production_order_items poi ON poi.item_id = fsi.order_item_id
     WHERE fsi.shipment_id = ?`,
    [shipment_id]
  );
  for (const r of rows) await syncMirror(conn, r.order_id);
}

module.exports = { STATUS_RANK, ensureMirrorHeader, syncMirror, syncMirrorForShipment };
