// Guarded migration: shipment type-split + combined-PO support.
// Idempotent — safe to re-run. Uses the app's DB pool (reads .env).
//
// Changes (po_tracking):
//   factory_shipment_items:
//     + product_type ENUM('sample','pajamas','material','accessory')  (type-split)
//     + po_number_ref VARCHAR(50) NULL                                (combined-PO / lot)
//     order_item_id -> NULL                                           (ad-hoc factory SKUs)
//     unique key  uq_shipment_item(shipment_id, order_item_id)
//             ->  uq_shipment_item_type(shipment_id, order_item_id, product_type, sku)
//   factory_shipments:
//     + po_number VARCHAR(50) NULL                                    (optional PO no.)
const pool = require('../db');

async function colExists(table, col) {
  const [[r]] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, col]
  );
  return !!r;
}
async function indexExists(table, idx) {
  const [[r]] = await pool.query(
    `SELECT 1 AS ok FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, idx]
  );
  return !!r;
}
async function isNullable(table, col) {
  const [[r]] = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, col]
  );
  return r && r.is_nullable === 'YES';
}

(async () => {
  // ── factory_shipment_items ───────────────────────────────
  if (!(await colExists('factory_shipment_items', 'product_type'))) {
    await pool.query(
      `ALTER TABLE factory_shipment_items
         ADD COLUMN product_type ENUM('sample','pajamas','material','accessory')
         NOT NULL DEFAULT 'pajamas' AFTER sku`
    );
    console.log('DONE: factory_shipment_items.product_type');
  } else console.log('SKIP: factory_shipment_items.product_type exists');

  if (!(await colExists('factory_shipment_items', 'po_number_ref'))) {
    await pool.query(
      `ALTER TABLE factory_shipment_items
         ADD COLUMN po_number_ref VARCHAR(50) NULL AFTER shipment_id`
    );
    console.log('DONE: factory_shipment_items.po_number_ref');
  } else console.log('SKIP: factory_shipment_items.po_number_ref exists');

  if (!(await isNullable('factory_shipment_items', 'order_item_id'))) {
    await pool.query(
      `ALTER TABLE factory_shipment_items MODIFY COLUMN order_item_id INT NULL`
    );
    console.log('DONE: factory_shipment_items.order_item_id -> NULL');
  } else console.log('SKIP: factory_shipment_items.order_item_id already nullable');

  // swap unique key. Add the type-aware one FIRST so its (shipment_id, ...) prefix
  // can back the shipment_id foreign key, THEN drop the old unique (otherwise the
  // FK blocks the drop: "needed in a foreign key constraint").
  if (!(await indexExists('factory_shipment_items', 'uq_shipment_item_type'))) {
    await pool.query(
      `ALTER TABLE factory_shipment_items
         ADD UNIQUE KEY uq_shipment_item_type (shipment_id, order_item_id, product_type, sku)`
    );
    console.log('DONE: added uq_shipment_item_type');
  } else console.log('SKIP: uq_shipment_item_type exists');

  if (await indexExists('factory_shipment_items', 'uq_shipment_item')) {
    await pool.query('ALTER TABLE factory_shipment_items DROP INDEX uq_shipment_item');
    console.log('DONE: dropped uq_shipment_item');
  } else console.log('SKIP: uq_shipment_item not present');

  // ── factory_shipments ────────────────────────────────────
  if (!(await colExists('factory_shipments', 'po_number'))) {
    await pool.query(
      `ALTER TABLE factory_shipments ADD COLUMN po_number VARCHAR(50) NULL AFTER shipment_number`
    );
    console.log('DONE: factory_shipments.po_number');
  } else console.log('SKIP: factory_shipments.po_number exists');

  await pool.end();
  console.log('✅ migration complete');
})().catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
