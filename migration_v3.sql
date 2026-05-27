-- ============================================================
-- Migration v3 — Production Order System (Phase 1)
-- ระบบใบสั่งผลิต: โรงงาน, ผู้ใช้งาน, ออเดอร์, การจัดส่ง
-- Run: node run_migration_v3.js
-- ============================================================

USE po_tracking;

-- --------------------------------------------------------
-- Table: factories (ข้อมูลโรงงาน)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS factories (
  factory_id  INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: users (ผู้ใช้งานระบบ — admin และ factory)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id       INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','factory') NOT NULL,
  factory_id    INT NULL,                          -- NULL = admin ไม่ผูกกับโรงงาน
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (factory_id) REFERENCES factories(factory_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: priority_sla (กำหนด SLA ตามระดับความสำคัญ)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS priority_sla (
  priority          ENUM('Low','Normal','High','Urgent') PRIMARY KEY,
  ship_within_min_days INT NOT NULL,               -- จำนวนวันขั้นต่ำที่ต้องจัดส่ง
  ship_within_max_days INT NOT NULL                -- จำนวนวันสูงสุดที่ยอมรับได้
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: production_orders (ใบสั่งผลิต header)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_orders (
  order_id     INT AUTO_INCREMENT PRIMARY KEY,
  order_number VARCHAR(50) UNIQUE NOT NULL,        -- เลขที่ใบสั่งผลิต เช่น PRD-2026-001
  project_name VARCHAR(255) NOT NULL,
  priority     ENUM('Low','Normal','High','Urgent') DEFAULT 'Normal',
  status       ENUM('Pending','Partial','Fulfilled','Cancelled') DEFAULT 'Pending',
  order_date   DATE,
  due_date     DATE,                               -- วันกำหนดส่ง
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: production_order_items (รายการสินค้าในใบสั่งผลิต)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_order_items (
  item_id    INT AUTO_INCREMENT PRIMARY KEY,
  order_id   INT NOT NULL,
  factory_id INT NOT NULL,                         -- โรงงานที่รับผลิต SKU นี้
  sku        VARCHAR(100) NOT NULL,
  order_qty  INT NOT NULL CHECK (order_qty > 0),   -- จำนวนที่สั่งผลิต
  remark     TEXT,
  FOREIGN KEY (order_id)   REFERENCES production_orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (factory_id) REFERENCES factories(factory_id),
  INDEX idx_factory (factory_id),
  INDEX idx_sku     (sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: factory_shipments (การจัดส่งจากโรงงาน)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS factory_shipments (
  shipment_id       INT AUTO_INCREMENT PRIMARY KEY,
  shipment_number   VARCHAR(50) UNIQUE NOT NULL,   -- เลขที่การจัดส่ง เช่น SHP-2026-001
  factory_id        INT NOT NULL,
  logistics_provider VARCHAR(100),                 -- บริษัทขนส่ง
  tracking_number   VARCHAR(100),
  ship_out_date     DATE,                          -- วันที่ออกจากโรงงาน
  est_arrival_date  DATE,                          -- วันที่คาดว่าจะถึง
  actual_arrival_date DATE NULL,                   -- วันที่ถึงจริง
  status            ENUM('Shipped_CN','Thai_Customs','Arrived','Completed','Cancelled') DEFAULT 'Shipped_CN',
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (factory_id) REFERENCES factories(factory_id),
  INDEX idx_status_eta (status, est_arrival_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: factory_shipment_items (รายการสินค้าในการจัดส่ง)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS factory_shipment_items (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  shipment_id   INT NOT NULL,
  order_item_id INT NOT NULL,                      -- อ้างอิง production_order_items
  sku           VARCHAR(100) NOT NULL,
  ship_qty      INT NOT NULL CHECK (ship_qty > 0), -- จำนวนที่จัดส่งจริง
  FOREIGN KEY (shipment_id)   REFERENCES factory_shipments(shipment_id) ON DELETE CASCADE,
  FOREIGN KEY (order_item_id) REFERENCES production_order_items(item_id),
  INDEX idx_order_item (order_item_id),
  UNIQUE KEY uq_shipment_item (shipment_id, order_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Seed Data: priority_sla
-- ============================================================
INSERT IGNORE INTO priority_sla (priority, ship_within_min_days, ship_within_max_days) VALUES
('Urgent',  5,  7),
('High',    7,  14),
('Normal',  14, 30),
('Low',     30, 60);

-- ============================================================
-- Safe ALTER: เพิ่ม shipment_id ใน receiving_logs (ถ้ายังไม่มี)
-- เชื่อม receiving_logs กับ factory_shipments
-- ============================================================
ALTER TABLE receiving_logs
  ADD COLUMN shipment_id INT NULL AFTER po_number;

ALTER TABLE receiving_logs
  ADD INDEX idx_shipment (shipment_id);

-- ============================================================
-- Demo Data: โรงงานตัวอย่าง
-- ============================================================
INSERT IGNORE INTO factories (name) VALUES ('Factory A (Demo)');

-- ============================================================
-- v3.1 patch: add order_person to production_orders
-- ============================================================
ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS order_person VARCHAR(64) DEFAULT NULL AFTER project_name;

-- ============================================================
-- Admin user: สร้างแยกต่างหากด้วย node create_admin.js
-- ============================================================
SELECT 'run node create_admin.js to create admin user' AS notice
