const express = require('express');
const pool    = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const VALID_STATUSES = ['Pending', 'Partial', 'Fulfilled', 'Cancelled'];
const VALID_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

// GET /api/production-orders — list all orders with items
router.get('/', requireAdmin, async (req, res) => {
  try {
    const [orderRows] = await pool.query(`
      SELECT po.order_id, po.order_number, po.project_name, po.priority,
             po.order_date, po.due_date, po.status, po.created_at
      FROM production_orders po
      ORDER BY po.created_at DESC
    `);

    if (orderRows.length === 0) return res.json([]);

    const orderIds = orderRows.map(o => o.order_id);
    const [itemRows] = await pool.query(`
      SELECT poi.item_id, poi.order_id, poi.factory_id, f.name AS factory_name,
             poi.sku, poi.order_qty, poi.remark
      FROM production_order_items poi
      LEFT JOIN factories f ON poi.factory_id = f.factory_id
      WHERE poi.order_id IN (?)
    `, [orderIds]);

    // Group items by order_id
    const itemsByOrder = {};
    for (const item of itemRows) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    }

    const result = orderRows.map(order => ({
      ...order,
      items: itemsByOrder[order.order_id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /api/production-orders error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/production-orders — create a new order with items
router.post('/', requireAdmin, async (req, res) => {
  const { order_number, project_name, priority, order_date, items = [] } = req.body;

  // Validate required fields
  if (!order_number) return res.status(400).json({ error: 'order_number is required' });
  if (!project_name) return res.status(400).json({ error: 'project_name is required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'items are required' });

  // Validate priority
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
  }

  // Validate each item
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.factory_id) return res.status(400).json({ error: `items[${i}].factory_id is required` });
    if (!item.sku)        return res.status(400).json({ error: `items[${i}].sku is required` });
    if (!item.order_qty || item.order_qty <= 0)
      return res.status(400).json({ error: `items[${i}].order_qty must be > 0` });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Calculate due_date from priority_sla table
    let due_date = null;
    if (priority && order_date) {
      const [[sla]] = await conn.query(
        'SELECT ship_within_max_days FROM priority_sla WHERE priority = ?',
        [priority]
      );
      if (sla) {
        const base = new Date(order_date + 'T00:00:00');
        base.setDate(base.getDate() + sla.ship_within_max_days);
        due_date = base.toISOString().split('T')[0];
      }
    }

    // Insert order header
    const [headerResult] = await conn.query(
      `INSERT INTO production_orders (order_number, project_name, priority, order_date, due_date, status)
       VALUES (?, ?, ?, ?, ?, 'Pending')`,
      [order_number, project_name, priority || null, order_date || null, due_date]
    );
    const order_id = headerResult.insertId;

    // Insert items
    for (const item of items) {
      await conn.query(
        `INSERT INTO production_order_items (order_id, factory_id, sku, order_qty, remark)
         VALUES (?, ?, ?, ?, ?)`,
        [order_id, item.factory_id, item.sku, item.order_qty, item.remark || '']
      );
    }

    await conn.commit();

    // Fetch the created order with items
    const [[order]] = await pool.query(
      `SELECT order_id, order_number, project_name, priority, order_date, due_date, status, created_at
       FROM production_orders WHERE order_id = ?`,
      [order_id]
    );
    const [createdItems] = await pool.query(
      `SELECT poi.item_id, poi.order_id, poi.factory_id, f.name AS factory_name,
              poi.sku, poi.order_qty, poi.remark
       FROM production_order_items poi
       LEFT JOIN factories f ON poi.factory_id = f.factory_id
       WHERE poi.order_id = ?`,
      [order_id]
    );

    res.status(201).json({ ...order, items: createdItems });
  } catch (err) {
    await conn.rollback();
    console.error('POST /api/production-orders error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

// PATCH /api/production-orders/:id/status — update order status
router.patch('/:id/status', requireAdmin, async (req, res) => {
  try {
    const order_id = parseInt(req.params.id, 10);
    const { status } = req.body;

    if (!status) return res.status(400).json({ error: 'status is required' });
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const [result] = await pool.query(
      'UPDATE production_orders SET status = ? WHERE order_id = ?',
      [status, order_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Order not found' });

    const [[order]] = await pool.query(
      'SELECT order_id, order_number, project_name, priority, order_date, due_date, status, created_at FROM production_orders WHERE order_id = ?',
      [order_id]
    );
    res.json(order);
  } catch (err) {
    console.error('PATCH /api/production-orders/:id/status error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
