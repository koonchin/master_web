require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));          // serve frontend
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // serve uploaded photos

// Ensure uploads folder exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

// Multer config for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e5);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  },
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Database connected' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ============================================================
// PO HEADERS
// ============================================================

// GET /api/po — list all POs with SKU list attached
app.get('/api/po', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT ph.*,
        GROUP_CONCAT(pi.sku ORDER BY pi.sku SEPARATOR '|') AS skus
      FROM po_headers ph
      LEFT JOIN po_items pi ON ph.po_number = pi.po_number
      GROUP BY ph.po_id
      ORDER BY ph.created_at DESC
    `);
    // skus → array for easier frontend use
    const result = rows.map(r => ({
      ...r,
      skus: r.skus ? r.skus.split('|') : [],
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/po/:poNumber — get single PO with items + logs
app.get('/api/po/:poNumber', async (req, res) => {
  try {
    const { poNumber } = req.params;
    const [[po]] = await pool.query('SELECT * FROM po_headers WHERE po_number = ?', [poNumber]);
    if (!po) return res.status(404).json({ error: 'PO not found' });

    const [items] = await pool.query('SELECT * FROM po_items WHERE po_number = ?', [poNumber]);
    const [logs] = await pool.query('SELECT * FROM receiving_logs WHERE po_number = ?', [poNumber]);

    res.json({ ...po, items, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/po — create new PO with items
app.post('/api/po', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { po_number, project_name, order_date, status,
            est_lead_time, logistics_company, shipping_method, items = [] } = req.body;

    if (!po_number || !project_name) {
      return res.status(400).json({ error: 'po_number and project_name are required' });
    }
    const [[existing]] = await conn.query('SELECT po_id FROM po_headers WHERE po_number = ?', [po_number]);
    if (existing) return res.status(409).json({ error: `PO Number "${po_number}" มีอยู่แล้ว` });

    const leadTime = shipping_method === 'รถ' ? 7 : shipping_method === 'เรือ' ? 30 : (est_lead_time || 25);
    await conn.query(
      `INSERT INTO po_headers
         (po_number, project_name, order_date, status, est_lead_time, logistics_company, shipping_method)
       VALUES (?,?,?,?,?,?,?)`,
      [po_number, project_name, order_date || null, status || 'Draft',
       leadTime, logistics_company || null, shipping_method || null]
    );

    for (const item of items) {
      if (item.sku && item.order_qty > 0) {
        await conn.query(
          'INSERT INTO po_items (po_number, sku, order_qty, remark_purchase) VALUES (?,?,?,?)',
          [po_number, item.sku, item.order_qty, item.remark_purchase || '']
        );
      }
    }

    await conn.commit();
    const [[newPO]] = await pool.query('SELECT * FROM po_headers WHERE po_number = ?', [po_number]);
    res.status(201).json(newPO);
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/po/:poNumber — update PO header
app.put('/api/po/:poNumber', async (req, res) => {
  try {
    const { poNumber } = req.params;
    const { status, departure_date, est_lead_time, project_name,
            logistics_company, shipping_method } = req.body;

    const fields = [];
    const values = [];
    if (status !== undefined)             { fields.push('status = ?');             values.push(status); }
    if (departure_date !== undefined)     { fields.push('departure_date = ?');     values.push(departure_date || null); }
    if (project_name !== undefined)       { fields.push('project_name = ?');       values.push(project_name); }
    if (logistics_company !== undefined)  { fields.push('logistics_company = ?');  values.push(logistics_company || null); }
    if (shipping_method !== undefined) {
      fields.push('shipping_method = ?');
      values.push(shipping_method || null);
      // Auto-set lead time when shipping method changes
      const autoLead = shipping_method === 'รถ' ? 7 : shipping_method === 'เรือ' ? 30 : null;
      if (autoLead && est_lead_time === undefined) {
        fields.push('est_lead_time = ?'); values.push(autoLead);
      }
    }
    if (est_lead_time !== undefined)      { fields.push('est_lead_time = ?');      values.push(est_lead_time); }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(poNumber);
    await pool.query(`UPDATE po_headers SET ${fields.join(', ')} WHERE po_number = ?`, values);
    const [[updated]] = await pool.query('SELECT * FROM po_headers WHERE po_number = ?', [poNumber]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/po/:poNumber
app.delete('/api/po/:poNumber', async (req, res) => {
  try {
    await pool.query('DELETE FROM po_headers WHERE po_number = ?', [req.params.poNumber]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PO ITEMS
// ============================================================

// POST /api/po/:poNumber/items — add item
app.post('/api/po/:poNumber/items', async (req, res) => {
  try {
    const { poNumber } = req.params;
    const { sku, order_qty, remark_purchase } = req.body;
    if (!sku || !order_qty) return res.status(400).json({ error: 'sku and order_qty are required' });

    const [result] = await pool.query(
      'INSERT INTO po_items (po_number, sku, order_qty, remark_purchase) VALUES (?,?,?,?)',
      [poNumber, sku, order_qty, remark_purchase || '']
    );
    res.status(201).json({ item_id: result.insertId, po_number: poNumber, sku, order_qty, remark_purchase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/items/:itemId — edit SKU item
app.put('/api/items/:itemId', async (req, res) => {
  try {
    const { sku, order_qty, remark_purchase } = req.body;
    const fields = [], values = [];
    if (sku !== undefined)             { fields.push('sku = ?');             values.push(sku); }
    if (order_qty !== undefined)       { fields.push('order_qty = ?');       values.push(order_qty); }
    if (remark_purchase !== undefined) { fields.push('remark_purchase = ?'); values.push(remark_purchase); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.itemId);
    await pool.query(`UPDATE po_items SET ${fields.join(', ')} WHERE item_id = ?`, values);
    const [[item]] = await pool.query('SELECT * FROM po_items WHERE item_id = ?', [req.params.itemId]);
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/items/:itemId
app.delete('/api/items/:itemId', async (req, res) => {
  try {
    await pool.query('DELETE FROM po_items WHERE item_id = ?', [req.params.itemId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// RECEIVING LOGS
// ============================================================

// GET /api/receiving/:poNumber
app.get('/api/receiving/:poNumber', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM receiving_logs WHERE po_number = ?', [req.params.poNumber]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/receiving — upsert logs for a PO (replace all by po_number)
app.post('/api/receiving', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { po_number, logs = [], new_status } = req.body;

    // Delete old logs for this PO then re-insert
    await conn.query('DELETE FROM receiving_logs WHERE po_number = ?', [po_number]);

    for (const log of logs) {
      await conn.query(
        `INSERT INTO receiving_logs
          (po_number, sku, arrived_date, receive_qty, pass_qc_qty, not_pass_qc_qty, photo_url, remark_warehouse)
         VALUES (?,?,?,?,?,?,?,?)`,
        [po_number, log.sku, log.arrived_date || null, log.receive_qty, log.pass_qc_qty, log.not_pass_qc_qty, log.photo_url || '', log.remark_warehouse || '']
      );
    }

    // Update PO status
    if (new_status) {
      await conn.query('UPDATE po_headers SET status = ? WHERE po_number = ?', [new_status, po_number]);
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ============================================================
// PHOTO UPLOAD
// ============================================================
app.post('/api/upload', upload.array('photos', 10), (req, res) => {
  try {
    const urls = req.files.map(f => `/uploads/${f.filename}`);
    res.json({ urls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EXPORT (CSV)
// ============================================================
app.get('/api/export', async (req, res) => {
  try {
    const { year, month, logistics_company, shipping_method, status } = req.query;
    const conditions = [];
    const params = [];
    if (year)              { conditions.push('YEAR(ph.order_date) = ?');   params.push(+year); }
    if (month)             { conditions.push('MONTH(ph.order_date) = ?');  params.push(+month); }
    if (logistics_company) { conditions.push('ph.logistics_company = ?');  params.push(logistics_company); }
    if (shipping_method)   { conditions.push('ph.shipping_method = ?');    params.push(shipping_method); }
    if (status)            { conditions.push('ph.status = ?');             params.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [rows] = await pool.query(`
      SELECT ph.po_number, ph.project_name, ph.logistics_company, ph.shipping_method,
             ph.order_date, ph.status, ph.departure_date, ph.est_lead_time,
             COUNT(DISTINCT pi.item_id)        AS item_count,
             COALESCE(SUM(pi.order_qty), 0)    AS total_order_qty,
             COALESCE(SUM(rl.receive_qty), 0)  AS total_receive_qty
      FROM po_headers ph
      LEFT JOIN po_items pi ON ph.po_number = pi.po_number
      LEFT JOIN receiving_logs rl ON ph.po_number = rl.po_number
      ${where}
      GROUP BY ph.po_id
      ORDER BY ph.order_date DESC, ph.created_at DESC
    `, params);

    function calcETA(row) {
      if (!row.departure_date || !row.est_lead_time) return '';
      const d = new Date(row.departure_date + 'T00:00:00');
      d.setDate(d.getDate() + row.est_lead_time);
      return d.toISOString().split('T')[0];
    }
    const STATUS_TH = {
      Draft: 'Draft', Ordered: 'Ordered', Shipped_CN: 'Shipped from China',
      Thai_Customs: 'Thai Customs', Arrived: 'Arrived', Completed: 'Completed',
    };

    const hdr = 'PO Number,Project Name,Logistics Company,Shipping Method,Order Date,Status,Departure Date,ETA,Lead Time (days),Item Count,Total Order QTY,Total Receive QTY';
    const csvRows = rows.map(r =>
      [r.po_number, r.project_name, r.logistics_company || '', r.shipping_method || '',
       r.order_date || '', STATUS_TH[r.status] || r.status, r.departure_date || '',
       calcETA(r), r.est_lead_time || '', r.item_count, r.total_order_qty, r.total_receive_qty]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    );

    const csv = '\uFEFF' + [hdr, ...csvRows].join('\r\n');
    const fname = `PO_Export_${year || 'All'}_${month ? String(month).padStart(2, '0') : 'All'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, async () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`📦 PO Tracking System — Muslin Pajamas\n`);
  try {
    await pool.query('SELECT 1');
    console.log(`✅ MySQL connected — ${process.env.DB_HOST}/${process.env.DB_NAME}`);
  } catch (err) {
    console.error(`❌ MySQL connection failed: ${err.message}`);
  }
});
