// Live-DB validation for the split-PO-per-shipment mirror. Runs the plan's test
// scenario (+ collision and rename edge cases) inside ONE transaction and ALWAYS
// rolls back, so it never mutates committed data. Exits non-zero on any failed
// assertion.
const pool = require('../db');
const {
  syncOrderMirror, syncMirrorForShipment, syncShipmentPo, syncRemainderPo,
} = require('../po-mirror');

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

async function remainder(conn, order_id) {
  const [[h]] = await conn.query(
    'SELECT po_id, po_number, status FROM po_headers WHERE production_order_id = ?', [order_id]);
  if (!h) return null;
  const [items] = await conn.query(
    'SELECT sku, order_qty FROM po_items WHERE po_number = ? ORDER BY sku', [h.po_number]);
  return { ...h, items };
}
async function shipmentPo(conn, shipment_id) {
  const [[h]] = await conn.query(
    'SELECT po_id, po_number, status FROM po_headers WHERE factory_shipment_id = ?', [shipment_id]);
  if (!h) return null;
  const [items] = await conn.query(
    'SELECT sku, order_qty FROM po_items WHERE po_number = ? ORDER BY sku', [h.po_number]);
  return { ...h, items };
}
const qtyOf = (po, sku) => { const i = po && po.items.find((x) => x.sku === sku); return i ? Number(i.order_qty) : null; };

(async () => {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const [[fac]] = await conn.query('SELECT factory_id FROM factories LIMIT 1');
    if (!fac) throw new Error('no factory rows to borrow a factory_id from');
    const factory_id = fac.factory_id;
    const SKU = 'TEST-SPLIT-SKU';

    // --- Order with 100 qty ---
    const [o] = await conn.query(
      `INSERT INTO production_orders (order_number, project_name, status, order_date)
       VALUES ('TEST-SPLIT-001', 'TEST Split', 'Pending', '2026-06-01')`);
    const order_id = o.insertId;
    const [it] = await conn.query(
      `INSERT INTO production_order_items (order_id, factory_id, sku, order_qty)
       VALUES (?, ?, ?, 100)`, [order_id, factory_id, SKU]);
    const order_item_id = it.insertId;

    await syncOrderMirror(conn, order_id);
    let rem = await remainder(conn, order_id);
    console.log('\n[1] new order, no shipments');
    check('remainder exists, status Ordered', rem && rem.status === 'Ordered');
    check('remainder qty = 100', qtyOf(rem, SKU) === 100);

    // --- Ship 60 on 4E-A (Shipped_CN) ---
    const [sa] = await conn.query(
      `INSERT INTO factory_shipments (shipment_number, factory_id, ship_out_date, status)
       VALUES ('TEST-4E-A', ?, '2026-06-02', 'Shipped_CN')`, [factory_id]);
    const shipA = sa.insertId;
    await conn.query(
      `INSERT INTO factory_shipment_items (shipment_id, order_item_id, sku, ship_qty) VALUES (?, ?, ?, 60)`,
      [shipA, order_item_id, SKU]);
    await syncMirrorForShipment(conn, shipA);

    rem = await remainder(conn, order_id);
    let poA = await shipmentPo(conn, shipA);
    console.log('\n[2] ship 60 on 4E-A');
    check('remainder qty = 40', qtyOf(rem, SKU) === 40);
    check('remainder still Ordered', rem && rem.status === 'Ordered');
    check('shipment PO A po_number = shipment_number', poA && poA.po_number === 'TEST-4E-A');
    check('shipment PO A qty = 60', qtyOf(poA, SKU) === 60);
    check('shipment PO A status Shipped_CN', poA && poA.status === 'Shipped_CN');

    // --- Ship remaining 40 on 4E-B ---
    const [sb] = await conn.query(
      `INSERT INTO factory_shipments (shipment_number, factory_id, ship_out_date, status)
       VALUES ('TEST-4E-B', ?, '2026-06-03', 'Shipped_CN')`, [factory_id]);
    const shipB = sb.insertId;
    await conn.query(
      `INSERT INTO factory_shipment_items (shipment_id, order_item_id, sku, ship_qty) VALUES (?, ?, ?, 40)`,
      [shipB, order_item_id, SKU]);
    await syncMirrorForShipment(conn, shipB);

    rem = await remainder(conn, order_id);
    const poB = await shipmentPo(conn, shipB);
    console.log('\n[3] ship remaining 40 on 4E-B');
    check('remainder removed (fully shipped)', rem === null);
    check('shipment PO B qty = 40', qtyOf(poB, SKU) === 40);
    check('two shipment POs exist', poA && poB && poA.po_id !== poB.po_id);

    // --- Advance 4E-A to Arrived ---
    await conn.query(`UPDATE factory_shipments SET status='Arrived' WHERE shipment_id=?`, [shipA]);
    await syncShipmentPo(conn, shipA);
    poA = await shipmentPo(conn, shipA);
    console.log('\n[4] advance 4E-A -> Arrived');
    check('shipment PO A status Arrived', poA && poA.status === 'Arrived');

    // --- Cancel 4E-B -> its PO removed, remainder recomputes to 40 ---
    await conn.query(`UPDATE factory_shipments SET status='Cancelled' WHERE shipment_id=?`, [shipB]);
    await syncMirrorForShipment(conn, shipB);
    rem = await remainder(conn, order_id);
    const poBafter = await shipmentPo(conn, shipB);
    console.log('\n[5] cancel 4E-B');
    check('shipment PO B removed', poBafter === null);
    check('remainder back to 40', qtyOf(rem, SKU) === 40);

    // --- Edit 4E-A ship_qty 60 -> 50 ---
    await conn.query(`UPDATE factory_shipment_items SET ship_qty=50 WHERE shipment_id=? AND order_item_id=?`,
      [shipA, order_item_id]);
    await syncMirrorForShipment(conn, shipA);
    rem = await remainder(conn, order_id);
    poA = await shipmentPo(conn, shipA);
    console.log('\n[6] edit 4E-A ship_qty -> 50');
    check('shipment PO A qty = 50', qtyOf(poA, SKU) === 50);
    check('remainder qty = 50', qtyOf(rem, SKU) === 50);

    // --- No duplicate Ordered rows for this order ---
    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) AS n FROM po_headers WHERE production_order_id = ?', [order_id]);
    console.log('\n[7] duplicate-row guard');
    check('exactly one remainder row', Number(n) === 1);

    // --- Rename: receiving_logs must follow the po_number ---
    await conn.query(
      `INSERT INTO receiving_logs (po_number, sku, receive_qty) VALUES ('TEST-4E-A', ?, 5)`, [SKU]);
    await conn.query(`UPDATE factory_shipments SET shipment_number='TEST-4E-A-RENAMED' WHERE shipment_id=?`, [shipA]);
    await syncShipmentPo(conn, shipA);
    poA = await shipmentPo(conn, shipA);
    const [[recv]] = await conn.query(
      `SELECT COUNT(*) AS n FROM receiving_logs WHERE po_number='TEST-4E-A-RENAMED' AND sku=?`, [SKU]);
    const [[oldRecv]] = await conn.query(
      `SELECT COUNT(*) AS n FROM receiving_logs WHERE po_number='TEST-4E-A'`);
    console.log('\n[8] rename shipment_number -> cascade');
    check('shipment PO A renamed', poA && poA.po_number === 'TEST-4E-A-RENAMED');
    check('shipment PO A qty preserved = 50', qtyOf(poA, SKU) === 50);
    check('receiving_logs followed rename', Number(recv.n) === 1);
    check('no orphan receiving_logs on old number', Number(oldRecv.n) === 0);

    // --- Collision: shipment_number equals an existing manual po_number ---
    await conn.query(
      `INSERT INTO po_headers (po_number, project_name, status) VALUES ('TEST-COLLIDE', 'Manual PO', 'Ordered')`);
    const [sc] = await conn.query(
      `INSERT INTO factory_shipments (shipment_number, factory_id, ship_out_date, status)
       VALUES ('TEST-COLLIDE', ?, '2026-06-04', 'Shipped_CN')`, [factory_id]);
    const shipC = sc.insertId;
    await conn.query(
      `INSERT INTO factory_shipment_items (shipment_id, order_item_id, sku, ship_qty) VALUES (?, ?, ?, 10)`,
      [shipC, order_item_id, SKU]);
    await syncShipmentPo(conn, shipC);
    const poC = await shipmentPo(conn, shipC);
    const [[manual]] = await conn.query(
      `SELECT factory_shipment_id FROM po_headers WHERE po_number='TEST-COLLIDE'`);
    console.log('\n[9] collision (skip + suffix)');
    check('shipment PO C uses suffixed key', poC && poC.po_number === `TEST-COLLIDE#${shipC}`);
    check('manual PO untouched (no factory_shipment_id)', manual && manual.factory_shipment_id === null);

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  } catch (e) {
    console.error('TEST ERROR:', e.message);
    failed++;
  } finally {
    await conn.rollback();   // never commit test data
    conn.release();
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
  }
})();
