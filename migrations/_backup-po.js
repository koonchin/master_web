// Logical backup before the split-PO-per-shipment migration.
// Dumps every table touched by the new mirror model (the 5 po_number-keyed
// tables) plus the World-B source tables, to a timestamped JSON file.
// READ-ONLY against the DB; the only write is the local backup file.
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const TABLES = [
  // World A — mutated by the mirror (full cascade set)
  'po_headers', 'po_items', 'receiving_logs', 'po_images', 'po_status_history',
  // World B — source of truth (snapshot for reference; not mutated)
  'production_orders', 'production_order_items', 'factory_shipments', 'factory_shipment_items',
];

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `po_tracking_backup_${stamp}.json`);

  const dump = { db: process.env.DB_NAME, taken_at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    const [rows] = await pool.query(`SELECT * FROM \`${t}\``);
    dump.tables[t] = rows;
    console.log(`${t}: ${rows.length} rows`);
  }

  fs.writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');
  console.log(`\nBackup written: ${file}`);
  await pool.end();
})().catch((e) => { console.error('BACKUP FAILED:', e.message); process.exit(1); });
