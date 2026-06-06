const express = require('express');
const pool    = require('../db');
const { requireFactory } = require('../middleware/auth');
const { syncMirrorForShipment, syncRemainderPo } = require('../po-mirror');

const router = express.Router();

const VALID_FACTORY_STATUSES = ['Thai_Customs', 'Arrived', 'Completed', 'Cancelled'];
const VALID_LOGISTICS = ['HLT ship', 'HLT truck', 'CTW ship', 'CTW truck'];
const VALID_PRODUCT_TYPES = ['sample', 'pajamas', 'material', 'accessory'];

// GET /api/shipments/my-orders
// Returns production order items assigned to this factory with pending qty to ship
router.get('/my-orders', requireFactory, async (req, res) => {
  try {
    const factory_id = req.user.factory_id;

    const [rows] = await pool.query(`
      SELECT
        poi.item_id, poi.order_id, poi.sku, poi.order_qty, poi.remark,
        po.order_number, po.project_name, po.priority, po.due_date, po.est_ready_date, po.status AS order_status,
        COALESCE(SUM(fsi.ship_qty), 0) AS already_shipped,
        (poi.order_qty - COALESCE(SUM(fsi.ship_qty), 0)) AS remaining_qty
      FROM production_order_items poi
      JOIN production_orders po ON po.order_id = poi.order_id
      LEFT JOIN factory_shipment_items fsi ON fsi.order_item_id = poi.item_id
      LEFT JOIN factory_shipments fs ON fs.shipment_id = fsi.shipment_id
        AND fs.status != 'Cancelled'
      WHERE poi.factory_id = ?
        AND po.status NOT IN ('Fulfilled', 'Cancelled')
      GROUP BY poi.item_id
      HAVING remaining_qty > 0
      ORDER BY FIELD(po.priority, 'Urgent', 'High', 'Normal', 'Low') ASC, po.est_ready_date ASC
    `, [factory_id]);

    res.json(rows);
  } catch (err) {
    console.error('GET /api/shipments/my-orders error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/shipments/mine
// List shipments created by this factory, with items
router.get('/mine', requireFactory, async (req, res) => {
  try {
    const factory_id = req.user.factory_id;

    const [shipmentRows] = await pool.query(`
      SELECT shipment_id, factory_id, shipment_number, po_number, logistics_provider,
             tracking_number, ship_out_date, est_arrival_date, status, created_at
      FROM factory_shipments
      WHERE factory_id = ?
      ORDER BY created_at DESC
    `, [factory_id]);

    if (shipmentRows.length === 0) return res.json([]);

    const shipmentIds = shipmentRows.map(s => s.shipment_id);
    const [itemRows] = await pool.query(`
      SELECT fsi.id AS shipment_item_id, fsi.shipment_id, fsi.order_item_id,
             fsi.po_number_ref, fsi.sku, fsi.product_type, fsi.ship_qty
      FROM factory_shipment_items fsi
      WHERE fsi.shipment_id IN (?)
    `, [shipmentIds]);

    // Group items by shipment_id
    const itemsByShipment = {};
    for (const item of itemRows) {
      if (!itemsByShipment[item.shipment_id]) itemsByShipment[item.shipment_id] = [];
      itemsByShipment[item.shipment_id].push(item);
    }

    const result = shipmentRows.map(shipment => ({
      ...shipment,
      items: itemsByShipment[shipment.shipment_id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /api/shipments/mine error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/shipments
// Create a shipment with items
router.post('/', requireFactory, async (req, res) => {
  const {
    shipment_number,
    po_number,
    logistics_provider,
    tracking_number,
    ship_out_date,
    est_arrival_date,
    items = [],
  } = req.body;

  const factory_id = req.user.factory_id;
  const warnings = [];

  // --- Validation (all before getConnection) ---
  if (!shipment_number)   return res.status(400).json({ error: 'shipment_number is required' });
  if (!ship_out_date)     return res.status(400).json({ error: 'ship_out_date is required' });
  if (!est_arrival_date)  return res.status(400).json({ error: 'est_arrival_date is required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'items are required' });
  if (logistics_provider && !VALID_LOGISTICS.includes(logistics_provider)) {
    return res.status(400).json({ error: `logistics_provider must be one of: ${VALID_LOGISTICS.join(', ')}` });
  }

  // Validate each item before any DB call. order_item_id is OPTIONAL — a null/absent
  // value marks an ad-hoc factory SKU (not tied to any production order line); for
  // those the caller must supply `sku` directly. A single order line may appear in
  // several items with different product_type (type-split, e.g. 1 sample + 19 pajamas).
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.ship_qty || item.ship_qty <= 0)
      return res.status(400).json({ error: `items[${i}].ship_qty must be > 0` });
    if (!item.order_item_id && !item.sku)
      return res.status(400).json({ error: `items[${i}]: order_item_id or sku is required` });
    if (item.product_type && !VALID_PRODUCT_TYPES.includes(item.product_type))
      return res.status(400).json({ error: `items[${i}].product_type must be one of: ${VALID_PRODUCT_TYPES.join(', ')}` });
  }

  // Validate ownership + remaining qty for each item (before transaction)
  try {
    for (const item of items) {
      // Ad-hoc factory SKU (no backing order line): nothing to own-check / over-ship.
      if (!item.order_item_id) continue;
      // Verify item belongs to this factory
      const [[poi]] = await pool.query(`
        SELECT poi.item_id, poi.sku, poi.order_qty, poi.factory_id
        FROM production_order_items poi
        WHERE poi.item_id = ?
      `, [item.order_item_id]);

      if (!poi || poi.factory_id !== factory_id) {
        return res.status(403).json({
          error: `item order_item_id=${item.order_item_id}: access denied`,
        });
      }

      // Calculate already shipped (non-cancelled)
      const [[shipped]] = await pool.query(`
        SELECT COALESCE(SUM(fsi.ship_qty), 0) AS already_shipped
        FROM factory_shipment_items fsi
        JOIN factory_shipments fs ON fs.shipment_id = fsi.shipment_id
          AND fs.status != 'Cancelled'
        WHERE fsi.order_item_id = ?
      `, [item.order_item_id]);

      // Issue 5: over-shipping is allowed but flagged as a warning (the factory
      // can correct it later via PATCH /:id/items).
      const remaining = poi.order_qty - shipped.already_shipped;
      if (item.ship_qty > remaining) {
        warnings.push({
          order_item_id: item.order_item_id,
          sku: poi.sku,
          ship_qty: item.ship_qty,
          remaining,
          message: `over-shipped by ${item.ship_qty - remaining}`,
        });
      }
    }
  } catch (err) {
    console.error('POST /api/shipments validation error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // --- Transaction ---
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Insert shipment header (po_number is an optional second reference besides
    // shipment_number / tracking_number).
    const [headerResult] = await conn.query(`
      INSERT INTO factory_shipments
        (factory_id, shipment_number, po_number, logistics_provider, tracking_number,
         ship_out_date, est_arrival_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Shipped_CN')
    `, [
      factory_id,
      shipment_number,
      po_number || null,
      logistics_provider || null,
      tracking_number || shipment_number,
      ship_out_date,
      est_arrival_date,
    ]);
    const shipment_id = headerResult.insertId;

    // Insert items. For order-backed items the SKU comes from the order line; for
    // ad-hoc factory SKUs it comes straight from the request. product_type carries
    // the per-line type-split; po_number_ref assigns the line to a combined PO/lot.
    for (const item of items) {
      let sku = item.sku;
      if (item.order_item_id) {
        const [[poi]] = await conn.query(
          'SELECT sku FROM production_order_items WHERE item_id = ?',
          [item.order_item_id]
        );
        sku = (poi && poi.sku) || item.sku;
      }
      await conn.query(`
        INSERT INTO factory_shipment_items
          (shipment_id, order_item_id, po_number_ref, sku, product_type, ship_qty)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [shipment_id, item.order_item_id || null, item.po_number_ref || null,
          sku, item.product_type || 'pajamas', item.ship_qty]);
    }

    // Mirror shipment state into World A po_headers (Shipped_CN + departure_date).
    await syncMirrorForShipment(conn, shipment_id);

    await conn.commit();

    // Return created shipment with items
    const [[shipment]] = await pool.query(`
      SELECT shipment_id, factory_id, shipment_number, po_number, logistics_provider,
             tracking_number, ship_out_date, est_arrival_date, status, created_at
      FROM factory_shipments WHERE shipment_id = ?
    `, [shipment_id]);

    const [createdItems] = await pool.query(`
      SELECT id AS shipment_item_id, shipment_id, order_item_id, po_number_ref, sku, product_type, ship_qty
      FROM factory_shipment_items WHERE shipment_id = ?
    `, [shipment_id]);

    res.status(201).json({ ...shipment, items: createdItems, warnings });
  } catch (err) {
    await conn.rollback();
    console.error('POST /api/shipments error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

// PATCH /api/shipments/:id/status
// Factory updates shipment status
router.patch('/:id/status', requireFactory, async (req, res) => {
  try {
    const shipment_id = parseInt(req.params.id, 10);
    const { status } = req.body;
    const factory_id = req.user.factory_id;

    if (!status) return res.status(400).json({ error: 'status is required' });
    if (!VALID_FACTORY_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${VALID_FACTORY_STATUSES.join(', ')}`,
      });
    }

    // Verify shipment belongs to this factory
    const [[existing]] = await pool.query(
      'SELECT shipment_id FROM factory_shipments WHERE shipment_id = ? AND factory_id = ?',
      [shipment_id, factory_id]
    );
    if (!existing) return res.status(404).json({ error: 'Shipment not found' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'UPDATE factory_shipments SET status = ? WHERE shipment_id = ?',
        [status, shipment_id]
      );
      // Re-sync the mirrored po_headers status from the order's live shipments.
      await syncMirrorForShipment(conn, shipment_id);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [[shipment]] = await pool.query(`
      SELECT shipment_id, factory_id, shipment_number, po_number, logistics_provider,
             tracking_number, ship_out_date, est_arrival_date, status, created_at
      FROM factory_shipments WHERE shipment_id = ?
    `, [shipment_id]);

    res.json(shipment);
  } catch (err) {
    console.error('PATCH /api/shipments/:id/status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/shipments/:id/items
// Factory owner edits ship_qty of items on an existing shipment. Over-shipping
// is allowed (returns warnings[]). Re-syncs the mirrored po_headers.
router.patch('/:id/items', requireFactory, async (req, res) => {
  const shipment_id = parseInt(req.params.id, 10);
  const factory_id = req.user.factory_id;
  const { items = [] } = req.body;

  if (!Number.isInteger(shipment_id)) return res.status(400).json({ error: 'invalid shipment id' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items are required' });
  }
  for (let i = 0; i < items.length; i++) {
    if (!items[i].shipment_item_id) return res.status(400).json({ error: `items[${i}].shipment_item_id is required` });
    if (!items[i].ship_qty || items[i].ship_qty <= 0)
      return res.status(400).json({ error: `items[${i}].ship_qty must be > 0` });
  }

  try {
    // Verify shipment belongs to this factory
    const [[ship]] = await pool.query(
      'SELECT shipment_id FROM factory_shipments WHERE shipment_id = ? AND factory_id = ?',
      [shipment_id, factory_id]
    );
    if (!ship) return res.status(404).json({ error: 'Shipment not found' });

    const warnings = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const it of items) {
        // Ensure the shipment item belongs to this shipment
        const [[row]] = await conn.query(
          'SELECT id, order_item_id, sku FROM factory_shipment_items WHERE id = ? AND shipment_id = ?',
          [it.shipment_item_id, shipment_id]
        );
        if (!row) {
          await conn.rollback();
          return res.status(404).json({ error: `shipment_item_id=${it.shipment_item_id} not found in this shipment` });
        }
        await conn.query(
          'UPDATE factory_shipment_items SET ship_qty = ? WHERE id = ?',
          [it.ship_qty, it.shipment_item_id]
        );

        // Recompute over-ship after this edit (exclude cancelled shipments)
        const [[poi]] = await conn.query(
          'SELECT order_qty FROM production_order_items WHERE item_id = ?',
          [row.order_item_id]
        );
        const [[sh]] = await conn.query(
          `SELECT COALESCE(SUM(fsi.ship_qty),0) AS total
           FROM factory_shipment_items fsi
           JOIN factory_shipments fs ON fs.shipment_id = fsi.shipment_id AND fs.status <> 'Cancelled'
           WHERE fsi.order_item_id = ?`,
          [row.order_item_id]
        );
        if (poi && sh.total > poi.order_qty) {
          warnings.push({
            order_item_id: row.order_item_id,
            sku: row.sku,
            total_shipped: sh.total,
            order_qty: poi.order_qty,
            message: `over-shipped by ${sh.total - poi.order_qty}`,
          });
        }
      }

      // Re-sync the mirrored po_headers from the order's live shipments.
      await syncMirrorForShipment(conn, shipment_id);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [updated] = await pool.query(
      `SELECT id AS shipment_item_id, shipment_id, order_item_id, po_number_ref, sku, product_type, ship_qty
       FROM factory_shipment_items WHERE shipment_id = ?`,
      [shipment_id]
    );
    res.json({ shipment_id, items: updated, warnings });
  } catch (err) {
    console.error('PATCH /api/shipments/:id/items error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/shipments/orders/:orderId/ready-date
// Factory sets/updates the estimated production-finish date for an order it
// has items in. Propagates to the mirrored po_headers as a pre-ship ETA baseline.
router.patch('/orders/:orderId/ready-date', requireFactory, async (req, res) => {
  const order_id = parseInt(req.params.orderId, 10);
  const factory_id = req.user.factory_id;
  const { est_ready_date } = req.body;

  if (!Number.isInteger(order_id)) return res.status(400).json({ error: 'invalid orderId' });
  if (est_ready_date && !/^\d{4}-\d{2}-\d{2}$/.test(est_ready_date)) {
    return res.status(400).json({ error: 'est_ready_date must be YYYY-MM-DD or null' });
  }

  try {
    // Verify this factory has at least one item in the order
    const [[owned]] = await pool.query(
      'SELECT 1 AS ok FROM production_order_items WHERE order_id = ? AND factory_id = ? LIMIT 1',
      [order_id, factory_id]
    );
    if (!owned) return res.status(403).json({ error: 'access denied for this order' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        'UPDATE production_orders SET est_ready_date = ? WHERE order_id = ?',
        [est_ready_date || null, order_id]
      );
      if (result.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'Order not found' });
      }
      // Reflect the baseline into the remainder PO (its pre-ship ETA baseline).
      await syncRemainderPo(conn, order_id);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [[order]] = await pool.query(
      'SELECT order_id, order_number, est_ready_date FROM production_orders WHERE order_id = ?',
      [order_id]
    );
    res.json(order);
  } catch (err) {
    console.error('PATCH /api/shipments/orders/:orderId/ready-date error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
