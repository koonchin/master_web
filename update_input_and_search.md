# 🛠️ คู่มือการอัปเกรดระบบ UI และฟังก์ชัน Warehouse (Inbound Logistics)

เอกสารนี้ครอบคลุมแนวทางการปรับแก้ฝั่ง Frontend, Backend API และ Database เพื่อรองรับฟีเจอร์ใหม่ 3 ส่วนหลัก ได้แก่: 
1. **Multi-Item Search:** การค้นหา PO หรือ SKU หลายรายการพร้อมกันด้วยเครื่องหมายจุลภาค (Comma)
2. **Excel-like Grid Input:** การคีย์ข้อมูล SKU หลายรายการในรูปแบบตาราง (Dynamic Table)
3. **Flexible Evidence Upload:** การแนบรูปภาพรวมของ PO โดยไม่ยึดติดกับ SKU

---

## 1. 🔍 ระบบค้นหาหลายรายการพร้อมกัน (Multi-Item Search)

**แนวคิด:** เปลี่ยนจากการค้นหาคำเดียว (ที่มักใช้ SQL `LIKE`) เป็นการรับค่าที่มีเครื่องหมายลูกน้ำ `,` นำมาแยกเป็น Array แล้วใช้คำสั่ง SQL `IN (...)` เพื่อหาข้อมูลที่ตรงกับรายการทั้งหมด

### 1.1 การจัดการฝั่ง Frontend (JavaScript)
เมื่อผู้ใช้พิมพ์เช่น `PO001, PO002, PO003` ระบบจะทำการหั่น (Split) ข้อความและตัดช่องว่างออก
```javascript
// ดึงค่าจากช่องค้นหา
const rawSearch = document.getElementById('searchInput').value;

// แปลง " PO1, PO2 , PO3 " -> ["PO1", "PO2", "PO3"]
const searchArray = rawSearch.split(',').map(item => item.trim()).filter(item => item !== '');

// ยิง API ส่งข้อมูลเป็น Array ไปให้ Backend
fetch('/api/po/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: searchArray })
});
1.2 การจัดการฝั่ง Backend & SQL (server.js)
ปรับ API ให้รองรับคำสั่ง IN ของ MySQL

JavaScript
app.post('/api/po/search', async (req, res) => {
    const { keywords } = req.body;
    
    if (!keywords || keywords.length === 0) return res.json([]);

    // สร้างเครื่องหมาย ? ตามจำนวน keyword เช่น (?, ?, ?)
    const placeholders = keywords.map(() => '?').join(','); 

    // ตัวอย่าง: ค้นหาจากเลข PO
    const sql = `SELECT * FROM po_headers WHERE po_number IN (${placeholders})`;
    
    // ใช้ไลบรารี mysql2 หรือ db.js ของคุณ
    db.query(sql, keywords, (err, results) => {
        if (err) throw err;
        res.json(results);
    });
});
2. 📝 การกรอกข้อมูลแบบตาราง (Excel-like Grid Input)
แนวคิด: ยกเลิกฟอร์มแบบช่องเดียว เปลี่ยนเป็นหน้าตารางที่กดปุ่ม "เพิ่มแถว" ได้ และเมื่อกดบันทึก จะส่งข้อมูลทั้งหมดเป็น Array ไป INSERT ทีเดียว (Bulk Insert)

2.1 โครงสร้างหน้าเว็บ (HTML & JS)
HTML
<table id="skuTable" class="table">
    <thead>
        <tr>
            <th>SKU</th>
            <th>จำนวน (Qty)</th>
            <th>หมายเหตุ</th>
        </tr>
    </thead>
    <tbody id="skuBody">
        <tr>
            <td><input type="text" class="form-control sku-input"></td>
            <td><input type="number" class="form-control qty-input"></td>
            <td><input type="text" class="form-control remark-input"></td>
        </tr>
    </tbody>
</table>
<button onclick="addRow()">+ เพิ่มรายการ (Add Row)</button>
<button onclick="savePO()">💾 บันทึก PO</button>

<script>
function addRow() {
    const tbody = document.getElementById('skuBody');
    const newRow = `<tr>
        <td><input type="text" class="form-control sku-input"></td>
        <td><input type="number" class="form-control qty-input"></td>
        <td><input type="text" class="form-control remark-input"></td>
    </tr>`;
    tbody.insertAdjacentHTML('beforeend', newRow);
}

function savePO() {
    const rows = document.querySelectorAll('#skuBody tr');
    const itemsData = [];
    
    rows.forEach(row => {
        itemsData.push({
            sku: row.querySelector('.sku-input').value,
            qty: row.querySelector('.qty-input').value,
            remark: row.querySelector('.remark-input').value
        });
    });

    // ส่ง itemsData (Array) ไปให้ API เพื่อบันทึก
}
</script>
2.2 การบันทึกลง Database (Backend Bulk Insert)
JavaScript
// รับค่า Array จาก Frontend
const poItems = req.body.itemsData; 
const poNumber = req.body.poNumber;

// แปลง Array ของ Object ให้เป็น Array ของ Array เพื่อทำ Bulk Insert ใน MySQL
const values = poItems.map(item => [poNumber, item.sku, item.qty, item.remark]);

const sql = `INSERT INTO po_items (po_number, sku, order_qty, remark_purchase) VALUES ?`;

// สังเกตว่าใช้ nested array [[values]] สำหรับ Bulk Insert
db.query(sql, [values], (err, result) => {
    if (err) throw err;
    res.send("บันทึกสำเร็จ!");
});
3. 📸 การแนบรูปหลักฐานแบบอิสระ (Flexible Evidence Upload)
แนวคิด: ถ่ายรูปสินค้าหลายๆ อย่างรวมกัน 1 รูป แล้วอัปโหลดเข้าสู่ PO นั้นได้เลย (1 PO มีได้หลายรูปภาพ โดยไม่ผูกกับ SKU ใดๆ)

3.1 สร้างตารางใหม่ใน schema.sql
เพิ่มตารางเพื่อเก็บรูปภาพของ PO โดยเฉพาะ

SQL
CREATE TABLE IF NOT EXISTS po_images (
  id INT AUTO_INCREMENT PRIMARY KEY,
  po_number VARCHAR(50) NOT NULL,
  photo_url VARCHAR(500) NOT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (po_number) REFERENCES po_headers(po_number) ON DELETE CASCADE
);
3.2 โครงสร้างหน้าเว็บฝั่ง Warehouse (HTML)
ใช้ attribute multiple ในช่อง input file เพื่อให้ผู้ใช้กดเลือกรูปจากมือถือหรือคอมพิวเตอร์ได้หลายรูปพร้อมกัน

HTML
<div class="upload-section">
    <h4>อัปโหลดรูปภาพหลักฐานการรับสินค้า (รวม)</h4>
    <input type="file" id="poImages" name="poImages" accept="image/*" multiple>
    <button onclick="uploadEvidence()">อัปโหลด</button>
</div>
3.3 Flow การทำงานเมื่อกดอัปโหลด
ฟังก์ชัน uploadEvidence() ใน JS จะอ่านไฟล์ทั้งหมดจาก Input

นำไฟล์ใส่ FormData พร้อมแนบ po_number ส่งไปที่ API เช่น POST /api/upload/evidence

Backend (อาจจะใช้ multer รับไฟล์) ทำการเซฟรูปลงเซิร์ฟเวอร์ หรือ Cloud Storage

Backend ทำการ INSERT ข้อมูล URL ของรูปภาพลงตาราง po_images ตามจำนวนรูปที่ส่งมา

เวลาเปิดดูรายละเอียด PO ระบบก็จะดึงรูปทั้งหมดที่ WHERE po_number = '...' มาเรียงเป็น Gallery ให้ดูได้อย่างง่ายดาย