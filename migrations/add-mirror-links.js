// Guarded migration for "one PO per shipment".
// Adds two STABLE link columns to po_headers so the World-B -> World-A mirror
// can key on them instead of the renamable po_number:
//   - production_order_id  -> the "remainder" (Ordered) PO for an order
//   - factory_shipment_id  -> the per-shipment PO (po_number = shipment_number)
// Idempotent: re-running only fills what is missing. Backfills
// production_order_id on existing mirror rows (po_number = order_number).
const pool = require('../db');

async function columnExists(table, column) {
  const [[row]] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return !!row;
}

async function indexExists(table, index) {
  const [[row]] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return !!row;
}

(async () => {
  // 1. Add columns (nullable; mirror-managed rows set them, legacy manual POs stay NULL).
  if (await columnExists('po_headers', 'production_order_id')) {
    console.log('SKIP: po_headers.production_order_id already exists');
  } else {
    await pool.query('ALTER TABLE po_headers ADD COLUMN production_order_id INT NULL AFTER po_number');
    console.log('DONE: added po_headers.production_order_id');
  }

  if (await columnExists('po_headers', 'factory_shipment_id')) {
    console.log('SKIP: po_headers.factory_shipment_id already exists');
  } else {
    await pool.query('ALTER TABLE po_headers ADD COLUMN factory_shipment_id INT NULL AFTER production_order_id');
    console.log('DONE: added po_headers.factory_shipment_id');
  }

  // 2. Indexes for the new lookup keys.
  if (await indexExists('po_headers', 'idx_po_headers_production_order_id')) {
    console.log('SKIP: idx_po_headers_production_order_id already exists');
  } else {
    await pool.query('CREATE INDEX idx_po_headers_production_order_id ON po_headers (production_order_id)');
    console.log('DONE: created idx_po_headers_production_order_id');
  }
  if (await indexExists('po_headers', 'idx_po_headers_factory_shipment_id')) {
    console.log('SKIP: idx_po_headers_factory_shipment_id already exists');
  } else {
    await pool.query('CREATE INDEX idx_po_headers_factory_shipment_id ON po_headers (factory_shipment_id)');
    console.log('DONE: created idx_po_headers_factory_shipment_id');
  }

  // 3. Backfill production_order_id on existing mirror rows (po_number = order_number).
  //    Only fills NULLs, so legacy manual POs and re-runs are untouched.
  // COLLATE pins both sides: po_headers.po_number is utf8mb4_unicode_ci while
  // production_orders.order_number is utf8mb4_0900_ai_ci, which otherwise throws
  // "Illegal mix of collations" on the join.
  const [result] = await pool.query(
    `UPDATE po_headers ph
       JOIN production_orders po
         ON po.order_number COLLATE utf8mb4_unicode_ci = ph.po_number
        SET ph.production_order_id = po.order_id
      WHERE ph.production_order_id IS NULL`
  );
  console.log(`DONE: backfilled production_order_id on ${result.affectedRows} mirror row(s)`);

  await pool.end();
})().catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
