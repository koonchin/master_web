// Guarded migration runner.
// Adds production_orders.est_ready_date only if it does not already exist, so
// re-running is a no-op. Uses the app's DB pool (reads .env).
const pool = require('../db');

(async () => {
  const [[col]] = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'production_orders'
       AND column_name = 'est_ready_date'`
  );
  if (col) {
    console.log('SKIP: production_orders.est_ready_date already exists');
  } else {
    await pool.query('ALTER TABLE production_orders ADD COLUMN est_ready_date DATE NULL AFTER due_date');
    console.log('DONE: added production_orders.est_ready_date');
  }
  await pool.end();
})().catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
