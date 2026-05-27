// สร้าง admin user — รันครั้งเดียว
// node create_admin.js
const bcrypt = require('bcryptjs');
const mysql  = require('mysql2/promise');
require('dotenv').config();

const USERNAME = 'admin';
const PASSWORD = 'admin1234'; // เปลี่ยนก่อน deploy จริง

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, port: process.env.DB_PORT,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    const hash = await bcrypt.hash(PASSWORD, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, role, factory_id) VALUES (?, ?, ?, NULL)',
      [USERNAME, hash, 'admin']
    );
    console.log(`✅ Admin created — username: ${USERNAME}  password: ${PASSWORD}`);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      console.log('⏭  Admin already exists, skipping.');
    } else {
      console.error('❌', e.message);
    }
  }
  await pool.end();
})();
