const express = require('express');
const pool    = require('../db');
const { requireFactory } = require('../middleware/auth');

const router = express.Router();

const VALID_FACTORY_STATUSES = ['Thai_Customs', 'Arrived', 'Completed', 'Cancelled'];

// GET /api/shipments/my-orders
// Returns production order items assigned to this factory with pending qty to ship
router.get('/my-orders', requireFactory, async (req, res) => {
  try {
    const factory_id = req.user.factory_id;

    const [rows] = await pool.query(`
      SELECT
        poi.item_id, poi.order_id, poi.sku, poi.order_qty, poi.remark,
        po.order_number, po.project_name, po.priority, po.due_date, po.status AS order_status,
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
      ORDER BY FIELD(po.priority, 'Urgent', 'High', 'Normal', 'Low') ASC, po.due_date ASC
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
      SELECT shipment_id, factory_id, shipment_number, logistics_provider,
             tracking_number, ship_out_date, est_arrival_date, status, created_at
      FROM factory_shipments
      WHERE factory_id = ?
      ORDER BY created_at DESC
    `, [factory_id]);

    if (shipmentRows.length === 0) return res.json([]);

    const shipmentIds = shipmentRows.map(s => s.shipment_id);
    const [itemRows] = await pool.query(`
      SELECT fsi.id AS shipment_item_id, fsi.shipment_id, fsi.order_item_id,
             fsi.sku, fsi.ship_qty
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
    logistics_provider,
    tracking_number,
    ship_out_date,
    est_arrival_date,
    items = [],
  } = req.body;

  const factory_id = req.user.factory_id;

  // --- Validation (all before getConnection) ---
  if (!shipment_number)   return res.status(400).json({ error: 'shipment_number is required' });
  if (!ship_out_date)     return res.status(400).json({ error: 'ship_out_date is required' });
  if (!est_arrival_date)  return res.status(400).json({ error: 'est_arrival_date is required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'items are required' });

  // Validate ship_qty > 0 for every item before any DB call
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.order_item_id) return res.status(400).json({ error: `items[${i}].order_item_id is required` });
    if (!item.ship_qty || item.ship_qty <= 0)
      return res.status(400).json({ error: `items[${i}].ship_qty must be > 0` });
  }

  // Validate ownership + remaining qty for each item (before transaction)
  try {
    for (const item of items) {
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

      const remaining = poi.order_qty - shipped.already_shipped;
      if (item.ship_qty > remaining) {
        return res.status(400).json({
          error: `item order_item_id=${item.order_item_id}: ship_qty ${item.ship_qty} exceeds remaining ${remaining}`,
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

    // Insert shipment header
    const [headerResult] = await conn.query(`
      INSERT INTO factory_shipments
        (factory_id, shipment_number, logistics_provider, tracking_number,
         ship_out_date, est_arrival_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'Shipped_CN')
    `, [
      factory_id,
      shipment_number,
      logistics_provider || null,
      tracking_number || shipment_number,
      ship_out_date,
      est_arrival_date,
    ]);
    const shipment_id = headerResult.insertId;

    // Insert items — fetch sku from production_order_items
    for (const item of items) {
      const [[poi]] = await conn.query(
        'SELECT sku FROM production_order_items WHERE item_id = ?',
        [item.order_item_id]
      );
      await conn.query(`
        INSERT INTO factory_shipment_items (shipment_id, order_item_id, sku, ship_qty)
        VALUES (?, ?, ?, ?)
      `, [shipment_id, item.order_item_id, poi.sku, item.ship_qty]);
    }

    await conn.commit();

    // Return created shipment with items
    const [[shipment]] = await pool.query(`
      SELECT shipment_id, factory_id, shipment_number, logistics_provider,
             tracking_number, ship_out_date, est_arrival_date, status, created_at
      FROM factory_shipments WHERE shipment_id = ?
    `, [shipment_id]);

    const [createdItems] = await pool.query(`
      SELECT id AS shipment_item_id, shipment_id, order_item_id, sku, ship_qty
      FROM factory_shipment_items WHERE shipment_id = ?
    `, [shipment_id]);

    res.status(201).json({ ...shipment, items: createdItems });
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

    await pool.query(
      'UPDATE factory_shipments SET status = ? WHERE shipment_id = ?',
      [status, shipment_id]
    );

    const [[shipment]] = await pool.query(`
      SELECT shipment_id, factory_id, shipment_number, logistics_provider,
             tracking_number, ship_out_date, est_arrival_date, status, created_at
      FROM factory_shipments WHERE shipment_id = ?
    `, [shipment_id]);

    res.json(shipment);
  } catch (err) {
    console.error('PATCH /api/shipments/:id/status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
