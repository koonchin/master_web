const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/factories — list all factories
router.get('/', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT factory_id, name, created_at FROM factories ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/factories error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/factories — create a factory
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const [result] = await pool.query(
      'INSERT INTO factories (name) VALUES (?)',
      [name]
    );
    const [[factory]] = await pool.query(
      'SELECT factory_id, name, created_at FROM factories WHERE factory_id = ?',
      [result.insertId]
    );
    res.status(201).json(factory);
  } catch (err) {
    console.error('POST /api/factories error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/factories/:id/users — create a factory login user
router.post('/:id/users', requireAdmin, async (req, res) => {
  try {
    const factory_id = parseInt(req.params.id, 10);
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    // Check if username already taken
    const [[existing]] = await pool.query(
      'SELECT user_id FROM users WHERE username = ?',
      [username]
    );
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash, role, factory_id) VALUES (?, ?, ?, ?)',
      [username, password_hash, 'factory', factory_id]
    );

    res.status(201).json({
      user_id:    result.insertId,
      username,
      role:       'factory',
      factory_id,
    });
  } catch (err) {
    console.error('POST /api/factories/:id/users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
