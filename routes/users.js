const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT user_id, username, role, factory_id, permissions, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(rows.map(r => {
      let perms = [];
      try { perms = JSON.parse(r.permissions || '[]'); } catch {}
      return { ...r, permissions: perms };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { username, password, role, permissions } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const [[existing]] = await pool.query('SELECT user_id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)',
      [username, hash, role || 'user', JSON.stringify(permissions || [])]
    );
    res.status(201).json({ user_id: result.insertId, username, role: role || 'user', permissions: permissions || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { username, password, role, permissions } = req.body;
    const fields = [], values = [];
    if (username !== undefined) { fields.push('username = ?'); values.push(username); }
    if (password) { fields.push('password_hash = ?'); values.push(await bcrypt.hash(password, 10)); }
    if (role !== undefined) { fields.push('role = ?'); values.push(role); }
    if (permissions !== undefined) { fields.push('permissions = ?'); values.push(JSON.stringify(permissions)); }
    if (!fields.length) return res.status(400).json({ error: 'No fields' });
    values.push(req.params.id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`, values);
    const [[user]] = await pool.query(
      'SELECT user_id, username, role, factory_id, permissions FROM users WHERE user_id = ?', [req.params.id]
    );
    let perms = [];
    try { perms = JSON.parse(user.permissions || '[]'); } catch {}
    res.json({ ...user, permissions: perms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    if (+req.params.id === req.user.user_id) return res.status(400).json({ error: 'Cannot delete yourself' });
    await pool.query('DELETE FROM users WHERE user_id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
