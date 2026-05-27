const pool = require('../db');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_prod';

const ROUTE_MAP = [
  { pattern: /^\/api\/po\/[^/]+\/images/, process: 'PO_IMAGE' },
  { pattern: /^\/api\/po\/[^/]+\/items/, process: 'PO_ITEM' },
  { pattern: /^\/api\/po\/[^/]+\/extra-items/, process: 'PO_ITEM' },
  { pattern: /^\/api\/po/, process: 'PO' },
  { pattern: /^\/api\/items/, process: 'PO_ITEM' },
  { pattern: /^\/api\/receiving/, process: 'RECEIVING' },
  { pattern: /^\/api\/factories\/\d+\/users/, process: 'FACTORY_USER' },
  { pattern: /^\/api\/factories/, process: 'FACTORY' },
  { pattern: /^\/api\/users/, process: 'USER' },
  { pattern: /^\/api\/production-orders/, process: 'PRODUCTION_ORDER' },
  { pattern: /^\/api\/item-master/, process: 'ITEM_MASTER' },
  { pattern: /^\/api\/logistics-rates/, process: 'LOGISTICS' },
  { pattern: /^\/api\/po-images/, process: 'PO_IMAGE' },
  { pattern: /^\/api\/shipments/, process: 'SHIPMENT' },
];

const METHOD_ACTION = { POST: 'CREATE', PUT: 'UPDATE', DELETE: 'DELETE' };

function resolveProcess(url) {
  for (const r of ROUTE_MAP) {
    if (r.pattern.test(url)) return r.process;
  }
  return 'OTHER';
}

function extractTarget(url) {
  const parts = url.replace(/\?.*/, '').split('/').filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 1];
  return null;
}

function auditMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
  if (req.path === '/api/auth/login' || req.path === '/api/health') return next();

  const origEnd = res.end;
  res.end = function (...args) {
    origEnd.apply(res, args);

    if (res.statusCode < 400) {
      let user_id = null, username = 'anonymous';
      try {
        const header = req.headers['authorization'] || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (token) {
          const p = jwt.verify(token, JWT_SECRET);
          user_id = p.user_id;
          username = p.username;
        }
      } catch {}

      const action = METHOD_ACTION[req.method] || req.method;
      const process = resolveProcess(req.path);
      const target_id = extractTarget(req.originalUrl) || '';
      const detail = req.method === 'DELETE' ? '{}' : JSON.stringify(req.body || {}).substring(0, 2000);
      const ip = req.ip || req.connection?.remoteAddress || '';

      pool.query(
        'INSERT INTO activity_logs (user_id, username, action, process, target_id, detail, ip_address) VALUES (?,?,?,?,?,?,?)',
        [user_id, username, action, process, target_id, detail, ip]
      ).catch(() => {});
    }
  };
  next();
}

module.exports = auditMiddleware;
