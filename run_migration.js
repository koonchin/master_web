// Run with: node run_migration.js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: '139.144.119.186',
  port: 3306,
  user: 'gink',
  password: 'Chino002',
  database: 'po_tracking',
  connectionLimit: 3,
});

const statements = [
  `CREATE TABLE IF NOT EXISTS Item_Master (
    item_id               VARCHAR(50)   PRIMARY KEY,
    item_name             VARCHAR(100)  NOT NULL,
    item_type             ENUM('Product','Material','Others') DEFAULT 'Others',
    qty_per_carton        INT           DEFAULT 1,
    carton_width          DECIMAL(10,2) DEFAULT 0,
    carton_length         DECIMAL(10,2) DEFAULT 0,
    carton_height         DECIMAL(10,2) DEFAULT 0,
    carton_weight         DECIMAL(10,2) DEFAULT 0,
    carton_volume         DECIMAL(10,4) DEFAULT 0,
    default_weight_per_pc DECIMAL(10,3) DEFAULT 0.300,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS Logistics_Rates (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    company_name    VARCHAR(50)  NOT NULL,
    shipping_method VARCHAR(50)  NOT NULL,
    charge_type     ENUM('Weight','Volume') NOT NULL,
    rate_price      DECIMAL(10,2) NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `INSERT IGNORE INTO Logistics_Rates (id, company_name, shipping_method, charge_type, rate_price) VALUES
    (1,'HLT','เรือ','Volume',4000),
    (2,'HLT','รถ','Weight',15),
    (3,'CTW','เรือ','Volume',3800),
    (4,'CTW','รถ','Weight',18)`,
  `ALTER TABLE po_items ADD COLUMN item_type          VARCHAR(20)   DEFAULT NULL`,
  `ALTER TABLE po_items ADD COLUMN shipping_cartons   INT           DEFAULT 0`,
  `ALTER TABLE po_items ADD COLUMN estimated_weight   DECIMAL(10,2) DEFAULT 0`,
  `ALTER TABLE po_items ADD COLUMN estimated_volume   DECIMAL(10,4) DEFAULT 0`,
  `ALTER TABLE po_items ADD COLUMN selected_logistics VARCHAR(100)  DEFAULT NULL`,
  `ALTER TABLE po_items ADD COLUMN shipping_cost      DECIMAL(10,2) DEFAULT NULL`,
  `CREATE TABLE IF NOT EXISTS po_images (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    po_number   VARCHAR(50)  NOT NULL,
    photo_url   VARCHAR(500) NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE Item_Master ADD COLUMN measurement_photo_url VARCHAR(500) DEFAULT NULL`,
  `ALTER TABLE po_headers ADD COLUMN actual_billed_weight DECIMAL(10,2) DEFAULT 0`,
  `ALTER TABLE po_headers ADD COLUMN actual_billed_volume DECIMAL(10,4) DEFAULT 0`,
  `ALTER TABLE po_headers ADD COLUMN discrepancy_ack TINYINT(1) DEFAULT 0`,
  `ALTER TABLE po_items ADD COLUMN is_extra TINYINT(1) DEFAULT 0`,
  `ALTER TABLE po_headers ADD COLUMN factory_code VARCHAR(50) DEFAULT NULL`,
  // Add weight_rate + volume_rate columns to Logistics_Rates (replaces charge_type+rate_price logic)
  `ALTER TABLE Logistics_Rates ADD COLUMN weight_rate DECIMAL(10,2) DEFAULT 0`,
  `ALTER TABLE Logistics_Rates ADD COLUMN volume_rate DECIMAL(10,2) DEFAULT 0`,
  // Migrate existing single-rate rows to the new columns (only when new columns are still 0)
  `UPDATE Logistics_Rates SET weight_rate = rate_price WHERE charge_type = 'Weight' AND weight_rate = 0`,
  `UPDATE Logistics_Rates SET volume_rate = rate_price WHERE charge_type = 'Volume' AND volume_rate = 0`,
  `CREATE TABLE IF NOT EXISTS po_status_history (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    po_number  VARCHAR(50) NOT NULL,
    status     VARCHAR(30) NOT NULL,
    status_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_po_status (po_number, status)
  )`,
];

(async () => {
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      console.log('✅', stmt.trim().replace(/\s+/g,' ').substring(0,80));
    } catch (e) {
      // ER_DUP_ENTRY = INSERT IGNORE collision
      // ER_DUP_FIELDNAME = column already exists (ALTER TABLE on older MySQL)
      // ER_TABLE_EXISTS_ERROR = table already exists
      if (['ER_DUP_ENTRY','ER_DUP_FIELDNAME','ER_TABLE_EXISTS_ERROR'].includes(e.code)) {
        console.log('⏭  skip (already exists):', stmt.trim().replace(/\s+/g,' ').substring(0,60));
      } else {
        console.error('❌', e.message);
      }
    }
  }
  console.log('\n✅ Migration complete.');
  await pool.end();
  process.exit(0);
})();
