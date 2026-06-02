// One-time (idempotent) backfill: create mirrored po_headers/po_items for
// production orders that were created before the World-B -> World-A mirror
// existed, then sync their status from any existing factory shipments.
// Safe to re-run: ensureMirrorHeader skips orders that already have a mirror.
const pool = require('../db');
const { ensureMirrorHeader, syncMirror } = require('../po-mirror');

(async () => {
  const [orders] = await pool.query('SELECT order_id, order_number FROM production_orders ORDER BY order_id');
  let created = 0, synced = 0;
  for (const o of orders) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[before]] = await conn.query('SELECT po_id FROM po_headers WHERE po_number = ?', [o.order_number]);
      await ensureMirrorHeader(conn, o.order_id);
      await syncMirror(conn, o.order_id);
      await conn.commit();
      if (!before) created++;
      synced++;
      console.log(`mirrored ${o.order_number}${before ? ' (existed)' : ' (created)'}`);
    } catch (e) {
      await conn.rollback();
      console.error(`FAILED ${o.order_number}:`, e.message);
    } finally {
      conn.release();
    }
  }
  console.log(`\nDone. ${synced} orders synced, ${created} new mirror rows created.`);
  await pool.end();
})().catch((e) => { console.error('BACKFILL FAILED:', e.message); process.exit(1); });
