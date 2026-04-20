-- Run this file once to set up the database
-- mysql -h 139.144.119.186 -u gink -pChino002 < schema.sql

CREATE DATABASE IF NOT EXISTS po_tracking
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE po_tracking;

-- --------------------------------------------------------
-- Table: po_headers
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS po_headers (
  po_id         INT AUTO_INCREMENT PRIMARY KEY,
  po_number     VARCHAR(50) NOT NULL UNIQUE,
  project_name  VARCHAR(255) NOT NULL,
  order_date    DATE,
  status        ENUM('Draft','Ordered','Shipped_CN','Thai_Customs','Arrived','Completed') NOT NULL DEFAULT 'Draft',
  departure_date DATE,
  est_lead_time  INT DEFAULT 25,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table: po_items
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS po_items (
  item_id          INT AUTO_INCREMENT PRIMARY KEY,
  po_number        VARCHAR(50) NOT NULL,
  sku              VARCHAR(100) NOT NULL,
  order_qty        INT NOT NULL DEFAULT 0,
  remark_purchase  TEXT,
  FOREIGN KEY (po_number) REFERENCES po_headers(po_number) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Table: receiving_logs
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS receiving_logs (
  log_id             INT AUTO_INCREMENT PRIMARY KEY,
  po_number          VARCHAR(50) NOT NULL,
  sku                VARCHAR(100) NOT NULL,
  arrived_date       DATE,
  receive_qty        INT DEFAULT 0,
  pass_qc_qty        INT DEFAULT 0,
  not_pass_qc_qty    INT DEFAULT 0,
  photo_url          VARCHAR(500),
  remark_warehouse   TEXT,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (po_number) REFERENCES po_headers(po_number) ON DELETE CASCADE,
  UNIQUE KEY uq_po_sku (po_number, sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- --------------------------------------------------------
-- Demo Data
-- --------------------------------------------------------
INSERT IGNORE INTO po_headers (po_number, project_name, order_date, status, departure_date, est_lead_time) VALUES
('PO-2026-001', 'Muslin Pajamas Summer 2026',  DATE_SUB(CURDATE(),INTERVAL 50 DAY), 'Shipped_CN',   DATE_SUB(CURDATE(),INTERVAL 15 DAY), 25),
('PO-2026-002', 'Kids Collection Q2',          DATE_SUB(CURDATE(),INTERVAL 40 DAY), 'Thai_Customs', DATE_SUB(CURDATE(),INTERVAL 22 DAY), 18),
('PO-2026-003', 'Basic Tee Restock',           DATE_SUB(CURDATE(),INTERVAL 60 DAY), 'Arrived',      DATE_SUB(CURDATE(),INTERVAL 35 DAY), 20),
('PO-2026-004', 'Winter Sleepwear 2026',       DATE_SUB(CURDATE(),INTERVAL 10 DAY), 'Ordered',      NULL,                                30),
('PO-2026-005', 'Muslin Bath Set',             DATE_SUB(CURDATE(),INTERVAL 80 DAY), 'Completed',    DATE_SUB(CURDATE(),INTERVAL 55 DAY), 22),
('PO-2026-006', 'Gift Box Q2 (Delayed)',       DATE_SUB(CURDATE(),INTERVAL 70 DAY), 'Shipped_CN',   DATE_SUB(CURDATE(),INTERVAL 40 DAY), 20);

INSERT IGNORE INTO po_items (po_number, sku, order_qty, remark_purchase) VALUES
('PO-2026-001', 'MP-BJM-001-S', 200, 'ผ้ามัสลิน 100%, ลาย Bear ไซส์ S'),
('PO-2026-001', 'MP-BJM-001-M', 350, 'ผ้ามัสลิน 100%, ลาย Bear ไซส์ M'),
('PO-2026-001', 'MP-BJM-001-L', 150, 'ผ้ามัสลิน 100%, ลาย Bear ไซส์ L'),
('PO-2026-002', 'MP-KID-012-2Y', 500, 'Kids Pajamas 2Y'),
('PO-2026-002', 'MP-KID-012-4Y', 400, 'Kids Pajamas 4Y'),
('PO-2026-003', 'MP-TEE-005-M', 600, ''),
('PO-2026-003', 'MP-TEE-005-L', 400, ''),
('PO-2026-004', 'MP-WIN-020-S', 300, 'ผ้า Flannel'),
('PO-2026-004', 'MP-WIN-020-M', 500, 'ผ้า Flannel'),
('PO-2026-005', 'MP-BATH-001',  1000, 'Towel Set'),
('PO-2026-006', 'MP-GIFT-050',  800, 'Gift Box set Q2');

INSERT IGNORE INTO receiving_logs (po_number, sku, arrived_date, receive_qty, pass_qc_qty, not_pass_qc_qty, remark_warehouse) VALUES
('PO-2026-003', 'MP-TEE-005-M', DATE_SUB(CURDATE(),INTERVAL 5 DAY), 598, 590, 8,  'กล่องบางใบบุบเล็กน้อย'),
('PO-2026-003', 'MP-TEE-005-L', DATE_SUB(CURDATE(),INTERVAL 5 DAY), 400, 397, 3,  ''),
('PO-2026-005', 'MP-BATH-001',  DATE_SUB(CURDATE(),INTERVAL 20 DAY), 995, 990, 5, 'รับครบ');
