const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_prod';

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      user_id:    payload.user_id,
      username:   payload.username,
      role:       payload.role,
      factory_id: payload.factory_id ?? null,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

function requireFactory(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'factory') return res.status(403).json({ error: 'Factory access required' });
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireFactory };
