# 📦 ระบบจัดการใบสั่งซื้อและการติดตามสินค้า (PO Tracking & Warehouse Management System)

ระบบนี้ถูกออกแบบมาเพื่อเชื่อมโยงการทำงานระหว่างทีมจัดซื้อ (Purchase) และทีมคลังสินค้า (Warehouse) โดยเน้นการติดตามสถานะสินค้าจากต่างประเทศ (จีน-ไทย) และเตรียมพร้อมสำหรับการเชื่อมต่อกับระบบ Master SKU ในอนาคต

---

## 🛠 1. โครงสร้างฐานข้อมูล (Database Schema - MySQL)

เพื่อให้ระบบรองรับการ Track ข้อมูลได้แม่นยำและเก็บประวัติได้ครบถ้วน แนะนำให้แบ่ง Table ดังนี้:

### A. Table: `po_headers` (ข้อมูลหลักของ PO)
| Field | Type | Description |
| :--- | :--- | :--- |
| `po_id` (PK) | INT (AI) | รหัสภายในระบบ |
| `po_number` (Unique) | VARCHAR | เลขที่ใบสั่งซื้อ (ห้ามซ้ำ) |
| `project_name` | VARCHAR | ชื่อโปรเจกต์ที่สั่งของ |
| `order_date` | DATE | วันที่ออกใบสั่งซื้อ |
| `status` | ENUM | สถานะ (Draft, Ordered, Shipped_CN, Thai_Customs, Arrived, Completed) |
| `departure_date` | DATE | วันที่ของออกจากจีน |
| `est_lead_time` | INT | ระยะเวลาขนส่งที่คาดการณ์ (จำนวนวัน) |
| `created_at` | TIMESTAMP | วันที่สร้าง Record |

### B. Table: `po_items` (รายการสินค้าใน PO)
| Field | Type | Description |
| :--- | :--- | :--- |
| `item_id` (PK) | INT (AI) | รหัสรายการ |
| `po_number` (FK) | VARCHAR | เชื่อมกับ po_headers |
| `sku` | VARCHAR | รหัสสินค้า (ในเฟสหน้าจะเชื่อมกับ Master SKU Table) |
| `order_qty` | INT | จำนวนที่สั่งซื้อ |
| `remark_purchase` | TEXT | หมายเหตุจากทีมจัดซื้อ |

### C. Table: `receiving_logs` (ข้อมูลการรับสินค้าและ QC)
| Field | Type | Description |
| :--- | :--- | :--- |
| `log_id` (PK) | INT (AI) | รหัสการรับของ |
| `po_number` (FK) | VARCHAR | เชื่อมกับ po_headers |
| `sku` | VARCHAR | รหัสสินค้าที่รับเข้า |
| `arrived_date` | DATE | วันที่ของมาถึงคลัง |
| `receive_qty` | INT | จำนวนที่นับได้จริง |
| `pass_qc_qty` | INT | จำนวนที่ผ่าน QC |
| `not_pass_qc_qty` | INT | จำนวนที่ไม่ผ่าน QC |
| `photo_url` | VARCHAR | ลิงก์เก็บรูปภาพหลักฐาน (S3/Cloud Storage) |
| `remark_warehouse` | TEXT | หมายเหตุจากทีมคลัง |

---

## 💻 2. ฟังก์ชันการทำงานแบ่งตามทีม (User Roles)

### 🧑‍💻 ทีมจัดซื้อ (Purchase Team)
1. **Input PO (Draft):** กรอกข้อมูล PO Number, SKU, จำนวนสั่ง, โปรเจกต์
2. **Logistics Update:** เมื่อของออกจากจีน ให้เปลี่ยนสถานะเป็น `Shipped from China` และระบุ `Departure Date`
3. **Tracking View:** ดูได้ว่าแต่ละ SKU ที่สั่งไป ตอนนี้สถานะอยู่ที่ไหน

### 👷‍♂️ ทีมคลังสินค้า (Warehouse Team)
1. **Search & Receive:** ค้นหา PO Number เมื่อของมาถึง
2. **Update Incoming:** กรอก `Arrived Date`, `Receive QTY`
3. **QC Process:** กรอกจำนวน `Pass QC` และ `Not Pass QC`
4. **Photo Evidence:** อัปโหลดรูปภาพสินค้า (สภาพกล่อง หรือ สินค้าที่เสีย)
5. **Auto Calculation:** ระบบคำนวณ `Check Diff` ทันที (`Order QTY` vs `Receive QTY`)

---

## 📊 3. ระบบ Dashboard & Tracking (Visual Analytics)

Dashboard จะช่วยให้ผู้บริหารเห็นภาพรวมของ Supply Chain ทั้งหมด:

### 📍 ส่วนแสดงสถานะสินค้า (Tracking Cards)
- **Status: Shipped from China:** แสดงจำนวน PO ที่อยู่ระหว่างทาง
- **Status: Thai Customs:** แสดงจำนวน PO ที่อยู่ที่ด่านไทย
- **Status: Overdue/Delay:** แสดง PO ที่เลยกำหนดส่ง (Current Date > Est. Arrival Date)

### 📍 ส่วนคำนวณ Lead Time (Prediction Logic)
- **Estimated Arrival Date (ETA):** ระบบจะคำนวณให้ `Departure Date + Lead Time = ETA`
- **Delay Alert:** หากสถานะยังไม่เป็น "Arrived" แต่เลยวัน ETA ระบบจะขึ้นแถบ **สีแดง** แจ้งเตือนใน Dashboard
- **Drill-down:** สามารถกดคลิกที่ตัวเลขบน Dashboard เพื่อดูรายละเอียดว่ามี PO ไหนบ้าง และ SKU อะไรบ้างที่ติดปัญหา

---

## 🚀 4. แนะนำภาษาและเทคโนโลยี (Tech Stack)

เพื่อให้ระบบรองรับ MySQL และการอัปโหลดรูปภาพได้อย่างมีประสิทธิภาพ แนะนำ 2 แนวทาง:

### Option A: เน้นระบบจัดการที่ทรงพลัง (แนะนำที่สุด)
* **Backend:** **PHP (Laravel Framework)** - มีระบบจัดการฐานข้อมูล (Eloquent ORM) ที่เก่งมาก และมี Library จัดการรูปภาพที่ง่าย
* **Frontend:** **Vue.js หรือ Blade Template** (มากับ Laravel) - ทำ UI Dashboard ได้สวยและรวดเร็ว
* **Database:** **MySQL**

### Option B: เน้นความทันสมัยและ Scalability
* **Backend:** **Node.js (Express.js)** - ทำงานเร็ว แบบ Non-blocking เหมาะกับระบบที่มีการแจ้งเตือนบ่อยๆ
* **Frontend:** **React.js** - เหมาะสำหรับการทำ Dashboard ที่มีความซับซ้อนสูง
* **Database:** **MySQL**

### 🖼️ การจัดการรูปภาพ (Image Storage)
* ไม่แนะนำให้เก็บรูปใน Database โดยตรง
* **วิธีที่ถูก:** อัปโหลดไฟล์ไปที่ Folder `/uploads/` บน Server หรือใช้ **Cloud Storage (เช่น Amazon S3 / Google Cloud)** แล้วเก็บเฉพาะ **"URL ของรูป"** ลงใน MySQL

---

## 🔮 5. แผนการต่อยอด (Future Roadmap: Master SKU)

เมื่อระบบ PO นิ่งแล้ว ขั้นตอนต่อไปคือ:
1.  **Create Master SKU Table:** สร้างตารางรวมข้อมูลสินค้าทั้งหมด (ชื่อไทย/อังกฤษ, ขนาด, น้ำหนัก, รูปภาพสินค้ามาตรฐาน, ขั้นต่ำที่ต้องสั่ง)
2.  **Mapping:** เปลี่ยนจากช่องกรอก SKU (Text) ในหน้าจัดซื้อ ให้เป็น Dropdown ที่ดึงข้อมูลจาก Master SKU
3.  **Inventory Tracking:** เมื่อ Warehouse กดรับของ ระบบจะไปบวกสต็อกใน Master SKU ให้อัตโนมัติ ทำให้รู้จำนวนสินค้าคงเหลือแบบ Real-time