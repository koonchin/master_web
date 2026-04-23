เอกสารนี้รวบรวมแนวทางการปรับปรุงระบบ Shipping Record และ Warehouse Management ทั้งหมด เพื่อแก้ปัญหาการคีย์ข้อมูล การจัดการหน่วยนับ (UOM) การตรวจสอบบิลขนส่ง และการแก้ไขบั๊ก UI

---

## 1. 🔍 ฟีเจอร์การค้นหาและนำเข้าข้อมูล (Search & Input)

### 1.1 การค้นหาหลายรายการพร้อมกัน (Multi-Item Search)
**แนวคิด:** รองรับการค้นหาเลข PO หรือ SKU หลายรายการด้วยการใช้เครื่องหมายจุลภาค (Comma) คั่น
- **Frontend:** ใช้ `.split(',')` และ `.map(s => s.trim())` เพื่อแยกค่าที่กรอกมาเป็น Array
- **Backend:** ปรับ SQL จากเดิม `WHERE po_number LIKE ?` เป็น `WHERE po_number IN (?)`

### 1.2 การกรอกข้อมูลแบบตาราง (Excel-like Grid Input)
**แนวคิด:** ยกเลิกการกดเพิ่มทีละรายการ เปลี่ยนเป็นตารางที่สามารถเพิ่มแถวได้ไม่จำกัด
- **UI:** สร้าง `<table id="poGrid">` ที่มีปุ่ม `+ Add Row`
- **Logic:** รวบรวมข้อมูลทุกแถวเป็น `Array of Objects` แล้วส่งไปบันทึกด้วย Bulk Insert (ครั้งเดียวจบ)
- **Fallback:** หากกรอก SKU ที่ไม่มีใน Item Master ระบบจะ **Default เป็นประเภท "Product" และน้ำหนัก 0.3 kg** ให้อัตโนมัติ

---

## 2. 📏 การจัดการข้อมูลสินค้า (Item Master & Evidence)

### 2.1 บันทึกหลักฐานการวัดขนาด (Measurement Photos)
**แนวคิด:** เพิ่มช่องเก็บรูปถ่ายตอนวัด กว้าง x ยาว x สูง ในหน้า Item Master เพื่อใช้เป็นหลักฐานยืนยันกับบริษัทขนส่ง
- **Action:** เพิ่มคอลัมน์ `measurement_photo_url` ในตารางสินค้า
- **UI:** แสดงรูปภาพอ้างอิงทันทีในหน้ารายละเอียด SKU

### 2.2 หน่วยนับสินค้าและการแสดงผล (UOM UI)
**แนวคิด:** แปลงจำนวนชิ้น (Pcs) เป็นจำนวนลัง (Cartons) ให้ฝ่ายคลังสินค้าทำงานง่ายขึ้น
- **Warehouse View:** หน้าจอรับของต้องโชว์ตัวเลข **"จำนวนลัง"** ตัวใหญ่ๆ (เช่น 10,000 ชิ้น -> **40 ลัง**)
- **Stock Logic:** เมื่อคลังยืนยันรับ 40 ลัง ระบบจะคูณกลับ `40 * 250` เพื่ออัปเดตสต็อกเป็น +10,000 ชิ้น

---

## 3. ⚖️ ระบบขนส่งและการเปรียบเทียบราคา (Logistics & Comparison)

### 3.1 การเลือกบริษัทขนส่ง (Logistics Selection Flow)
**แนวคิด:** ลดความซ้ำซ้อนในการกรอกข้อมูล
- ปรับตารางเปรียบเทียบ 4 เรทราคา (HLT/CTW รถ/เรือ) ให้มีปุ่ม **"เลือกวิธีนี้ (Select)"**
- เมื่อกดเลือก ระบบจะนำชื่อบริษัทและวิธีขนส่งไปกรอกที่หัวบิล (Header) ให้โดยอัตโนมัติ

### 3.2 การเปรียบเทียบสเปคมาตรฐาน vs สเปคขนส่ง (Discrepancy Compare)
**แนวคิด:** ตรวจสอบความถูกต้องของบิลขนส่ง
- สร้างตารางเทียบค่า **Standard (ระบบคำนวณ)** กับ **Billed (ขนส่งเรียกเก็บ)**
- หากส่วนต่าง (Diff) เกินเกณฑ์ที่กำหนด ระบบจะแสดงเครื่องหมายเตือน ⚠️

---

## 4. 📸 ระบบแนบรูปแบบอิสระ (Flexible Evidence Upload)

**แนวคิด:** Warehouse สามารถถ่ายรูป 1 ใบที่รวมสินค้าหลาย SKU ไว้ด้วยกัน แล้วแนบเข้า PO นั้นได้ทันที
- **Database:** สร้างตาราง `po_images` เพื่อเก็บรูปผูกกับเลข PO (แทนการผูกกับ SKU 1:1)
- **UI:** ใช้ `<input type="file" multiple>` เพื่ออัปโหลดรูปภาพหลายใบพร้อมกัน

---

## 5. ✏️ ระบบแก้ไขข้อมูลและแก้บั๊ก (Edit & Bug Fixes)

### 5.1 ระบบแก้ไขข้อมูลหัวบิล (PO Header Edit)
**แนวคิด:** เพิ่มความสามารถในการแก้ไขข้อมูลที่เคยล็อกไว้
- สามารถแก้ไขเลข PO (PO Number), วันที่สั่ง (Order Date), และวันที่ส่งออกจากจีน (Shipping Out Date) ได้

### 5.2 แก้ไขบั๊กปุ่มลบค้าง (Delete Button UI Fix)
**ปัญหา:** พอกดลบแล้วค้างที่คำว่า "กำลังลบ..."
- **วิธีแก้:** เพิ่มโค้ด JavaScript ให้ทำการลบแถวออกจากตาราง (DOM removal) ทันทีที่ API ตอบกลับว่าลบสำเร็จ (Status 200)

---

## 🗄️ ภาคผนวก: คำสั่ง SQL สำหรับปรับปรุง Database

```sql
-- 1. เพิ่มคอลัมน์ใน Item Master สำหรับเก็บรูปวัดสเปค
ALTER TABLE items ADD COLUMN measurement_photo_url VARCHAR(500) DEFAULT NULL;

-- 2. เพิ่มคอลัมน์ใน PO Headers สำหรับเก็บข้อมูลบิลจริง
ALTER TABLE po_headers 
ADD COLUMN actual_billed_weight DECIMAL(10,2) DEFAULT 0,
ADD COLUMN actual_billed_volume DECIMAL(10,4) DEFAULT 0;

-- 3. สร้างตารางเก็บรูปภาพแบบอิสระสำหรับแต่ละ PO
CREATE TABLE IF NOT EXISTS po_images (
  id INT AUTO_INCREMENT PRIMARY KEY,
  po_number VARCHAR(50) NOT NULL,
  photo_url VARCHAR(500) NOT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (po_number) REFERENCES po_headers(po_number) ON DELETE CASCADE
);