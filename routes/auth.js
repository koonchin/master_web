const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_prod';

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    let user;
    try {
      [[user]] = await pool.query(
        'SELECT user_id, username, password_hash, role, factory_id, permissions FROM users WHERE username = ?',
        [username]
      );
    } catch {
      [[user]] = await pool.query(
        'SELECT user_id, username, password_hash, role, factory_id FROM users WHERE username = ?',
        [username]
      );
    }
    // Always run bcrypt to prevent username enumeration via timing
    const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !match) return res.status(401).json({ error: 'Invalid credentials' });

    let perms;
    try { perms = JSON.parse(user.permissions || '[]'); } catch { perms = []; }
    if (user.role === 'admin') perms = ['purchase','warehouse','factory_users','user_management'];

    const payload = {
      user_id:    user.user_id,
      username:   user.username,
      role:       user.role,
      factory_id: user.factory_id ?? null,
      permissions: perms,
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.json({ token, role: user.role, factory_id: user.factory_id ?? null, username: user.username, permissions: perms });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
