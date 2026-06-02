// Rebuild the World-A mirror under the "one PO per shipment" model.
// For every production order, syncOrderMirror recomputes:
//   - the remainder (Ordered) PO  -> production_order_id set
//   - one PO per non-cancelled shipment of that order -> factory_shipment_id set
// Legacy manual POs (both link columns NULL) are never touched.
// Idempotent: syncOrderMirror fully recomputes, so re-running converges.
// Prereq: run migrations/add-mirror-links.js first (adds the link columns).
const pool = require('../db');
const { syncOrderMirror } = require('../po-mirror');

(async () => {
  const [[before]] = await pool.query(
    `SELECT
       SUM(production_order_id IS NOT NULL) AS remainders,
       SUM(factory_shipment_id IS NOT NULL) AS shipment_pos,
       SUM(production_order_id IS NULL AND factory_shipment_id IS NULL) AS manual
     FROM po_headers`
  );
  console.log('BEFORE:', before);

  const [orders] = await pool.query('SELECT order_id, order_number FROM production_orders ORDER BY order_id');
  let ok = 0, fail = 0;
  for (const o of orders) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await syncOrderMirror(conn, o.order_id);
      await conn.commit();
      ok++;
      console.log(`synced ${o.order_number}`);
    } catch (e) {
      await conn.rollback();
      fail++;
      console.error(`FAILED ${o.order_number}:`, e.message);
    } finally {
      conn.release();
    }
  }

  const [[after]] = await pool.query(
    `SELECT
       SUM(production_order_id IS NOT NULL) AS remainders,
       SUM(factory_shipment_id IS NOT NULL) AS shipment_pos,
       SUM(production_order_id IS NULL AND factory_shipment_id IS NULL) AS manual
     FROM po_headers`
  );
  console.log('AFTER: ', after);
  console.log(`\nDone. ${ok} orders synced, ${fail} failed.`);
  await pool.end();
})().catch((e) => { console.error('BACKFILL FAILED:', e.message); process.exit(1); });
