// Run with: node run_migration_v3.js
const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');

const pool = mysql.createPool({
  host:            '139.144.119.186',
  port:            3306,
  user:            'gink',
  password:        'Chino002',
  database:        'po_tracking',
  connectionLimit: 3,
  multipleStatements: true,
});

(async () => {
  const sqlFile = path.join(__dirname, 'migration_v3.sql');
  const sql     = fs.readFileSync(sqlFile, 'utf8');

  // Split on semicolons, skip blank/comment-only chunks
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.replace(/--[^\n]*/g, '').trim().startsWith('/*'));

  for (const stmt of statements) {
    // Skip pure-comment blocks
    const code = stmt.replace(/--[^\n]*/g, '').trim();
    if (!code) continue;

    try {
      await pool.query(stmt);
      console.log('✅', stmt.replace(/\s+/g, ' ').substring(0, 80));
    } catch (e) {
      // ER_DUP_ENTRY          = INSERT IGNORE collision (already seeded)
      // ER_DUP_FIELDNAME      = column already exists (older MySQL without IF NOT EXISTS)
      // ER_TABLE_EXISTS_ERROR = table already exists
      // ER_DUP_KEYNAME        = index already exists
      if (['ER_DUP_ENTRY', 'ER_DUP_FIELDNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_DUP_KEYNAME'].includes(e.code)) {
        console.log('⏭  skip (already exists):', stmt.replace(/\s+/g, ' ').substring(0, 60));
      } else {
        console.error('❌', e.message);
      }
    }
  }

  console.log('\n✅ Migration v3 complete.');
  await pool.end();
  process.exit(0);
})();
