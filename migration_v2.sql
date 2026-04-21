-- ============================================================
-- Migration v2 — Item Master, Logistics Rates, UOM Fields
-- Run this on the MySQL server (po_tracking database)
-- ============================================================

-- 1. Item Master (master data for SKU specs)
CREATE TABLE IF NOT EXISTS Item_Master (
    item_id            VARCHAR(50)  PRIMARY KEY,
    item_name          VARCHAR(100) NOT NULL,
    item_type          ENUM('Product','Material','Others') DEFAULT 'Others',
    qty_per_carton     INT          DEFAULT 1,
    carton_width       DECIMAL(10,2) DEFAULT 0,
    carton_length      DECIMAL(10,2) DEFAULT 0,
    carton_height      DECIMAL(10,2) DEFAULT 0,
    carton_weight      DECIMAL(10,2) DEFAULT 0,   -- kg per carton
    carton_volume      DECIMAL(10,4) DEFAULT 0,   -- CBM per carton
    default_weight_per_pc DECIMAL(10,3) DEFAULT 0.300, -- kg per piece (for Product)
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 2. Logistics Rates (rate cards per company/method)
CREATE TABLE IF NOT EXISTS Logistics_Rates (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    company_name    VARCHAR(50) NOT NULL,
    shipping_method VARCHAR(50) NOT NULL,
    charge_type     ENUM('Weight','Volume') NOT NULL,
    rate_price      DECIMAL(10,2) NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default rates (skip if already exist)
INSERT IGNORE INTO Logistics_Rates (id, company_name, shipping_method, charge_type, rate_price) VALUES
(1, 'HLT', 'เรือ', 'Volume', 4000),
(2, 'HLT', 'รถ',   'Weight', 15),
(3, 'CTW', 'เรือ', 'Volume', 3800),
(4, 'CTW', 'รถ',   'Weight', 18);

-- 3. Extend po_items with logistics & UOM columns
ALTER TABLE po_items
    ADD COLUMN IF NOT EXISTS item_type         VARCHAR(20)    DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS shipping_cartons  INT            DEFAULT 0,
    ADD COLUMN IF NOT EXISTS estimated_weight  DECIMAL(10,2)  DEFAULT 0,
    ADD COLUMN IF NOT EXISTS estimated_volume  DECIMAL(10,4)  DEFAULT 0,
    ADD COLUMN IF NOT EXISTS selected_logistics VARCHAR(100)  DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS shipping_cost     DECIMAL(10,2)  DEFAULT NULL;
