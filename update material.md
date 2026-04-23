# 📦 คู่มือการอัปเกรดระบบ Shipping Record & UOM (Inbound Logistics)

เอกสารนี้รวบรวม Flow การทำงาน, โครงสร้าง Database, และการปรับแก้ API / Frontend เพื่อรองรับระบบขนส่งฝั่งขาเข้าแบบใหม่ที่มีการแยกประเภทสินค้า (Product/Material), การคำนวณ UOM (Unit of Measure) และการจัดการสิทธิ์การเข้าถึงข้อมูล

---

## 1. 🗄️ การปรับปรุงฐานข้อมูล (Database Schema)

เราจะรวมสินค้าและแพ็คเกจไว้ในตารางเดียว (หรือแยกก็ได้ แต่รวมจะจัดการง่ายกว่า) โดยเพิ่ม `item_type` เพื่อแยกตรรกะการคำนวณ

### 1.1 ตาราง `Item_Master` (ข้อมูลมาตรฐานสินค้าและวัสดุ)
```sql
CREATE TABLE Item_Master (
    item_id VARCHAR(50) PRIMARY KEY,
    item_name VARCHAR(100) NOT NULL,
    item_type ENUM('Product', 'Material', 'Others') DEFAULT 'Others',
    
    -- สำหรับ Material (ใช้เปรียบเทียบราคาและจัดการคลัง)
    qty_per_carton INT DEFAULT 1,         -- จำนวนชิ้นต่อ 1 ลัง (UOM)
    carton_width DECIMAL(10,2) DEFAULT 0, -- ความกว้างต่อลัง (cm)
    carton_length DECIMAL(10,2) DEFAULT 0,-- ความยาวต่อลัง (cm)
    carton_height DECIMAL(10,2) DEFAULT 0,-- ความสูงต่อลัง (cm)
    carton_weight DECIMAL(10,2) DEFAULT 0,-- น้ำหนักต่อลัง (kg)
    carton_volume DECIMAL(10,4) DEFAULT 0,-- ปริมาตรต่อลัง (CBM)
    
    -- สำหรับ Product (ประมาณการณ์น้ำหนัก)
    default_weight_per_pc DECIMAL(10,2) DEFAULT 0.3 -- ค่าเริ่มต้น 300g (0.3kg) ต่อ 1 ชิ้น
);
1.2 ตาราง Logistics_Rates (ตารางเรทขนส่ง อิงจาก Sheet 2, 4)
SQL
CREATE TABLE Logistics_Rates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_name VARCHAR(50),      -- e.g., HLT, CTW
    shipping_method VARCHAR(50),   -- e.g., Truck, Ship, EK
    charge_type ENUM('Weight', 'Volume'),
    rate_price DECIMAL(10,2)       -- e.g., 15, 18, 4000, 6500
);
1.3 ตาราง PO_Inbound (ตารางข้อมูลรับเข้า)
SQL
CREATE TABLE PO_Inbound (
    po_number VARCHAR(50) PRIMARY KEY,
    item_id VARCHAR(50),
    order_qty INT NOT NULL,                  -- จำนวนชิ้นที่สั่ง (Base Unit) เช่น 10,000
    shipping_cartons INT DEFAULT 0,          -- จำนวนลังที่ใช้ส่ง (Shipping Unit) เช่น 40
    estimated_weight DECIMAL(10,2) DEFAULT 0,
    estimated_volume DECIMAL(10,4) DEFAULT 0,
    selected_logistics VARCHAR(100),         -- บริษัท/วิธี ที่เลือกใช้
    shipping_cost DECIMAL(10,2),             -- ค่าส่งที่คำนวณได้
    status VARCHAR(50) DEFAULT 'Pending'
);
2. 🔄 Flow การทำงาน (Business Logic)
Flow 2.1: ฝั่งจัดซื้อ / Admin (ขาคีย์ข้อมูลและเปรียบเทียบราคา)
เลือกสินค้า: Admin คีย์รายการสั่งซื้อ (ระบุจำนวนชิ้น เช่น 10,000 ชิ้น)

ตรวจสอบประเภท (Item Type):

ถ้าเป็น Product:

ใช้สูตรประมาณการณ์: น้ำหนักรวม = จำนวนชิ้น * default_weight_per_pc (เช่น 10,000 * 0.3kg = 3,000kg)

ไม่ต้องเปรียบเทียบราคาขนส่ง (Compare) เพราะน้ำหนัก/ปริมาตรจริงมักจะไม่คงที่ ให้บันทึกเป็นแค่ Estimate

ถ้าเป็น Material:

ระบบคำนวณจำนวนลัง (UOM): จำนวนลัง = Math.ceil(จำนวนชิ้น / qty_per_carton) (เช่น 10,000 / 250 = 40 ลัง)

คำนวณ CBM รวม: จำนวนลัง * carton_volume

คำนวณน้ำหนักรวม: จำนวนลัง * carton_weight

ดึงข้อมูลตาราง Logistics_Rates มาแสดงเปรียบเทียบราคา (เช่น HLT เรือ vs CTW รถ)

บันทึก: กด Save ลงตาราง PO_Inbound (บันทึกทั้ง Qty 10,000 และ Cartons 40)

Flow 2.2: ฝั่ง Warehouse (ขารับของเข้าคลัง)
หน้าจอ (UI): แสดงเฉพาะข้อมูลที่จำเป็นต่อการรับของ ห้ามโชว์ราคาขนส่ง หรือขนาดเป๊ะๆ

การตรวจนับ:

ถ้าเป็น Material: โชว์จำนวนลังให้คลังนับ (เช่น 📦 กล่องสีฟ้า: รับ 40 ลัง) มี Sub-text เล็กๆ ว่ารวม 10,000 ชิ้น

ถ้าเป็น Product: โชว์จำนวนชิ้น หรือกระสอบตามปกติ

การเข้าสต็อก (Stock Update): เมื่อ Warehouse กดรับของครบ 40 ลัง ระบบ Backend จะเอา 40 ลัง * qty_per_carton (250) แล้วไปอัปเดตตาราง Stock = +10,000 ชิ้น

3. 🌐 การแก้โค้ดฝั่งเว็บ (Backend & Frontend)
3.1 การแก้ Backend (Node.js / Express API)
เพิ่ม API ใหม่อย่างน้อย 3 ตัวใน server.js:

GET /api/items/:id/spec

ดึงข้อมูล Item มาเพื่อเตรียมคำนวณในหน้า Frontend (ส่ง type, weight, qty_per_carton กลับไป)

POST /api/logistics/compare

รับค่า weight และ volume ยิงเข้ามาเพื่อเทียบราคา ส่ง Result กลับไปเป็น Array:
[{ company: 'HLT', method: 'Ship', cost: 4500 }, { company: 'CTW', method: 'Truck', cost: 5200 }]

GET /api/po/list

สำคัญ: API ตัวนี้ที่ใช้แสดงผลหน้า Dashboard และหน้า Warehouse ต้อง SELECT แค่ข้อมูลพื้นฐาน (ห้ามส่ง shipping_cost, estimated_weight ออกไปเด็ดขาด)

GET /api/po/:id/details

API ตัวนี้ใช้สำหรับ Admin กดดูรายละเอียดเชิงลึกเท่านั้น ถึงจะ SELECT ค่าขนส่งทั้งหมดส่งไปให้

3.2 การแก้ Frontend (HTML / JS)
ซ่อนข้อมูล: ใน index.html หน้า Dashboard และ Warehouse ให้ลบคอลัมน์ น้ำหนัก, ขนาด, เรทค่าส่ง ออก

หน้าต่าง Detail (Modal):

สร้าง Modal หรือหน้าต่างขยาย เมื่อ Admin กดคลิกที่รายการ PO ระบบจะยิง API GET /api/po/:id/details

เช็คสิทธิ์ด้วย JavaScript:

JavaScript
// สมมติว่า userRole ได้มาจากตอน Login
if (userRole === 'admin' || userRole === 'purchasing') {
    document.getElementById('logistics-cost-section').classList.remove('d-none');
    renderLogisticsDetails(poData);
} else if (userRole === 'warehouse') {
    document.getElementById('logistics-cost-section').classList.add('d-none');
    // โชว์แค่จำนวนลัง (Shipping Cartons)
    renderWarehouseReceivingUI(poData);
}
4. 🚀 สรุปข้อดีของโครงสร้างนี้
ลดภาระคลังสินค้า: Warehouse นับของง่ายขึ้น เพราะระบบสั่งให้ตรวจนับเป็น "ลัง" ตามหน้างานจริง แต่สต็อกในระบบตัดเป็น "ชิ้น" ได้อย่างถูกต้องแม่นยำ

คำนวณต้นทุนแม่นยำ: ฝ่ายจัดซื้อได้เห็นค่าส่งทันทีที่สั่ง Material ทำให้ตัดสินใจเลือกขนส่งได้ฉลาดขึ้น

ความปลอดภัยของข้อมูล (Data Privacy): ข้อมูลเรทราคาจาก Sheet 2 และ 4 จะไม่รั่วไหลไปยังฝั่งคลังหรือคนที่ไม่มีสิทธิ์

ยืดหยุ่นสูง: หาก Product ต้องแพ็คลงกล่องในอนาคต ก็แค่ไปแก้ item_type เป็น Material ใน Database แล้วใส่ขนาดลังเข้าไป ระบบก็จะคำนวณ UOM ให้อัตโนมัติทันที