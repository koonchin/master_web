// ============================================================
// PO Tracking & Warehouse Management System
// API-backed version (Node.js + MySQL)
// ============================================================

// const API_BASE = 'http://localhost:3000/api';
const API_BASE = '/api';

// --- State ---
let currentRole = 'purchase';
let currentView = 'dashboard';
let editingPO = null;    // full PO object with items + logs
let receivingPO = null;
let dashFilter = { dateField: 'order_date', year: '', month: '', logistics_company: '', shipping_method: '' };
let _itemMasterList = [];   // cache for Item_Master
let _logisticsRates = [];   // cache for Logistics_Rates

// --- API Layer ---
const API = {
  async get(path) {
    const res = await fetch(API_BASE + path);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(API_BASE + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
  async del(path) {
    const res = await fetch(API_BASE + path, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
  async uploadPhotos(files) {
    const form = new FormData();
    files.forEach(f => form.append('photos', f));
    const res = await fetch(API_BASE + '/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json(); // { urls: [...] }
  },
  async uploadPOImages(poNumber, files) {
    const form = new FormData();
    files.forEach(f => form.append('photos', f));
    const res = await fetch(API_BASE + `/po/${poNumber}/images`, { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json(); // { urls, images }
  },
  async deletePOImage(id) {
    return this.del(`/po-images/${id}`);
  },
};

// --- Helpers ---
function parseDate(s) { return s ? new Date(s.substring(0, 10) + 'T00:00:00') : null; }
function formatDate(s) {
  if (!s) return '-';
  const d = parseDate(s);
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' });
}
function today() { return new Date().toISOString().split('T')[0]; }
function addDays(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr.substring(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}
function daysDiff(from, to) {
  const f = parseDate(from), t = parseDate(to);
  if (!f || !t) return null;
  return Math.round((t - f) / 86400000);
}
function getETA(po) { return po.departure_date ? addDays(po.departure_date, po.est_lead_time) : null; }
function isOverdue(po) {
  if (['Arrived', 'Completed'].includes(po.status)) return false;
  const eta = getETA(po); if (!eta) return false;
  return eta < today();
}
function etaProgress(po) {
  if (!po.departure_date || !po.est_lead_time) return 0;
  const elapsed = daysDiff(po.departure_date, today());
  return Math.min(100, Math.max(0, Math.round((elapsed / po.est_lead_time) * 100)));
}

const STATUS_FLOW = ['Draft', 'Ordered', 'Shipped_CN', 'Thai_Customs', 'Arrived', 'Completed'];
const STATUS_LABELS = { Draft: 'Draft', Ordered: 'Ordered', Shipped_CN: 'Shipped (CN)', Thai_Customs: 'Thai Customs', Arrived: 'Arrived', Completed: 'Completed' };
const STATUS_ICONS = { Draft: '📝', Ordered: '📋', Shipped_CN: '🚢', Thai_Customs: '🛃', Arrived: '📦', Completed: '✅' };
const STATUS_BADGE_CLASS = { Draft: 'badge-draft', Ordered: 'badge-ordered', Shipped_CN: 'badge-shipped', Thai_Customs: 'badge-customs', Arrived: 'badge-arrived', Completed: 'badge-completed' };

function statusBadge(status, overdue = false) {
  if (overdue) return `<span class="badge badge-overdue">⚠ Overdue</span>`;
  return `<span class="badge ${STATUS_BADGE_CLASS[status] || 'badge-draft'}">${STATUS_LABELS[status] || status}</span>`;
}
function diffChip(order, receive) {
  if (receive === null || receive === undefined) return '<span class="text-muted">-</span>';
  const d = receive - order;
  if (d === 0) return `<span class="diff-chip diff-ok">✓ ตรง</span>`;
  if (d > 0)   return `<span class="diff-chip diff-over">+${d} เกิน</span>`;
  return `<span class="diff-chip diff-short">${d} ขาด</span>`;
}

// Whether QC was actually recorded (pass+notPass > 0 means filled)
function qcDone(log) {
  return log && (log.pass_qc_qty > 0 || log.not_pass_qc_qty > 0);
}

// --- Loading ---
function showLoading(body) {
  body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:300px;gap:12px;color:#5a6e72">
    <div style="width:32px;height:32px;border:3px solid rgba(33,55,60,.12);border-top-color:#8FACD7;border-radius:50%;animation:spin .6s linear infinite"></div>
    <span style="font-size:16px">กำลังโหลดข้อมูล...</span>
  </div>`;
}
const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
document.head.appendChild(spinStyle);

// --- Toast ---
function toast(msg, type = 'success') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.animation = 'slideOut .2s ease forwards'; setTimeout(() => el.remove(), 200); }, 3500);
}

// --- Modal ---
function showModal(id) { document.getElementById(id).style.display = 'flex'; }
function hideModal(id) { document.getElementById(id).style.display = 'none'; }

// ============================================================
// ROUTING
// ============================================================
function navigate(view, data = null) {
  if (data) {
    if (view === 'po-detail') editingPO = data;
    if (view === 'wh-receive') receivingPO = data;
  }
  currentView = view;
  // Desktop sidebar highlight
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.querySelector(`[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');
  // Mobile nav highlight
  updateMobileNavActive();
  renderView(view);
}

async function renderView(view) {
  const body = document.getElementById('page-body');
  const topbar = document.getElementById('topbar-inner'); // hamburger stays outside
  showLoading(body);
  try {
    switch (view) {
      case 'dashboard':  await renderDashboard(body, topbar); break;
      case 'po-list':    await renderPOList(body, topbar); break;
      case 'create-po':  await renderCreatePO(body, topbar); break;
      case 'po-detail':  await renderPODetail(body, topbar); break;
      case 'wh-search':       await renderWHSearch(body, topbar); break;
      case 'wh-receive':      await renderWHReceive(body, topbar); break;
      case 'item-master':     await renderItemMaster(body, topbar); break;
      case 'logistics-rates': await renderLogisticsRates(body, topbar); break;
      default:                await renderDashboard(body, topbar);
    }
  } catch (err) {
    body.innerHTML = `<div class="alert alert-red" style="margin:20px"><span class="alert-icon">❌</span><div class="alert-body"><div class="alert-title">เกิดข้อผิดพลาด</div><p>${err.message}</p></div></div>`;
  }
  updateNavBadges();
}

async function updateNavBadges() {
  try {
    const headers = await API.get('/po');
    const overdueCount = headers.filter(p => isOverdue(p)).length;
    // Desktop badge
    const badge = document.getElementById('overdue-badge');
    if (badge) { badge.textContent = overdueCount; badge.style.display = overdueCount > 0 ? 'inline' : 'none'; }
    // Mobile badge
    const mnBadge = document.getElementById('mn-overdue-badge');
    if (mnBadge) { mnBadge.textContent = overdueCount; mnBadge.style.display = overdueCount > 0 ? 'inline' : 'none'; }
  } catch {}
}

// ============================================================
// DASHBOARD
// ============================================================
function dashFilterChanged() {
  dashFilter.dateField         = document.getElementById('dash-datefield')?.value || 'order_date';
  dashFilter.year              = document.getElementById('dash-year')?.value      || '';
  dashFilter.month             = document.getElementById('dash-month')?.value     || '';
  dashFilter.logistics_company = document.getElementById('dash-logistics')?.value || '';
  dashFilter.shipping_method   = document.getElementById('dash-method')?.value    || '';
  renderView('dashboard');
}
function clearDashFilter() {
  dashFilter = { dateField: 'order_date', year: '', month: '', logistics_company: '', shipping_method: '' };
  renderView('dashboard');
}
function exportDashboard() {
  const p = new URLSearchParams();
  p.set('date_field', dashFilter.dateField || 'order_date');
  if (dashFilter.year)              p.set('year',              dashFilter.year);
  if (dashFilter.month)             p.set('month',             dashFilter.month);
  if (dashFilter.logistics_company) p.set('logistics_company', dashFilter.logistics_company);
  if (dashFilter.shipping_method)   p.set('shipping_method',   dashFilter.shipping_method);
  window.location.href = `${API_BASE}/export?${p.toString()}`;
}

// Get the date to filter on per-PO depending on dateField setting
function getFilterDate(po) {
  if (dashFilter.dateField === 'departure_date') return po.departure_date || null;
  if (dashFilter.dateField === 'eta')            return getETA(po);
  return po.order_date || null;  // default: order_date
}

async function renderDashboard(body, topbar) {
  topbar.innerHTML = `
    <div class="topbar-left"><h2>📊 Dashboard</h2><p>ภาพรวม Supply Chain — วันที่ ${formatDate(today())}</p></div>
    <div class="topbar-right"><button class="btn-primary" onclick="navigate('create-po')">＋ สร้าง PO ใหม่</button></div>`;

  const headers = await API.get('/po');

  // Build year options
  const curYear = new Date().getFullYear();
  const yearOpts = ['', curYear, curYear - 1, curYear - 2].map(y =>
    `<option value="${y}" ${dashFilter.year == y ? 'selected' : ''}>${y || 'ทุกปี'}</option>`
  ).join('');
  const monthNames = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const monthOpts = ['<option value="">ทุกเดือน</option>',
    ...Array.from({length:12}, (_,i) => `<option value="${i+1}" ${dashFilter.month == i+1 ? 'selected' : ''}>${i+1} — ${monthNames[i]}</option>`)
  ].join('');

  const dateFieldOpts = [
    { v: 'order_date',     l: '📋 วันที่สั่ง (Order Date)' },
    { v: 'departure_date', l: '✈️ วันส่งออก (Departure)' },
    { v: 'eta',            l: '📦 วันถึง (ETA)' },
  ].map(o => `<option value="${o.v}" ${dashFilter.dateField === o.v ? 'selected' : ''}>${o.l}</option>`).join('');

  const hasFilter = dashFilter.year || dashFilter.month || dashFilter.logistics_company || dashFilter.shipping_method;
  const filterBar = `
    <div class="card" style="padding:14px 20px;margin-bottom:20px">
      <div class="filter-row" style="flex-wrap:wrap;gap:10px;align-items:center">
        <span style="font-size:13px;font-weight:600;color:#374151">🔽 ตัวกรอง</span>
        <select class="form-control" style="width:210px" id="dash-datefield" onchange="dashFilterChanged()">${dateFieldOpts}</select>
        <select class="form-control" style="width:110px" id="dash-year" onchange="dashFilterChanged()">${yearOpts}</select>
        <select class="form-control" style="width:155px" id="dash-month" onchange="dashFilterChanged()">${monthOpts}</select>
        <select class="form-control" style="width:155px" id="dash-logistics" onchange="dashFilterChanged()">
          <option value="" ${!dashFilter.logistics_company ? 'selected' : ''}>ทุกบริษัทขนส่ง</option>
          <option value="HLT" ${dashFilter.logistics_company === 'HLT' ? 'selected' : ''}>HLT</option>
          <option value="CTW" ${dashFilter.logistics_company === 'CTW' ? 'selected' : ''}>CTW</option>
        </select>
        <select class="form-control" style="width:150px" id="dash-method" onchange="dashFilterChanged()">
          <option value="" ${!dashFilter.shipping_method ? 'selected' : ''}>ทุกวิธีขนส่ง</option>
          <option value="รถ" ${dashFilter.shipping_method === 'รถ' ? 'selected' : ''}>🚛 รถ</option>
          <option value="เรือ" ${dashFilter.shipping_method === 'เรือ' ? 'selected' : ''}>🚢 เรือ</option>
        </select>
        <div style="margin-left:auto;display:flex;gap:8px">
          ${hasFilter ? `<button class="btn-secondary" style="color:#ef4444;border-color:#fca5a5" onclick="clearDashFilter()">✕ ล้าง</button>` : ''}
          <button class="btn-secondary" onclick="exportDashboard()">📥 Export CSV</button>
        </div>
      </div>
    </div>`;

  // Apply filters to headers
  let filtered = [...headers];
  if (dashFilter.year || dashFilter.month) {
    const m = dashFilter.month ? String(dashFilter.month).padStart(2, '0') : '';
    filtered = filtered.filter(p => {
      const d = getFilterDate(p);
      if (!d) return false;
      if (dashFilter.year  && !d.startsWith(dashFilter.year))         return false;
      if (dashFilter.month && d.substring(5, 7) !== m)                 return false;
      return true;
    });
  }
  if (dashFilter.logistics_company) filtered = filtered.filter(p => p.logistics_company === dashFilter.logistics_company);
  if (dashFilter.shipping_method)   filtered = filtered.filter(p => p.shipping_method   === dashFilter.shipping_method);

  const totalPO    = filtered.length;
  const shippedCN  = filtered.filter(p => p.status === 'Shipped_CN').length;
  const customs    = filtered.filter(p => p.status === 'Thai_Customs').length;
  const overdueList= filtered.filter(p => isOverdue(p));
  const arrived    = filtered.filter(p => p.status === 'Arrived').length;
  const completed  = filtered.filter(p => p.status === 'Completed').length;

  const filterLabel = hasFilter ? ` <span style="font-size:12px;color:#64748b;font-weight:400">(ตัวกรองใช้งานอยู่)</span>` : '';

  let overdueAlert = '';
  if (overdueList.length) {
    const names = overdueList.map(p => `<strong>${p.po_number}</strong>`).join(', ');
    overdueAlert = `<div class="alert alert-red">
      <span class="alert-icon">🚨</span>
      <div class="alert-body"><div class="alert-title">พบ ${overdueList.length} PO ที่เลยกำหนดส่ง!</div><p>${names}</p></div>
      <button class="btn-danger btn-sm" style="margin-left:auto;white-space:nowrap" onclick="filterAndShowOverdue()">ดูรายละเอียด</button>
    </div>`;
  }

  const activePOs = filtered
    .filter(p => p.status !== 'Completed')
    .sort((a, b) => (isOverdue(b) ? 1 : 0) - (isOverdue(a) ? 1 : 0));

  const poRows = activePOs.length ? activePOs.map(po => {
    const eta = getETA(po); const overdue = isOverdue(po); const progress = etaProgress(po);
    const logBadge = po.logistics_company ? `<span style="font-size:11px;color:#64748b;margin-left:6px">${po.logistics_company}${po.shipping_method === 'รถ' ? ' 🚛' : po.shipping_method === 'เรือ' ? ' 🚢' : ''}</span>` : '';
    const discBadge = (po.discrepancy_count > 0 && !po.discrepancy_ack)
      ? `<span title="มีความคลาดเคลื่อน ${po.discrepancy_count} SKU" style="margin-left:6px;display:inline-flex;align-items:center;gap:3px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:2px 7px;border-radius:99px;border:1px solid #fcd34d">⚠ คลาดเคลื่อน</span>` : '';
    return `<tr class="${overdue ? 'overdue-row' : ''}" style="cursor:pointer" onclick="viewPODetail('${po.po_number}')">
      <td><span class="po-number-tag">${po.po_number}</span>${logBadge}${discBadge}</td>
      <td>${po.project_name}</td>
      <td>${statusBadge(po.status, overdue)}</td>
      <td class="td-muted">${formatDate(po.departure_date)}</td>
      <td>${eta ? `<div class="eta-bar"><div class="eta-progress"><div class="eta-progress-fill" style="width:${progress}%;background:${overdue ? '#ef4444' : progress > 80 ? '#f59e0b' : '#8FACD7'}"></div></div><span class="eta-text" style="color:${overdue ? '#dc2626' : ''}">${formatDate(eta)}</span></div>` : '<span class="text-muted">ยังไม่ระบุ</span>'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">📭</div><p>ไม่มี PO ที่กำลังดำเนินการ</p></div></td></tr>`;

  body.innerHTML = `
    ${filterBar}
    ${overdueAlert}
    <div class="stat-grid">
      <div class="stat-card" onclick="filterStatus('')">
        <div class="stat-card-icon" style="background:#eff6ff">📋</div>
        <div class="stat-card-value">${totalPO}</div>
        <div class="stat-card-label">PO ทั้งหมด${filterLabel}</div>
        <div class="stat-card-sub">${completed} เสร็จสมบูรณ์</div>
      </div>
      <div class="stat-card" onclick="filterStatus('Shipped_CN')">
        <div class="stat-card-icon" style="background:#f5f3ff">🚢</div>
        <div class="stat-card-value">${shippedCN}</div>
        <div class="stat-card-label">Shipped from China</div>
        <div class="stat-card-sub">กำลังขนส่ง</div>
      </div>
      <div class="stat-card ${customs > 0 ? 'warning' : ''}" onclick="filterStatus('Thai_Customs')">
        <div class="stat-card-icon" style="background:#fffbeb">🛃</div>
        <div class="stat-card-value">${customs}</div>
        <div class="stat-card-label">Thai Customs</div>
        <div class="stat-card-sub">อยู่ที่ด่านไทย</div>
        ${customs > 0 ? '<span class="trend amber">รอผ่านด่าน</span>' : ''}
      </div>
      <div class="stat-card ${overdueList.length > 0 ? 'overdue' : ''}" onclick="filterAndShowOverdue()">
        <div class="stat-card-icon" style="background:#fff5f5">⚠️</div>
        <div class="stat-card-value" style="color:${overdueList.length ? '#dc2626' : '#21373C'}">${overdueList.length}</div>
        <div class="stat-card-label">Overdue / Delay</div>
        <div class="stat-card-sub">เลยกำหนด ETA</div>
        ${overdueList.length > 0 ? '<span class="trend red">ต้องติดตาม!</span>' : ''}
      </div>
      <div class="stat-card" onclick="filterStatus('Arrived')">
        <div class="stat-card-icon" style="background:#ecfdf5">📦</div>
        <div class="stat-card-value">${arrived}</div>
        <div class="stat-card-label">Arrived (รอ QC)</div>
        <div class="stat-card-sub">ถึงคลังแล้ว</div>
        ${arrived > 0 ? '<span class="trend green">พร้อมรับ</span>' : ''}
      </div>
    </div>
    <div class="card p-0">
      <div class="card-header" style="padding:20px 24px 0">
        <div><div class="card-title">📍 PO ที่กำลังดำเนินการ</div><div class="card-subtitle">คลิกที่ PO เพื่อดูรายละเอียด</div></div>
        <button class="btn-secondary btn-sm" onclick="navigate('po-list')">ดูทั้งหมด →</button>
      </div>
      <div style="margin-top:16px" class="table-wrap">
        <table>
          <thead><tr><th>PO Number</th><th>Project</th><th>Status</th><th>Departure (CN)</th><th>ETA</th></tr></thead>
          <tbody>${poRows}</tbody>
        </table>
      </div>
    </div>`;
}

function filterStatus(status) {
  navigate('po-list');
  setTimeout(() => { const sel = document.getElementById('filter-status'); if (sel) { sel.value = status; applyPOListFilter(); } }, 100);
}
function filterAndShowOverdue() {
  navigate('po-list');
  setTimeout(() => { const sel = document.getElementById('filter-status'); if (sel) { sel.value = '__overdue__'; applyPOListFilter(); } }, 100);
}

// ============================================================
// PO LIST
// ============================================================
let _allPOHeaders = [];

async function renderPOList(body, topbar) {
  topbar.innerHTML = `
    <div class="topbar-left"><h2>📋 รายการ PO ทั้งหมด</h2><p>ติดตามสถานะใบสั่งซื้อทั้งหมด</p></div>
    <div class="topbar-right"><button class="btn-primary" onclick="navigate('create-po')">＋ สร้าง PO ใหม่</button></div>`;

  _allPOHeaders = await API.get('/po');

  body.innerHTML = `
    <div class="card">
      <div class="filter-row">
        <div class="search-bar" style="max-width:400px">
          <span class="icon">🔍</span>
          <input type="text" id="search-po" placeholder="ค้นหา PO, Project, SKU... (คั่นด้วย , เพื่อค้นหาหลายรายการ)" oninput="applyPOListFilter()">
        </div>
        <select class="form-control" id="filter-status" style="width:180px" onchange="applyPOListFilter()">
          <option value="">ทุกสถานะ</option>
          <option value="Draft">Draft</option>
          <option value="Ordered">Ordered</option>
          <option value="Shipped_CN">Shipped (CN)</option>
          <option value="Thai_Customs">Thai Customs</option>
          <option value="Arrived">Arrived</option>
          <option value="Completed">Completed</option>
          <option value="__overdue__">⚠ Overdue เท่านั้น</option>
        </select>
        <span class="text-muted text-sm ml-auto" id="po-count"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>PO Number</th><th>Project Name</th><th>SKU</th><th>วันที่สั่ง</th><th>Status</th><th>ETA</th><th>Lead Time</th><th>จัดการ</th></tr></thead>
          <tbody id="po-list-body"></tbody>
        </table>
      </div>
    </div>`;

  applyPOListFilter();
}

function applyPOListFilter() {
  const rawSearch = document.getElementById('search-po')?.value || '';
  const terms = rawSearch.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const statusFilter = document.getElementById('filter-status')?.value || '';
  let headers = [..._allPOHeaders];

  // Filter by status
  if (statusFilter === '__overdue__') headers = headers.filter(p => isOverdue(p));
  else if (statusFilter) headers = headers.filter(p => p.status === statusFilter);

  // Multi-term search: PO number, project name, OR any SKU
  // A PO matches if ANY search term matches any field
  let matchedSkus = {}; // { po_number: [matched skus] }
  if (terms.length) {
    headers = headers.filter(p => {
      const poNum = p.po_number.toLowerCase();
      const proj  = p.project_name.toLowerCase();
      return terms.some(term => {
        const inHeader = poNum.includes(term) || proj.includes(term);
        const skuHits  = (p.skus || []).filter(s => s.toLowerCase().includes(term));
        if (skuHits.length) {
          matchedSkus[p.po_number] = [...(matchedSkus[p.po_number] || []), ...skuHits];
        }
        return inHeader || skuHits.length > 0;
      });
    });
    // De-duplicate matched SKUs
    Object.keys(matchedSkus).forEach(k => {
      matchedSkus[k] = [...new Set(matchedSkus[k])];
    });
  }

  const countEl = document.getElementById('po-count');
  if (countEl) countEl.textContent = `พบ ${headers.length} รายการ`;

  const tbody = document.getElementById('po-list-body');
  if (!tbody) return;
  if (!headers.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">🔍</div><h3>ไม่พบรายการ</h3><p>ลองค้นหาด้วย PO Number, Project หรือ SKU</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = headers.map(po => {
    const eta = getETA(po); const overdue = isOverdue(po);
    const hitSkus = matchedSkus[po.po_number] || [];

    // SKU tag display: show matched SKUs highlighted, or total count
    let skuCell;
    if (hitSkus.length) {
      const tags = hitSkus.slice(0, 4).map(s => `<span style="background:#fef3c7;color:#92400e;padding:2px 7px;border-radius:6px;font-size:12px;font-weight:600;font-family:monospace">${s}</span>`).join(' ');
      const more = hitSkus.length > 4 ? `<span class="text-muted text-sm">+${hitSkus.length - 4}</span>` : '';
      skuCell = `<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">${tags}${more}</div>`;
    } else {
      skuCell = `<span class="text-muted text-sm">${(po.skus || []).length} SKU</span>`;
    }

    return `<tr class="${overdue ? 'overdue-row' : ''}">
      <td><span class="po-number-tag">${po.po_number}</span></td>
      <td>${po.project_name}</td>
      <td>${skuCell}</td>
      <td class="td-muted">${formatDate(po.order_date)}</td>
      <td>${statusBadge(po.status, overdue)}</td>
      <td>${eta ? `<span style="color:${overdue ? '#dc2626' : ''};font-weight:${overdue ? '700' : '400'}">${formatDate(eta)}</span>` : '<span class="td-muted">-</span>'}</td>
      <td class="td-muted">${po.est_lead_time} วัน</td>
      <td><div class="flex gap-2">
        <button class="btn-secondary btn-sm" onclick="viewPODetail('${po.po_number}')">ดูรายละเอียด</button>
        ${currentRole === 'purchase' ? `
          <button class="btn-primary btn-sm" onclick="openEditStatusModal('${po.po_number}')">อัปเดต</button>
          <button class="btn-danger btn-sm" onclick="openDeletePOModal('${po.po_number}')" title="ลบ PO">🗑</button>
        ` : ''}
      </div></td>
    </tr>`;
  }).join('');
}

// ============================================================
// PO DETAIL
// ============================================================
async function viewPODetail(poNumber) {
  const po = await API.get(`/po/${poNumber}`);
  editingPO = po;
  navigate('po-detail');
}

async function renderPODetail(body, topbar) {
  // editingPO already set (has items + logs)
  let po = editingPO;
  if (!po) { navigate('po-list'); return; }
  // Refresh from API
  po = await API.get(`/po/${po.po_number}`);
  editingPO = po;

  const overdue = isOverdue(po); const eta = getETA(po);
  const items = po.items || []; const logs = po.logs || [];

  // Load PO-level evidence photos
  let poImages = [];
  try { poImages = await API.get(`/po/${po.po_number}/images`); } catch { /* optional */ }

  topbar.innerHTML = `
    <div class="topbar-left"><h2><span class="po-number-tag">${po.po_number}</span></h2><p>${po.project_name}</p></div>
    <div class="topbar-right">
      <button class="btn-secondary" onclick="navigate('po-list')">← กลับ</button>
      ${currentRole === 'purchase' ? `
        <button class="btn-primary" onclick="openEditStatusModal('${po.po_number}')">✏ อัปเดตสถานะ</button>
        <button class="btn-danger" onclick="openDeletePOModal('${po.po_number}')">🗑 ลบ PO</button>
      ` : ''}
      ${currentRole === 'warehouse' ? `<button class="btn-primary" onclick="goReceive('${po.po_number}')">📦 บันทึกการรับสินค้า</button>` : ''}
    </div>`;

  const stepIndex = STATUS_FLOW.indexOf(po.status);
  const stepsHTML = STATUS_FLOW.map((s, i) => {
    const isDone = i < stepIndex; const isCurrent = i === stepIndex;
    return `<div class="status-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}">
      <div class="step-dot">${isDone ? '✓' : STATUS_ICONS[s]}</div>
      <div class="step-label">${STATUS_LABELS[s]}</div>
    </div>`;
  }).join('');

  const isPurchase = currentRole === 'purchase';
  const itemRows = items.map(item => {
    const log = logs.find(l => l.sku === item.sku);
    const hasReceive = log && log.receive_qty > 0;
    const hasQC = qcDone(log);
    const isMaterial = item.item_type === 'Material';

    // SKU cell: for warehouse + material, show carton info prominently
    const skuCell = (!isPurchase && isMaterial && item.shipping_cartons > 0)
      ? `<div class="font-mono" style="font-weight:600">${item.sku}</div>
         <div style="font-size:12px;color:#8FACD7;margin-top:2px">📦 ${item.shipping_cartons.toLocaleString()} ลัง</div>`
      : `<span class="font-mono">${item.sku}</span>`;

    // Purchase-only columns
    const purchaseCols = isPurchase ? `
      <td class="text-right text-sm td-muted">${isMaterial && item.shipping_cartons ? `${item.shipping_cartons} ลัง` : '-'}</td>
      <td class="text-right text-sm td-muted">${item.estimated_weight ? `${item.estimated_weight} kg` : '-'}</td>
      <td class="text-right text-sm" style="color:#059669">${item.shipping_cost ? `฿${(+item.shipping_cost).toLocaleString()}` : '-'}<br><span class="td-muted text-sm">${item.selected_logistics||''}</span></td>` : '';

    // Highlight extra (received outside PO) rows
    const isExtra = item.is_extra == 1;
    return `<tr${isExtra ? ' style="background:rgba(251,191,36,.08)"' : ''}>
      <td>${skuCell}${isExtra ? '<br><span style="font-size:11px;color:#d97706;font-weight:600">⚠ นอก PO</span>' : ''}</td>
      <td class="text-right">${isExtra ? '<span class="text-muted text-sm">ไม่ได้สั่ง</span>' : item.order_qty.toLocaleString()}</td>
      <td class="text-right">${hasReceive ? log.receive_qty.toLocaleString() : '<span class="text-muted">-</span>'}</td>
      <td class="text-right">${hasReceive && !isExtra ? diffChip(item.order_qty, log.receive_qty) : (hasReceive ? '<span class="diff-chip diff-over">เกิน</span>' : '<span class="text-muted">-</span>')}</td>
      <td class="text-right">${hasQC ? `<span style="color:#059669;font-weight:600">${log.pass_qc_qty}</span>` : '<span class="text-muted">รอ QC</span>'}</td>
      <td class="text-right">${hasQC ? (log.not_pass_qc_qty > 0 ? `<span style="color:#dc2626;font-weight:600">${log.not_pass_qc_qty}</span>` : '<span style="color:#059669">0</span>') : '<span class="text-muted">-</span>'}</td>
      <td class="text-sm text-muted">${item.remark_purchase || ''}</td>
      <td class="text-sm text-muted">${log?.remark_warehouse || ''}</td>
      ${purchaseCols}
    </tr>`;
  }).join('');

  const etaBar = eta ? `<div class="eta-bar" style="margin-top:8px"><div class="eta-progress"><div class="eta-progress-fill" style="width:${etaProgress(po)}%;background:${overdue ? '#ef4444' : '#8FACD7'}"></div></div><span class="eta-text">${etaProgress(po)}%</span></div>` : '';

  body.innerHTML = `
    ${overdue ? `<div class="alert alert-red"><span class="alert-icon">🚨</span><div class="alert-body"><div class="alert-title">PO นี้เลยกำหนด ETA แล้ว!</div><p>ETA: ${formatDate(eta)}</p></div></div>` : ''}
    <div class="card">
      <div class="card-header"><div class="card-title">🗺 สถานะการขนส่ง</div>${statusBadge(po.status, overdue)}</div>
      <div class="status-progress">${stepsHTML}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;margin-top:20px;padding-top:20px;border-top:1px solid rgba(33,55,60,.09)">
        <div><label style="font-size:11px;text-transform:uppercase;color:#5a6e72;font-weight:600;display:block;margin-bottom:3px">PO Number</label><span class="po-number-tag">${po.po_number}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#5a6e72;font-weight:600;display:block;margin-bottom:3px">Project</label><span style="font-weight:600">${po.project_name}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#5a6e72;font-weight:600;display:block;margin-bottom:3px">Order Date</label><span>${formatDate(po.order_date)}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#5a6e72;font-weight:600;display:block;margin-bottom:3px">บริษัทขนส่ง</label><span>${po.logistics_company || '<span class="text-muted">-</span>'}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#5a6e72;font-weight:600;display:block;margin-bottom:3px">วิธีขนส่ง</label><span>${po.shipping_method ? (po.shipping_method === 'รถ' ? '🚛 รถ' : '🚢 เรือ') : '<span class="text-muted">-</span>'}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#5a6e72;font-weight:600;display:block;margin-bottom:3px">Departure</label><span>${formatDate(po.departure_date)}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#5a6e72;font-weight:600;display:block;margin-bottom:3px">Lead Time</label><span>${po.est_lead_time} วัน</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#5a6e72;font-weight:600;display:block;margin-bottom:3px">ETA</label><span style="color:${overdue ? '#dc2626' : '#21373C'};font-weight:${overdue ? '700' : '400'}">${formatDate(eta)}</span>${etaBar}</div>
      </div>
    </div>
    <div class="card p-0">
      <div class="card-header" style="padding:20px 24px 16px">
        <div><div class="card-title">📦 รายการสินค้า (${items.length} SKU)</div><div class="card-subtitle">เปรียบเทียบสั่ง vs รับจริง vs QC</div></div>
      </div>
      <div class="table-wrap" style="border:none;border-top:1px solid rgba(33,55,60,.09)">
        <table>
          <thead><tr><th>SKU</th><th style="text-align:right">Order QTY</th><th style="text-align:right">Receive QTY</th><th style="text-align:right">Check Diff</th><th style="text-align:right">Pass QC</th><th style="text-align:right">Not Pass</th><th>หมายเหตุจัดซื้อ</th><th>หมายเหตุคลัง</th>${isPurchase ? '<th style="text-align:right">ลัง</th><th style="text-align:right">น้ำหนัก</th><th style="text-align:right">ค่าขนส่ง</th>' : ''}</tr></thead>
          <tbody>${itemRows || `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📦</div><p>ยังไม่มีรายการสินค้า</p></div></td></tr>`}</tbody>
        </table>
      </div>
    </div>
    ${poImages.length ? `
    <div class="card">
      <div class="card-title mb-4">📸 รูปภาพหลักฐาน (${poImages.length} รูป)</div>
      <div class="photo-preview-grid">${poImages.map(img => `
        <div class="photo-preview-item" style="cursor:zoom-in" onclick="window.open('${img.photo_url}','_blank')" title="${new Date(img.uploaded_at).toLocaleString('th-TH')}">
          <img src="${img.photo_url}">
        </div>`).join('')}
      </div>
    </div>` : ''}
    ${(() => {
      // Discrepancy summary card
      const shortage = items.filter(it => {
        const log = logs.find(l => l.sku === it.sku);
        return !it.is_extra && log && log.receive_qty > 0 && log.receive_qty < it.order_qty;
      });
      const overage = items.filter(it => {
        const log = logs.find(l => l.sku === it.sku);
        return log && log.receive_qty > 0 && (it.is_extra || log.receive_qty > it.order_qty);
      });
      if (!shortage.length && !overage.length) return '';
      const acked = po.discrepancy_ack == 1;
      const shortageRows = shortage.map(it => {
        const log = logs.find(l => l.sku === it.sku);
        const diff = it.order_qty - log.receive_qty;
        return `<tr><td class="font-mono">${it.sku}</td><td class="text-right">${it.order_qty}</td><td class="text-right">${log.receive_qty}</td><td class="text-right"><span style="color:#dc2626;font-weight:700">-${diff} ชิ้น (ขาด)</span></td></tr>`;
      }).join('');
      const overageRows = overage.map(it => {
        const log = logs.find(l => l.sku === it.sku);
        const diff = it.is_extra ? log.receive_qty : log.receive_qty - it.order_qty;
        return `<tr><td class="font-mono">${it.sku}${it.is_extra ? ' <span style="font-size:11px;color:#d97706">(นอก PO)</span>' : ''}</td><td class="text-right">${it.is_extra ? '-' : it.order_qty}</td><td class="text-right">${log.receive_qty}</td><td class="text-right"><span style="color:#7c3aed;font-weight:700">+${diff} ชิ้น (เกิน)</span></td></tr>`;
      }).join('');
      return `
    <div class="card" style="${acked ? 'border-color:rgba(16,185,129,.3)' : 'border-color:rgba(239,68,68,.25)'}">
      <div class="card-header" style="margin-bottom:12px">
        <div>
          <div class="card-title">${acked ? '✅ ความคลาดเคลื่อน — รับรู้แล้ว' : '🚨 ความคลาดเคลื่อนในการรับสินค้า'}</div>
          <div class="card-subtitle">${acked ? 'Claimed / Acknowledged แล้ว ไม่แสดง alert' : `ขาด ${shortage.length} SKU · เกิน/นอก PO ${overage.length} SKU — ควร claim กับ factory`}</div>
        </div>
        ${acked
          ? `<button class="btn-secondary btn-sm" onclick="ackDiscrepancy('${po.po_number}', 0)">↩ ยกเลิกการรับรู้</button>`
          : `<button class="btn-primary btn-sm" onclick="ackDiscrepancy('${po.po_number}', 1)">✅ รับรู้แล้ว / Claim แล้ว</button>`}
      </div>
      ${!acked ? `<div class="alert alert-red" style="margin-bottom:12px"><span class="alert-icon">⚠️</span><div class="alert-body"><div class="alert-title">พบความคลาดเคลื่อน — กด "รับรู้แล้ว" หลัง claim กับ factory เสร็จสิ้น</div></div></div>` : ''}
      <div class="table-wrap" style="border:1px solid rgba(33,55,60,.10);border-radius:10px">
        <table>
          <thead><tr><th>SKU</th><th style="text-align:right">สั่ง</th><th style="text-align:right">รับได้จริง</th><th style="text-align:right">ส่วนต่าง</th></tr></thead>
          <tbody>${shortageRows}${overageRows}</tbody>
        </table>
      </div>
    </div>`;
    })()}
    ${isPurchase ? (() => {
      const sysWeight = items.reduce((s, it) => s + (+it.estimated_weight || 0), 0);
      const sysVolume = items.reduce((s, it) => s + (+it.estimated_volume || 0), 0);
      const billedW   = +(po.actual_billed_weight || 0);
      const billedV   = +(po.actual_billed_volume || 0);
      const diffW     = +(billedW - sysWeight).toFixed(2);
      const diffV     = +(billedV - sysVolume).toFixed(4);
      const pctW      = sysWeight > 0 ? ((diffW / sysWeight) * 100).toFixed(1) : null;
      const pctV      = sysVolume > 0 ? ((diffV / sysVolume) * 100).toFixed(1) : null;
      const warnW     = pctW !== null && Math.abs(+pctW) > 5;
      const warnV     = pctV !== null && Math.abs(+pctV) > 5;
      const hasSystem = sysWeight > 0 || sysVolume > 0;
      const compTable = hasSystem ? `
        <div class="table-wrap" style="margin-top:12px;border:1px solid rgba(33,55,60,.10);border-radius:10px">
          <table>
            <thead><tr><th>ประเภท</th><th style="text-align:right">System (คำนวณ)</th><th style="text-align:right">Billed (ขนส่งเรียก)</th><th style="text-align:right">ส่วนต่าง</th><th style="text-align:right">%</th></tr></thead>
            <tbody>
              <tr>
                <td>🏋 น้ำหนัก (kg)</td>
                <td class="text-right">${sysWeight.toLocaleString()}</td>
                <td class="text-right">${billedW.toLocaleString()}</td>
                <td class="text-right" style="color:${diffW > 0 ? '#dc2626' : diffW < 0 ? '#059669' : '#374151'}">${diffW > 0 ? '+' : ''}${diffW}</td>
                <td class="text-right">${pctW !== null ? `<span style="color:${warnW ? '#dc2626' : '#374151'}">${warnW ? '⚠ ' : ''}${pctW}%</span>` : '-'}</td>
              </tr>
              <tr>
                <td>📐 ปริมาตร (CBM)</td>
                <td class="text-right">${sysVolume}</td>
                <td class="text-right">${billedV}</td>
                <td class="text-right" style="color:${diffV > 0 ? '#dc2626' : diffV < 0 ? '#059669' : '#374151'}">${diffV > 0 ? '+' : ''}${diffV}</td>
                <td class="text-right">${pctV !== null ? `<span style="color:${warnV ? '#dc2626' : '#374151'}">${warnV ? '⚠ ' : ''}${pctV}%</span>` : '-'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        ${(warnW || warnV) ? `<div class="alert alert-amber" style="margin-top:12px"><span class="alert-icon">⚠️</span><div class="alert-body"><div class="alert-title">ส่วนต่างเกิน 5% — ควรตรวจสอบบิลขนส่ง</div></div></div>` : ''}
      ` : '';
      return `
    <div class="card">
      <div class="card-title mb-4">⚖️ ตรวจสอบบิลขนส่ง</div>
      <div class="form-grid form-grid-2" style="max-width:520px">
        <div class="form-group">
          <label>น้ำหนักที่ขนส่งเรียกเก็บ (kg)</label>
          <input class="form-control" type="number" step="0.01" id="billed-weight" value="${billedW || ''}">
        </div>
        <div class="form-group">
          <label>ปริมาตรที่ขนส่งเรียกเก็บ (CBM)</label>
          <input class="form-control" type="number" step="0.0001" id="billed-volume" value="${billedV || ''}">
        </div>
      </div>
      <button class="btn-secondary btn-sm" onclick="saveBilledData('${po.po_number}')" style="margin-bottom:4px">💾 บันทึกค่าบิลจริง</button>
      ${compTable}
    </div>`;
    })() : ''}
    ${currentRole === 'purchase' ? `
    <div class="card">
      <div class="card-header"><div class="card-title">✏ จัดการรายการสินค้า</div><button class="btn-primary btn-sm" onclick="openAddItemModal('${po.po_number}')">＋ เพิ่ม SKU</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>SKU</th><th>Order QTY</th><th>หมายเหตุ</th><th></th></tr></thead>
        <tbody>${items.map(it => `<tr>
          <td class="font-mono">${it.sku}</td>
          <td>${it.order_qty.toLocaleString()}</td>
          <td class="text-muted text-sm">${it.remark_purchase || '-'}</td>
          <td><div class="flex gap-2">
            <button class="btn-secondary btn-sm" onclick="openEditItemModal(${it.item_id},'${it.sku.replace(/'/g,"\\'")}',${it.order_qty},'${(it.remark_purchase||'').replace(/'/g,"\\'")}')">✏ แก้ไข</button>
            <button class="btn-danger btn-sm" onclick="deleteItem(${it.item_id})">ลบ</button>
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}`;
}

// ============================================================
// CREATE PO
// ============================================================
async function renderCreatePO(body, topbar) {
  topbar.innerHTML = `
    <div class="topbar-left"><h2>➕ สร้าง PO ใหม่</h2></div>
    <div class="topbar-right"><button class="btn-secondary" onclick="navigate('po-list')">ยกเลิก</button></div>`;

  const year = new Date().getFullYear();
  const suggestedPN = `PO-${year}-001`;

  // Fetch existing project names for autocomplete datalist
  let projectDatalist = '';
  try {
    const all = _allPOHeaders.length ? _allPOHeaders : await API.get('/po');
    const uniqueProjects = [...new Set(all.map(p => p.project_name).filter(Boolean))].sort();
    projectDatalist = `<datalist id="project-datalist">${uniqueProjects.map(p => `<option value="${p.replace(/"/g,'&quot;')}">`).join('')}</datalist>`;
  } catch { /* autocomplete is optional */ }

  // Fetch Item Master for SKU autocomplete
  try { _itemMasterList = await API.get('/item-master'); } catch { _itemMasterList = []; }

  body.innerHTML = `
    <div class="card">
      <div class="card-title mb-4">📋 ข้อมูล PO หลัก</div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label>PO Number <span style="color:#ef4444">*</span></label>
          <input class="form-control" id="f-po-number" value="${suggestedPN}" placeholder="PO-2026-001">
        </div>
        <div class="form-group">
          <label>Project Name <span style="color:#ef4444">*</span></label>
          <input class="form-control" id="f-project" placeholder="เช่น Muslin Pajamas Summer 2026" list="project-datalist" autocomplete="off">
          ${projectDatalist}
        </div>
        <div class="form-group">
          <label>Order Date</label>
          <input class="form-control" id="f-order-date" type="date" value="${today()}">
        </div>
        <div class="form-group">
          <label>บริษัทขนส่ง</label>
          <select class="form-control" id="f-logistics-company">
            <option value="">-- ไม่ระบุ --</option>
            <option value="HLT">HLT</option>
            <option value="CTW">CTW</option>
          </select>
        </div>
        <div class="form-group">
          <label>วิธีขนส่ง</label>
          <select class="form-control" id="f-shipping-method" onchange="autoLeadTime('f-lead-time')">
            <option value="">-- ไม่ระบุ --</option>
            <option value="รถ">🚛 รถ (ETA ~7 วัน)</option>
            <option value="เรือ">🚢 เรือ (ETA ~30 วัน)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Est. Lead Time (วัน)</label>
          <input class="form-control" id="f-lead-time" type="number" value="25" min="1">
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">📦 รายการสินค้า (SKU)</div><button class="btn-secondary btn-sm" onclick="addTempItem()">＋ เพิ่ม SKU</button></div>
      <datalist id="sku-datalist">${_itemMasterList.map(it => `<option value="${it.item_id}">${it.item_name}</option>`).join('')}</datalist>
      <div class="items-table-wrap">
        <table>
          <thead><tr><th style="width:30px">#</th><th>SKU</th><th style="width:130px">Order QTY</th><th>หมายเหตุ</th><th style="width:44px"></th></tr></thead>
          <tbody id="temp-items-body">
            <tr id="temp-item-0">
              <td class="td-muted">1</td>
              <td><input class="form-control" list="sku-datalist" placeholder="เช่น MP-BJM-001-S" style="border:none;padding:4px 0" onchange="onSkuChange(this,0)" autocomplete="off"></td>
              <td><input class="form-control" type="number" placeholder="0" min="0" style="border:none;padding:4px 0" oninput="calcTotal();onQtyChange(0)"></td>
              <td><input class="form-control" placeholder="หมายเหตุ" style="border:none;padding:4px 0"></td>
              <td></td>
            </tr>
            <tr id="temp-item-0-info" style="display:none"><td></td><td colspan="4" id="temp-item-0-detail" style="padding:8px 0"></td></tr>
          </tbody>
        </table>
        <div class="add-item-row"><span class="text-sm text-muted">รวม: <strong id="total-qty">0</strong> ชิ้น จาก <strong id="total-sku">0</strong> SKU</span></div>
      </div>
    </div>
    <div class="flex gap-3" style="justify-content:flex-end">
      <button class="btn-secondary" onclick="navigate('po-list')">ยกเลิก</button>
      <button class="btn-primary" onclick="savePO('Draft')">💾 บันทึกเป็น Draft</button>
      <button class="btn-primary" style="background:#1a6348" onclick="savePO('Ordered')">✅ บันทึก & สั่งซื้อ</button>
    </div>`;

  tempItemCount = 1; calcTotal();

  // Attach keyboard nav (Tab/Enter) and Excel paste handlers
  const gridBody = document.getElementById('temp-items-body');
  if (gridBody) {
    gridBody.addEventListener('keydown', handleGridKeydown);
    gridBody.addEventListener('paste',   handleGridPaste);
  }
}

let tempItemCount = 1;
function addTempItem() {
  const idx = tempItemCount++;
  const tbody = document.getElementById('temp-items-body');
  const tr = document.createElement('tr');
  tr.id = `temp-item-${idx}`;
  tr.innerHTML = `
    <td class="td-muted">${idx + 1}</td>
    <td><input class="form-control" list="sku-datalist" placeholder="SKU" style="border:none;padding:4px 0" onchange="onSkuChange(this,${idx})" autocomplete="off"></td>
    <td><input class="form-control" type="number" placeholder="0" min="0" style="border:none;padding:4px 0" oninput="calcTotal();onQtyChange(${idx})"></td>
    <td><input class="form-control" placeholder="หมายเหตุ" style="border:none;padding:4px 0"></td>
    <td><button style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:18px">✕</button></td>`;
  const infoTr = document.createElement('tr');
  infoTr.id = `temp-item-${idx}-info`;
  infoTr.style.display = 'none';
  infoTr.innerHTML = `<td></td><td colspan="4" id="temp-item-${idx}-detail" style="padding:8px 0"></td>`;
  tr.querySelector('button').onclick = () => { tr.remove(); infoTr.remove(); calcTotal(); };
  tbody.appendChild(tr);
  tbody.appendChild(infoTr);
  calcTotal();
}

// ============================================================
// GRID INPUT — Keyboard Navigation (Tab / Enter) & Excel Paste
// ============================================================
function handleGridKeydown(e) {
  const input = e.target;
  if (input.tagName !== 'INPUT') return;
  const row = input.closest('tr');
  if (!row || !row.id?.startsWith('temp-item-') || row.id.includes('-info')) return;
  if (e.key !== 'Tab' && e.key !== 'Enter') return;
  e.preventDefault();

  const inputs  = Array.from(row.querySelectorAll('input'));
  const colIdx  = inputs.indexOf(input);

  if (e.key === 'Tab' && !e.shiftKey) {
    if (colIdx < inputs.length - 1) { inputs[colIdx + 1].focus(); return; }
    const nextRow = _getNextGridRow(row);
    if (nextRow) { nextRow.querySelectorAll('input')[0]?.focus(); }
    else { addTempItem(); _focusLastRow(0); }
  } else if (e.key === 'Tab' && e.shiftKey) {
    if (colIdx > 0) { inputs[colIdx - 1].focus(); return; }
    const prevRow = _getPrevGridRow(row);
    if (prevRow) { const pi = prevRow.querySelectorAll('input'); pi[pi.length - 1]?.focus(); }
  } else if (e.key === 'Enter') {
    const nextRow = _getNextGridRow(row);
    if (nextRow) { nextRow.querySelectorAll('input')[colIdx]?.focus(); }
    else { addTempItem(); _focusLastRow(colIdx); }
  }
}

function _getNextGridRow(row) {
  let next = row.nextElementSibling;
  while (next) {
    if (next.id?.startsWith('temp-item-') && !next.id.includes('-info')) return next;
    next = next.nextElementSibling;
  }
  return null;
}

function _getPrevGridRow(row) {
  let prev = row.previousElementSibling;
  while (prev) {
    if (prev.id?.startsWith('temp-item-') && !prev.id.includes('-info')) return prev;
    prev = prev.previousElementSibling;
  }
  return null;
}

function _focusLastRow(colIdx) {
  setTimeout(() => {
    const tbody = document.getElementById('temp-items-body');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr[id^="temp-item-"]:not([id*="-info"])'));
    const last = rows[rows.length - 1];
    if (last) last.querySelectorAll('input')[colIdx]?.focus();
  }, 30);
}

function handleGridPaste(e) {
  const input = e.target;
  if (input.tagName !== 'INPUT') return;
  const row = input.closest('tr');
  if (!row || !row.id?.startsWith('temp-item-') || row.id.includes('-info')) return;

  const pasteText = (e.clipboardData || window.clipboardData).getData('text');
  const lines = pasteText.split(/\r?\n/).filter(l => l.trim() !== '');
  // Single value with no tabs → let browser handle normally
  if (lines.length <= 1 && !pasteText.includes('\t')) return;
  e.preventDefault();

  const tbody    = document.getElementById('temp-items-body');
  const startInputs = Array.from(row.querySelectorAll('input'));
  const startCol    = startInputs.indexOf(input);

  lines.forEach((line, lineIdx) => {
    const cells = line.split('\t');
    // Re-query rows each iteration because addTempItem mutates the DOM
    let allRows = Array.from(tbody.querySelectorAll('tr[id^="temp-item-"]:not([id*="-info"])'));
    const startRowIdx = allRows.indexOf(row);
    const targetIdx   = startRowIdx + lineIdx;
    if (targetIdx >= allRows.length) {
      addTempItem();
      allRows = Array.from(tbody.querySelectorAll('tr[id^="temp-item-"]:not([id*="-info"])'));
    }
    const targetRow = allRows[targetIdx];
    if (!targetRow) return;
    const rowInputs = Array.from(targetRow.querySelectorAll('input'));
    cells.forEach((cell, ci) => {
      const inp = rowInputs[startCol + ci];
      if (!inp) return;
      inp.value = cell.trim();
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('input',  { bubbles: true }));
    });
  });
  calcTotal();
}

// SKU lookup + UOM calculation
const DEFAULT_SPEC = { item_type: 'Product', default_weight_per_pc: 0.3, qty_per_carton: 1, carton_weight: 0, carton_volume: 0 };

function onSkuChange(input, idx) {
  const skuVal = input.value.trim();
  const item = _itemMasterList.find(it => it.item_id === skuVal);
  const row = document.getElementById(`temp-item-${idx}`);
  if (!row) return;
  // If SKU not in Item Master → fall back to defaults (Product, 0.3 kg/pc)
  const spec = item || (skuVal ? { ...DEFAULT_SPEC, item_id: skuVal } : null);
  row.dataset.itemType = spec?.item_type || '';
  row.dataset.itemSpec = spec ? JSON.stringify(spec) : '';
  row.dataset.isDefault = item ? '0' : (skuVal ? '1' : '0');
  onQtyChange(idx);
}

async function onQtyChange(idx) {
  const row = document.getElementById(`temp-item-${idx}`);
  const infoRow = document.getElementById(`temp-item-${idx}-info`);
  const detail = document.getElementById(`temp-item-${idx}-detail`);
  if (!row || !infoRow || !detail) return;

  const spec = row.dataset.itemSpec ? JSON.parse(row.dataset.itemSpec) : null;
  const inputs = row.querySelectorAll('input');
  const qty = parseInt(inputs[1]?.value || '0');

  if (!spec || !qty) { infoRow.style.display = 'none'; return; }

  infoRow.style.display = '';
  if (spec.item_type === 'Material') {
    const cartons = Math.ceil(qty / spec.qty_per_carton);
    const weight  = +(cartons * spec.carton_weight).toFixed(2);
    const volume  = +(cartons * spec.carton_volume).toFixed(4);
    // Save computed values on row
    row.dataset.cartons = cartons;
    row.dataset.weight  = weight;
    row.dataset.volume  = volume;

    // Fetch logistics compare
    let compareHtml = '<span class="text-muted text-sm">กำลังเปรียบเทียบราคา...</span>';
    detail.innerHTML = `
      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px 14px;font-size:13px">
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:8px">
          <span>📦 <strong>${cartons.toLocaleString()}</strong> ลัง</span>
          <span>🏋 <strong>${weight.toLocaleString()}</strong> kg</span>
          <span>📐 <strong>${volume}</strong> CBM</span>
        </div>
        <div id="logistics-compare-${idx}">${compareHtml}</div>
      </div>`;

    try {
      const results = await API.post('/logistics/compare', { weight, volume });
      const sel = row.dataset.selectedLogistics || '';
      const compareRows = results.map((r, i) => `
        <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;background:${i===0?'#ecfdf5':''}">
          <input type="radio" name="logistics-${idx}" value="${r.company}|${r.method}|${r.cost}" ${sel === `${r.company}|${r.method}` ? 'checked' : ''}>
          <span style="min-width:60px;font-weight:600">${r.company}</span>
          <span style="min-width:60px;color:#64748b">${r.method}</span>
          <span class="badge ${r.charge_type==='Weight'?'badge-ordered':'badge-shipped'}">${r.charge_type==='Weight'?'น้ำหนัก':'ปริมาตร'}</span>
          <span style="margin-left:auto;font-weight:700;color:#059669">${r.cost.toLocaleString()} บาท</span>
          ${i===0?'<span style="font-size:11px;color:#059669;font-weight:600">ถูกสุด</span>':''}
          <button type="button" class="btn-secondary btn-sm" style="margin-left:8px;padding:2px 8px;font-size:11px"
            onclick="selectLogisticsForPO('${r.company}','${r.method}');event.stopPropagation()">🎯 ใช้วิธีนี้</button>
        </label>`).join('');
      document.getElementById(`logistics-compare-${idx}`).innerHTML =
        `<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">🔀 เปรียบเทียบค่าขนส่ง</div>${compareRows}`;
    } catch { /* ignore */ }

  } else if (spec.item_type === 'Product') {
    const weight = +(qty * spec.default_weight_per_pc).toFixed(2);
    row.dataset.weight = weight;
    const isDefault = row.dataset.isDefault === '1';
    detail.innerHTML = `
      <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;font-size:13px">
        <span>🏋 น้ำหนักรวม (ประมาณ) <strong>${weight.toLocaleString()}</strong> kg</span>
        <span class="text-muted text-sm" style="margin-left:12px">(${spec.default_weight_per_pc} kg × ${qty.toLocaleString()} ชิ้น)</span>
        ${isDefault ? `<span style="margin-left:10px;font-size:11px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:99px;font-weight:600">⚠ ไม่พบใน Item Master — ใช้ค่า default</span>` : ''}
      </div>`;
  } else {
    infoRow.style.display = 'none';
  }
}
// Auto-fill PO header company/method when user picks from logistics compare table
function selectLogisticsForPO(company, method) {
  const companyEl = document.getElementById('f-logistics-company');
  const methodEl  = document.getElementById('f-shipping-method');
  if (companyEl) companyEl.value = company;
  if (methodEl)  { methodEl.value = method; autoLeadTime('f-lead-time'); }
  toast(`เลือก ${company} — ${method} แล้ว (กรอกที่หัวบิลให้อัตโนมัติ)`, 'success');
}

function calcTotal() {
  const rows = document.querySelectorAll('#temp-items-body tr');
  let totalQty = 0, totalSku = 0;
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const q = parseInt(inputs[1]?.value || '0');
    if (!isNaN(q)) totalQty += q;
    if (inputs[0]?.value.trim()) totalSku++;
  });
  const tq = document.getElementById('total-qty'); const ts = document.getElementById('total-sku');
  if (tq) tq.textContent = totalQty.toLocaleString();
  if (ts) ts.textContent = totalSku;
}

async function savePO(status) {
  const po_number        = document.getElementById('f-po-number').value.trim();
  const project_name     = document.getElementById('f-project').value.trim();
  const order_date       = document.getElementById('f-order-date').value;
  const est_lead_time    = parseInt(document.getElementById('f-lead-time').value);
  const logistics_company = document.getElementById('f-logistics-company')?.value || null;
  const shipping_method  = document.getElementById('f-shipping-method')?.value || null;

  if (!po_number) { toast('กรุณากรอก PO Number', 'error'); return; }
  if (!project_name) { toast('กรุณากรอก Project Name', 'error'); return; }

  const rows = document.querySelectorAll('#temp-items-body tr[id^="temp-item-"]:not([id$="-info"])');
  const items = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input[type="text"],input:not([type]),input[type="number"]');
    const sku = inputs[0]?.value.trim();
    const order_qty = parseInt(inputs[1]?.value || '0');
    const remark_purchase = inputs[2]?.value.trim();
    if (!sku || order_qty <= 0) return;
    // Collect logistics selection
    const selected = row.querySelector(`input[name^="logistics-"]:checked`);
    const [logCo, logMeth, logCost] = (selected?.value || '||').split('|');
    items.push({
      sku, order_qty, remark_purchase: remark_purchase || '',
      item_type:          row.dataset.itemType || null,
      shipping_cartons:   +(row.dataset.cartons || 0),
      estimated_weight:   +(row.dataset.weight  || 0),
      estimated_volume:   +(row.dataset.volume  || 0),
      selected_logistics: selected ? `${logCo} ${logMeth}` : null,
      shipping_cost:      selected ? +logCost : null,
    });
  });

  try {
    const btn = event.target; btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
    const newPO = await API.post('/po', { po_number, project_name, order_date, status, est_lead_time: est_lead_time || 25, logistics_company, shipping_method, items });
    toast(`สร้าง ${po_number} สำเร็จ!`, 'success');
    editingPO = newPO;
    navigate('po-detail');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ============================================================
// EDIT STATUS MODAL
// ============================================================
function openEditStatusModal(poNumber) {
  const po = _allPOHeaders.find(p => p.po_number === poNumber) || editingPO;
  if (!po) return;
  editingPO = po;
  document.getElementById('modal-po-number').textContent = poNumber;
  document.getElementById('edit-order-date').value = po.order_date ? po.order_date.substring(0, 10) : '';
  document.getElementById('edit-status').value = po.status;
  document.getElementById('edit-departure').value = po.departure_date ? po.departure_date.substring(0, 10) : '';
  document.getElementById('edit-logistics-company').value = po.logistics_company || '';
  document.getElementById('edit-shipping-method').value = po.shipping_method || '';
  document.getElementById('edit-leadtime').value = po.est_lead_time || 25;
  toggleDepartureField();
  showModal('edit-status-modal');
}
function toggleDepartureField() {
  const status = document.getElementById('edit-status').value;
  const row = document.getElementById('departure-row');
  if (row) row.style.display = ['Shipped_CN', 'Thai_Customs', 'Arrived', 'Completed'].includes(status) ? 'flex' : 'none';
}
async function saveStatusUpdate() {
  const po = editingPO; if (!po) return;
  const order_date       = document.getElementById('edit-order-date')?.value || null;
  const status           = document.getElementById('edit-status').value;
  const departure_date   = document.getElementById('edit-departure').value || null;
  const logistics_company = document.getElementById('edit-logistics-company')?.value || null;
  const shipping_method  = document.getElementById('edit-shipping-method')?.value || null;
  const est_lead_time    = parseInt(document.getElementById('edit-leadtime').value);
  try {
    await API.put(`/po/${po.po_number}`, { order_date, status, departure_date, logistics_company, shipping_method, est_lead_time });
    hideModal('edit-status-modal');
    toast(`อัปเดต ${po.po_number} → ${STATUS_LABELS[status]} สำเร็จ`, 'success');
    // Refresh data
    _allPOHeaders = await API.get('/po');
    editingPO = _allPOHeaders.find(p => p.po_number === po.po_number) || editingPO;
    renderView(currentView);
  } catch (err) { toast(err.message, 'error'); }
}

async function ackDiscrepancy(poNumber, ack) {
  try {
    await API.put(`/po/${poNumber}`, { discrepancy_ack: ack });
    toast(ack ? '✅ รับรู้ความคลาดเคลื่อนแล้ว' : 'ยกเลิกการรับรู้แล้ว', 'success');
    // Re-render PO detail
    editingPO = await API.get(`/po/${poNumber}`);
    navigate('po-detail');
  } catch (err) { toast(err.message, 'error'); }
}

async function saveBilledData(poNumber) {
  const actual_billed_weight = +document.getElementById('billed-weight')?.value || 0;
  const actual_billed_volume = +document.getElementById('billed-volume')?.value || 0;
  try {
    await API.put(`/po/${poNumber}`, { actual_billed_weight, actual_billed_volume });
    toast('บันทึกค่าบิลจริงสำเร็จ', 'success');
    // Refresh to re-render discrepancy table
    _allPOHeaders = await API.get('/po');
    editingPO = await API.get(`/po/${poNumber}`);
    renderView(currentView);
  } catch (err) { toast(err.message, 'error'); }
}

// ============================================================
// EDIT ITEM MODAL
// ============================================================
function openEditItemModal(itemId, sku, order_qty, remark_purchase) {
  document.getElementById('edit-item-id').value = itemId;
  document.getElementById('edit-item-sku').value = sku;
  document.getElementById('edit-item-qty').value = order_qty;
  document.getElementById('edit-item-remark').value = remark_purchase || '';
  showModal('edit-item-modal');
}
async function saveEditItem() {
  const itemId = document.getElementById('edit-item-id').value;
  const sku = document.getElementById('edit-item-sku').value.trim();
  const order_qty = parseInt(document.getElementById('edit-item-qty').value);
  const remark_purchase = document.getElementById('edit-item-remark').value.trim();
  if (!sku) { toast('กรุณากรอก SKU', 'error'); return; }
  if (!order_qty || order_qty <= 0) { toast('กรุณากรอกจำนวน', 'error'); return; }
  try {
    await API.put(`/items/${itemId}`, { sku, order_qty, remark_purchase });
    hideModal('edit-item-modal');
    toast(`อัปเดต ${sku} สำเร็จ`, 'success');
    renderView(currentView);
  } catch (err) { toast(err.message, 'error'); }
}

// Auto-fill lead time when shipping method changes
function autoLeadTime(leadTimeInputId) {
  const methodEl = document.getElementById(leadTimeInputId === 'f-lead-time' ? 'f-shipping-method' : 'edit-shipping-method');
  const leadEl = document.getElementById(leadTimeInputId);
  if (!methodEl || !leadEl) return;
  if (methodEl.value === 'รถ') leadEl.value = 7;
  else if (methodEl.value === 'เรือ') leadEl.value = 30;
}

// ============================================================
// ADD ITEM MODAL
// ============================================================
function openAddItemModal(poNumber) {
  document.getElementById('add-item-po').textContent = poNumber;
  document.getElementById('new-sku').value = '';
  document.getElementById('new-qty').value = '';
  document.getElementById('new-remark').value = '';
  showModal('add-item-modal');
}
async function saveNewItem() {
  const poNumber = document.getElementById('add-item-po').textContent;
  const sku = document.getElementById('new-sku').value.trim();
  const order_qty = parseInt(document.getElementById('new-qty').value);
  const remark_purchase = document.getElementById('new-remark').value.trim();
  if (!sku) { toast('กรุณากรอก SKU', 'error'); return; }
  if (!order_qty || order_qty <= 0) { toast('กรุณากรอกจำนวน', 'error'); return; }
  try {
    await API.post(`/po/${poNumber}/items`, { sku, order_qty, remark_purchase });
    hideModal('add-item-modal');
    toast(`เพิ่ม ${sku} สำเร็จ`, 'success');
    renderView(currentView);
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteItem(itemId) {
  if (!confirm('ยืนยันการลบรายการนี้?')) return;
  try {
    await API.del(`/items/${itemId}`);
    toast('ลบรายการสำเร็จ', 'success');
    renderView(currentView);
  } catch (err) { toast(err.message, 'error'); }
}

// ============================================================
// DELETE PO
// ============================================================
let _deletingPONumber = null;

async function openDeletePOModal(poNumber) {
  _deletingPONumber = poNumber;
  document.getElementById('delete-po-number').textContent = poNumber;
  document.getElementById('delete-po-summary').innerHTML = '<span style="color:#94a3b8">กำลังโหลด...</span>';
  showModal('delete-po-modal');

  // Fetch item + log counts for the summary
  try {
    const po = await API.get(`/po/${poNumber}`);
    const itemCount = po.items?.length || 0;
    const logCount  = po.logs?.length  || 0;
    document.getElementById('delete-po-summary').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between">
          <span>📋 รายการสินค้า (po_items)</span>
          <strong style="color:#ef4444">${itemCount} รายการ</strong>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span>📦 ประวัติการรับสินค้า (receiving_logs)</span>
          <strong style="color:#ef4444">${logCount} รายการ</strong>
        </div>
      </div>`;
  } catch {
    document.getElementById('delete-po-summary').innerHTML = '<span class="text-muted">ไม่สามารถโหลดข้อมูลได้</span>';
  }
}

async function confirmDeletePO() {
  if (!_deletingPONumber) return;
  const btn = document.getElementById('confirm-delete-btn');
  btn.disabled = true;
  btn.textContent = 'กำลังลบ...';
  try {
    await API.del(`/po/${_deletingPONumber}`);
    hideModal('delete-po-modal');
    toast(`ลบ ${_deletingPONumber} สำเร็จ`, 'success');
    _deletingPONumber = null;
    // Navigate back to list and refresh
    editingPO = null;
    _allPOHeaders = await API.get('/po');
    navigate('po-list');
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '🗑 ยืนยันการลบ';
  }
}

// ============================================================
// WAREHOUSE — SEARCH
// ============================================================
async function renderWHSearch(body, topbar) {
  topbar.innerHTML = `<div class="topbar-left"><h2>🔍 ค้นหา PO สำหรับรับสินค้า</h2><p>ค้นหา PO Number เมื่อสินค้ามาถึงคลัง</p></div>`;
  const headers = await API.get('/po');
  _allPOHeaders = headers;
  const arrived = headers.filter(p => ['Arrived', 'Thai_Customs', 'Shipped_CN'].includes(p.status));

  body.innerHTML = `
    <div class="card" style="max-width:600px;margin:0 auto">
      <div class="card-title mb-4">🔎 ค้นหา PO Number</div>
      <div class="search-bar" style="margin-bottom:20px">
        <span class="icon">🔍</span>
        <input type="text" id="wh-search-input" placeholder="พิมพ์ PO Number..." oninput="whSearchFilter()" style="font-size:16px">
      </div>
      <div id="wh-search-results"></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">📍 PO ที่พร้อมรับสินค้า</div><span class="badge badge-arrived">${arrived.length} รายการ</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>PO Number</th><th>Project</th><th>Status</th><th>ETA</th><th></th></tr></thead>
        <tbody>${arrived.length ? arrived.map(po => `
          <tr>
            <td><span class="po-number-tag">${po.po_number}</span></td>
            <td>${po.project_name}</td>
            <td>${statusBadge(po.status, isOverdue(po))}</td>
            <td class="td-muted">${formatDate(getETA(po))}</td>
            <td><button class="btn-primary btn-sm" onclick="goReceive('${po.po_number}')">📦 รับสินค้า</button></td>
          </tr>`).join('') :
          `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">🏭</div><h3>ไม่มี PO ที่พร้อมรับ</h3></div></td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function whSearchFilter() {
  const rawSearch = document.getElementById('wh-search-input').value.trim();
  const terms = rawSearch.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const resultsEl = document.getElementById('wh-search-results');
  if (!terms.length) { resultsEl.innerHTML = ''; return; }
  const matches = _allPOHeaders.filter(p =>
    terms.some(term => p.po_number.toLowerCase().includes(term) || p.project_name.toLowerCase().includes(term))
  ).slice(0, 10);
  if (!matches.length) { resultsEl.innerHTML = `<div class="alert alert-amber"><span class="alert-icon">⚠</span><div class="alert-body"><p>ไม่พบ PO ที่ตรงกับ "${rawSearch}"</p></div></div>`; return; }
  resultsEl.innerHTML = matches.map(po => `
    <div style="border:1px solid rgba(33,55,60,.10);border-radius:10px;padding:14px 18px;margin-bottom:8px;display:flex;align-items:center;gap:12px;cursor:pointer;background:#fff" onclick="goReceive('${po.po_number}')" onmouseover="this.style.background='#EAE5D8'" onmouseout="this.style.background='#fff'">
      <div style="flex:1"><div class="po-number-tag">${po.po_number}</div><div class="text-sm text-muted">${po.project_name}</div></div>
      ${statusBadge(po.status, isOverdue(po))}
      <button class="btn-primary btn-sm">เลือก →</button>
    </div>`).join('');
}

async function goReceive(poNumber) {
  const po = await API.get(`/po/${poNumber}`);
  receivingPO = po;
  navigate('wh-receive');
}

// ============================================================
// WAREHOUSE — RECEIVE & QC
// ============================================================
let poLevelPhotoFiles = []; // PO-level evidence photos (not tied to any SKU)
let extraReceiveRows  = []; // SKUs received that were not in original PO

async function renderWHReceive(body, topbar) {
  let po = receivingPO;
  if (!po) { navigate('wh-search'); return; }
  // Refresh
  po = await API.get(`/po/${po.po_number}`);
  receivingPO = po;

  const items = po.items || [];
  const logs = po.logs || [];
  poLevelPhotoFiles  = [];
  extraReceiveRows   = [];

  // Load existing PO-level evidence images
  let existingPOImages = [];
  try { existingPOImages = await API.get(`/po/${po.po_number}/images`); } catch { /* optional */ }

  topbar.innerHTML = `
    <div class="topbar-left"><h2>📦 รับสินค้า & QC</h2><p><span class="po-number-tag">${po.po_number}</span> — ${po.project_name}</p></div>
    <div class="topbar-right"><button class="btn-secondary" onclick="navigate('wh-search')">← กลับ</button></div>`;

  const itemForms = items.map((item, idx) => {
    const log = logs.find(l => l.sku === item.sku);
    const isMaterial = item.item_type === 'Material';
    const expectedCartons = isMaterial && item.shipping_cartons > 0 ? item.shipping_cartons : null;
    const receiveLabel = isMaterial ? 'จำนวนลังที่รับได้' : 'จำนวนนับได้จริง';
    const receiveUnit  = isMaterial ? 'ลัง' : 'ชิ้น';
    // For material: display qty-block shows cartons, sub shows pieces
    const qtyBlockHtml = expectedCartons
      ? `<div class="qty-block"><span class="qty-main" style="color:#8FACD7">${expectedCartons.toLocaleString()}</span><span class="qty-sub">ลัง (${item.order_qty.toLocaleString()} ชิ้น)</span></div>`
      : `<div class="qty-block"><span class="qty-main">${item.order_qty.toLocaleString()}</span><span class="qty-sub">Order QTY (ชิ้น)</span></div>`;

    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header" style="margin-bottom:16px">
          <div>
            <div class="card-title font-mono">${item.sku}</div>
            <div class="text-sm text-muted">${item.remark_purchase || 'ไม่มีหมายเหตุ'}</div>
            ${isMaterial ? `<span class="badge badge-shipped" style="margin-top:4px">📦 Material — นับเป็นลัง</span>` : `<span class="badge badge-arrived" style="margin-top:4px">👕 Product — นับเป็นชิ้น</span>`}
          </div>
          ${qtyBlockHtml}
        </div>
        <div class="form-grid form-grid-3">
          <div class="form-group">
            <label>วันที่รับสินค้า <span style="color:#ef4444">*</span></label>
            <input class="form-control" type="date" id="arrived-${idx}"
              value="${log?.arrived_date ? log.arrived_date.substring(0,10) : today()}">
          </div>
          <div class="form-group">
            <label>${receiveLabel} <span style="color:#ef4444">*</span>${isMaterial ? `<span class="text-muted text-sm"> (${receiveUnit})</span>` : ''}</label>
            <input class="form-control" type="number" id="receive-qty-${idx}" placeholder="0" min="0"
              value="${log && log.receive_qty > 0 ? (isMaterial && item.shipping_cartons > 0 ? Math.round(log.receive_qty / (item.order_qty / item.shipping_cartons)) : log.receive_qty) : ''}"
              oninput="calcQC(${idx}, ${isMaterial && item.shipping_cartons > 0 ? item.shipping_cartons : item.order_qty})" data-is-material="${isMaterial}" data-qty-per-carton="${isMaterial && item.shipping_cartons > 0 ? Math.round(item.order_qty / item.shipping_cartons) : 1}">
            ${isMaterial && expectedCartons ? `<span class="hint">ที่สั่งมา ${expectedCartons} ลัง — กรอกจำนวนลังที่นับได้จริง</span>` : ''}
          </div>
          <div class="form-group">
            <label>Check Diff</label>
            <div id="diff-${idx}" style="display:flex;align-items:center;height:42px">
              ${log && log.receive_qty > 0 ? diffChip(item.order_qty, log.receive_qty) : '<span class="text-muted">กรอกจำนวนก่อน</span>'}
            </div>
          </div>
          <div class="form-group">
            <label>Pass QC ✅</label>
            <input class="form-control" type="number" id="pass-qc-${idx}" placeholder="0" min="0"
              value="${qcDone(log) ? log.pass_qc_qty : ''}" oninput="calcNotPass(${idx})">
          </div>
          <div class="form-group">
            <label>Not Pass QC ❌</label>
            <input class="form-control" type="number" id="not-pass-qc-${idx}" placeholder="0" min="0"
              value="${qcDone(log) ? log.not_pass_qc_qty : ''}" oninput="calcPassAuto(${idx})">
          </div>
          <div class="form-group">
            <label>QC Result</label>
            <div id="qc-result-${idx}" style="display:flex;align-items:center;height:42px">
              ${qcDone(log) ? `<span class="badge ${log.not_pass_qc_qty > 0 ? 'badge-shipped' : 'badge-arrived'}">${log.not_pass_qc_qty > 0 ? `ไม่ผ่าน ${log.not_pass_qc_qty} ชิ้น` : 'ผ่านทั้งหมด'}</span>` : '<span class="text-muted">ยังไม่ได้ทำ QC</span>'}
            </div>
          </div>
        </div>
        <div class="form-group mt-3">
          <label>หมายเหตุคลัง</label>
          <textarea class="form-control" id="remark-wh-${idx}" placeholder="สภาพสินค้า, ปัญหาที่พบ...">${log?.remark_warehouse || ''}</textarea>
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="receive-po-card">
      <div class="flex items-center gap-3">
        <div style="font-size:24px">📋</div>
        <div><div class="po-number-tag" style="font-size:16px">${po.po_number}</div><div style="font-weight:600">${po.project_name}</div></div>
        <div class="ml-auto">${statusBadge(po.status, isOverdue(po))}</div>
      </div>
      <div class="po-info-grid">
        <div><label>Order Date</label><span>${formatDate(po.order_date)}</span></div>
        <div><label>Departure</label><span>${formatDate(po.departure_date)}</span></div>
        <div><label>ETA</label><span>${formatDate(getETA(po))}</span></div>
        <div><label>จำนวน SKU</label><span>${items.length} รายการ</span></div>
      </div>
    </div>
    ${itemForms}
    <!-- Extra SKUs received outside PO -->
    <div class="card" id="extra-sku-card">
      <div class="card-header" style="margin-bottom:12px">
        <div>
          <div class="card-title">➕ สินค้าที่ได้รับเพิ่ม (ไม่ได้สั่ง)</div>
          <div class="card-subtitle">เพิ่ม SKU ที่ได้รับมาแต่ไม่มีใน PO เช่น ของแถม หรือสินค้าผิด</div>
        </div>
        <button class="btn-secondary btn-sm" onclick="addExtraRow()">＋ เพิ่ม SKU</button>
      </div>
      <div id="extra-rows-wrap">
        <div class="text-muted text-sm" style="padding:8px 0" id="extra-rows-empty">ยังไม่มีรายการ — กดปุ่มเพื่อเพิ่ม SKU ที่ได้รับนอก PO</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title mb-4">📸 รูปภาพหลักฐานการรับสินค้า (รวม PO)</div>
      <p class="text-sm text-muted mb-3" style="margin-bottom:12px">ถ่ายรูปรวมสินค้าของ PO นี้ได้เลย ไม่ต้องผูกกับ SKU ใดๆ</p>
      <div class="photo-upload-area"
        onclick="document.getElementById('po-level-upload').click()"
        ondragover="event.preventDefault();this.classList.add('drag')"
        ondragleave="this.classList.remove('drag')"
        ondrop="handlePOLevelDrop(event)">
        <input type="file" id="po-level-upload" accept="image/*" multiple
          onchange="handlePOLevelUpload(this)" style="display:none">
        <div class="upload-icon">📷</div>
        <p>คลิกหรือลากวางรูปที่นี่</p>
        <small>รูปรวม PO — JPG, PNG, WEBP — ไม่เกิน 5MB</small>
      </div>
      <div class="photo-preview-grid" id="po-level-preview"></div>
      ${existingPOImages.length ? `
      <div style="margin-top:16px">
        <div class="text-sm" style="font-weight:600;margin-bottom:8px;color:#374151">📌 รูปที่บันทึกแล้ว (${existingPOImages.length} รูป)</div>
        <div class="photo-preview-grid">${existingPOImages.map(img => `
          <div class="photo-preview-item">
            <img src="${img.photo_url}" onclick="window.open('${img.photo_url}','_blank')" style="cursor:zoom-in">
            <button class="remove-photo" onclick="deletePOImage(${img.id})" title="ลบรูป">✕</button>
          </div>`).join('')}
        </div>
      </div>` : ''}
    </div>
    <div class="card">
      <div class="card-title mb-4">📌 อัปเดตสถานะ PO</div>
      <div class="form-group" style="max-width:300px">
        <label>สถานะหลังรับสินค้า</label>
        <select class="form-control" id="wh-status-update">
          <option value="${po.status}">คงไว้: ${STATUS_LABELS[po.status]}</option>
          ${po.status !== 'Arrived' ? '<option value="Arrived">เปลี่ยนเป็น Arrived</option>' : ''}
          <option value="Completed">เปลี่ยนเป็น Completed (รับครบ)</option>
        </select>
      </div>
    </div>
    <div class="flex gap-3" style="justify-content:flex-end">
      <button class="btn-secondary" onclick="navigate('wh-search')">ยกเลิก</button>
      <button class="btn-primary" id="save-receiving-btn" style="background:#1a6348" onclick="saveReceiving()">💾 บันทึกการรับสินค้าทั้งหมด</button>
    </div>`;
}

function calcQC(idx, orderQty) {
  const receiveVal = parseInt(document.getElementById(`receive-qty-${idx}`).value || '0');
  const diffEl = document.getElementById(`diff-${idx}`);
  if (diffEl) diffEl.innerHTML = diffChip(orderQty, receiveVal);
  const passEl = document.getElementById(`pass-qc-${idx}`);
  if (passEl && !passEl.value) passEl.value = receiveVal;
  calcNotPass(idx);
}
function calcNotPass(idx) {
  const receive = parseInt(document.getElementById(`receive-qty-${idx}`)?.value || '0');
  const pass = parseInt(document.getElementById(`pass-qc-${idx}`)?.value || '0');
  const notPassEl = document.getElementById(`not-pass-qc-${idx}`);
  if (notPassEl) { const notPass = Math.max(0, receive - pass); notPassEl.value = notPass; updateQCResult(idx, notPass); }
}
function calcPassAuto(idx) {
  const receive = parseInt(document.getElementById(`receive-qty-${idx}`)?.value || '0');
  const notPass = parseInt(document.getElementById(`not-pass-qc-${idx}`)?.value || '0');
  const passEl = document.getElementById(`pass-qc-${idx}`);
  if (passEl) passEl.value = Math.max(0, receive - notPass);
  updateQCResult(idx, notPass);
}
function updateQCResult(idx, notPass) {
  const el = document.getElementById(`qc-result-${idx}`);
  if (el) el.innerHTML = notPass > 0 ? `<span class="badge badge-shipped">ไม่ผ่าน ${notPass} ชิ้น</span>` : `<span class="badge badge-arrived">ผ่านทั้งหมด</span>`;
}

// ============================================================
// EXTRA SKU ROWS (received outside PO)
// ============================================================
function addExtraRow() {
  extraReceiveRows.push({ sku:'', arrived_date: today(), receive_qty:'', pass_qc_qty:'', not_pass_qc_qty:'', remark_warehouse:'' });
  renderExtraRows();
}
function removeExtraRow(i) {
  extraReceiveRows.splice(i, 1);
  renderExtraRows();
}
function renderExtraRows() {
  const wrap = document.getElementById('extra-rows-wrap');
  const emptyEl = document.getElementById('extra-rows-empty');
  if (!wrap) return;
  if (!extraReceiveRows.length) {
    wrap.innerHTML = `<div class="text-muted text-sm" style="padding:8px 0" id="extra-rows-empty">ยังไม่มีรายการ — กดปุ่มเพื่อเพิ่ม SKU ที่ได้รับนอก PO</div>`;
    return;
  }
  wrap.innerHTML = extraReceiveRows.map((r, i) => `
    <div style="display:grid;grid-template-columns:1fr 130px 90px 90px 90px 1fr 36px;gap:8px;align-items:end;padding:10px 0;border-bottom:1px solid rgba(33,55,60,.07)">
      <div class="form-group" style="margin:0">
        <label style="font-size:12px">SKU <span style="color:#ef4444">*</span></label>
        <input class="form-control" placeholder="เช่น MP-BJM-001-S" value="${r.sku}"
          oninput="extraReceiveRows[${i}].sku=this.value">
      </div>
      <div class="form-group" style="margin:0">
        <label style="font-size:12px">วันที่รับ</label>
        <input class="form-control" type="date" value="${r.arrived_date}"
          oninput="extraReceiveRows[${i}].arrived_date=this.value">
      </div>
      <div class="form-group" style="margin:0">
        <label style="font-size:12px">รับ (ชิ้น) <span style="color:#ef4444">*</span></label>
        <input class="form-control" type="number" min="0" placeholder="0" value="${r.receive_qty}"
          oninput="extraReceiveRows[${i}].receive_qty=+this.value;extraReceiveRows[${i}].pass_qc_qty=+this.value;document.getElementById('ex-pass-${i}').value=this.value">
      </div>
      <div class="form-group" style="margin:0">
        <label style="font-size:12px">Pass QC</label>
        <input class="form-control" type="number" min="0" placeholder="0" value="${r.pass_qc_qty}" id="ex-pass-${i}"
          oninput="extraReceiveRows[${i}].pass_qc_qty=+this.value">
      </div>
      <div class="form-group" style="margin:0">
        <label style="font-size:12px">Not Pass</label>
        <input class="form-control" type="number" min="0" placeholder="0" value="${r.not_pass_qc_qty}"
          oninput="extraReceiveRows[${i}].not_pass_qc_qty=+this.value">
      </div>
      <div class="form-group" style="margin:0">
        <label style="font-size:12px">หมายเหตุ</label>
        <input class="form-control" placeholder="หมายเหตุ..." value="${r.remark_warehouse}"
          oninput="extraReceiveRows[${i}].remark_warehouse=this.value">
      </div>
      <button class="btn-danger btn-sm" onclick="removeExtraRow(${i})" style="align-self:end;padding:8px;min-height:42px">✕</button>
    </div>`).join('');
}

// PO-level evidence photo handlers
function handlePOLevelUpload(input) {
  poLevelPhotoFiles.push(...Array.from(input.files));
  renderPOLevelPreviews();
}
function handlePOLevelDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag');
  poLevelPhotoFiles.push(...Array.from(event.dataTransfer.files).filter(f => f.type.startsWith('image/')));
  renderPOLevelPreviews();
}
function renderPOLevelPreviews() {
  const grid = document.getElementById('po-level-preview');
  if (!grid) return;
  grid.innerHTML = poLevelPhotoFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    return `<div class="photo-preview-item"><img src="${url}"><button class="remove-photo" onclick="removePOLevelPhoto(${i})">✕</button></div>`;
  }).join('');
}
function removePOLevelPhoto(i) { poLevelPhotoFiles.splice(i, 1); renderPOLevelPreviews(); }
async function deletePOImage(id) {
  if (!confirm('ลบรูปนี้ออกจากระบบถาวร?')) return;
  try {
    await API.deletePOImage(id);
    toast('ลบรูปสำเร็จ', 'success');
    navigate('wh-receive'); // Re-render to refresh gallery
  } catch (err) { toast(err.message, 'error'); }
}

async function saveReceiving() {
  const po = receivingPO; if (!po) return;
  const items = po.items || [];
  const new_status = document.getElementById('wh-status-update')?.value || po.status;
  const btn = document.getElementById('save-receiving-btn');

  const logs = [];
  let hasData = false;
  items.forEach((item, idx) => {
    const arrived_date = document.getElementById(`arrived-${idx}`)?.value;
    const receiveInput = document.getElementById(`receive-qty-${idx}`);
    const inputVal = parseInt(receiveInput?.value || '0');
    // For Material items: input is in cartons → convert to pieces for storage
    const isMaterial = receiveInput?.dataset.isMaterial === 'true';
    const qtyPerCarton = +(receiveInput?.dataset.qtyPerCarton || 1);
    const receive_qty = isMaterial && qtyPerCarton > 1 ? inputVal * qtyPerCarton : inputVal;
    const pass_qc_qty = parseInt(document.getElementById(`pass-qc-${idx}`)?.value || '0');
    const not_pass_qc_qty = parseInt(document.getElementById(`not-pass-qc-${idx}`)?.value || '0');
    const remark_warehouse = document.getElementById(`remark-wh-${idx}`)?.value.trim();
    if (inputVal > 0) {
      hasData = true;
      logs.push({ sku: item.sku, arrived_date: arrived_date || today(), receive_qty, pass_qc_qty, not_pass_qc_qty, remark_warehouse: remark_warehouse || '' });
    }
  });

  // Collect valid extra rows
  const validExtras = extraReceiveRows.filter(r => r.sku && r.receive_qty > 0);
  if (!hasData && !validExtras.length) { toast('กรุณากรอกจำนวนรับสินค้าอย่างน้อย 1 รายการ', 'error'); return; }

  // Push extra rows into logs too
  validExtras.forEach(r => {
    hasData = true;
    logs.push({ sku: r.sku, arrived_date: r.arrived_date || today(),
      receive_qty: +r.receive_qty, pass_qc_qty: +r.pass_qc_qty,
      not_pass_qc_qty: +r.not_pass_qc_qty, remark_warehouse: r.remark_warehouse || '' });
  });

  try {
    if (btn) { btn.disabled = true; btn.textContent = 'กำลังบันทึก...'; }
    // Register extra SKUs in po_items first (order_qty=0, is_extra=1)
    if (validExtras.length) {
      await API.post(`/po/${po.po_number}/extra-items`, {
        skus: validExtras.map(r => ({ sku: r.sku, item_type: 'Product' }))
      });
    }
    await API.post('/receiving', { po_number: po.po_number, logs, new_status });
    // Upload PO-level evidence photos (not tied to any SKU)
    if (poLevelPhotoFiles.length) {
      try { await API.uploadPOImages(po.po_number, poLevelPhotoFiles); }
      catch (e) { console.warn('PO image upload warning:', e.message); }
    }
    poLevelPhotoFiles = [];
    toast(`บันทึกการรับสินค้า ${po.po_number} สำเร็จ!`, 'success');
    navigate('wh-search');
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💾 บันทึกการรับสินค้าทั้งหมด'; }
  }
}

// ============================================================
// ITEM MASTER
// ============================================================
async function renderItemMaster(body, topbar) {
  topbar.innerHTML = `
    <div class="topbar-left"><h2>🗂 Item Master</h2><p>ข้อมูล SKU, ประเภท และขนาดบรรจุภัณฑ์</p></div>
    <div class="topbar-right"><button class="btn-primary" onclick="openItemMasterModal()">＋ เพิ่มสินค้า</button></div>`;

  const items = _itemMasterList = await API.get('/item-master');
  const TYPE_ICON = { Product: '👕', Material: '📦', Others: '🔲' };
  const TYPE_LABEL = { Product: 'Product', Material: 'Material', Others: 'Others' };

  const rows = items.length ? items.map(it => `
    <tr>
      <td class="font-mono">${it.item_id}</td>
      <td>${it.item_name}</td>
      <td><span class="badge ${it.item_type === 'Product' ? 'badge-arrived' : it.item_type === 'Material' ? 'badge-shipped' : 'badge-draft'}">${TYPE_ICON[it.item_type]||''} ${TYPE_LABEL[it.item_type]||it.item_type}</span></td>
      <td class="text-right">${it.qty_per_carton}</td>
      <td class="text-right td-muted">${it.item_type === 'Material' ? `${it.carton_weight} kg / ${it.carton_volume} CBM` : `${it.default_weight_per_pc} kg/ชิ้น`}</td>
      <td class="text-right td-muted">${it.item_type === 'Material' ? `${it.carton_length}×${it.carton_width}×${it.carton_height} cm` : '-'}</td>
      <td style="text-align:center">${it.measurement_photo_url
        ? `<a href="${it.measurement_photo_url}" target="_blank" title="ดูรูปวัดสเปค" style="font-size:18px;text-decoration:none">📷</a>`
        : '<span class="td-muted">-</span>'}</td>
      <td><div class="flex gap-2">
        <button class="btn-secondary btn-sm" onclick="openItemMasterModal(${JSON.stringify(it).replace(/"/g,'&quot;')})">✏</button>
        <button class="btn-danger btn-sm" onclick="deleteItemMaster('${it.item_id}','${it.item_name}')">ลบ</button>
      </div></td>
    </tr>`).join('') :
    `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">🗂</div><p>ยังไม่มีข้อมูล Item</p></div></td></tr>`;

  body.innerHTML = `
    <div class="card p-0">
      <div class="table-wrap">
        <table>
          <thead><tr><th>SKU / Item ID</th><th>ชื่อสินค้า</th><th>ประเภท</th><th style="text-align:right">ชิ้น/ลัง</th><th style="text-align:right">น้ำหนัก / ปริมาตร</th><th style="text-align:right">ขนาดลัง (cm)</th><th style="text-align:center">📷</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>

    <!-- Item Modal (inline) -->
    <div class="modal-overlay" id="im-modal" style="display:none" onclick="if(event.target===this)hideModal('im-modal')">
      <div class="modal" style="max-width:600px">
        <div class="modal-header">
          <h3 id="im-modal-title">➕ เพิ่มสินค้า</h3>
          <button class="modal-close" onclick="hideModal('im-modal')">✕</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="im-edit-id">
          <div class="form-grid form-grid-2">
            <div class="form-group">
              <label>SKU / Item ID <span style="color:#ef4444">*</span></label>
              <input class="form-control" id="im-item-id" placeholder="เช่น MP-BJM-001-S">
            </div>
            <div class="form-group">
              <label>ชื่อสินค้า <span style="color:#ef4444">*</span></label>
              <input class="form-control" id="im-item-name" placeholder="ชื่อเต็ม">
            </div>
            <div class="form-group">
              <label>ประเภท</label>
              <select class="form-control" id="im-item-type" onchange="toggleItemTypeFields()">
                <option value="Product">👕 Product</option>
                <option value="Material">📦 Material</option>
                <option value="Others">🔲 Others</option>
              </select>
            </div>
            <div class="form-group" id="im-default-weight-row">
              <label>น้ำหนักต่อชิ้น (kg)</label>
              <input class="form-control" id="im-default-weight" type="number" step="0.001" placeholder="0.300">
            </div>
          </div>
          <div id="im-material-fields">
            <div class="form-grid form-grid-2" style="margin-top:16px">
              <div class="form-group">
                <label>จำนวนชิ้น/ลัง</label>
                <input class="form-control" id="im-qty-per-carton" type="number" placeholder="250">
              </div>
              <div class="form-group">
                <label>น้ำหนักต่อลัง (kg)</label>
                <input class="form-control" id="im-carton-weight" type="number" step="0.01">
              </div>
              <div class="form-group">
                <label>กว้าง (cm)</label>
                <input class="form-control" id="im-carton-width" type="number" step="0.1" oninput="autoCalcCBM()">
              </div>
              <div class="form-group">
                <label>ยาว (cm)</label>
                <input class="form-control" id="im-carton-length" type="number" step="0.1" oninput="autoCalcCBM()">
              </div>
              <div class="form-group">
                <label>สูง (cm)</label>
                <input class="form-control" id="im-carton-height" type="number" step="0.1" oninput="autoCalcCBM()">
              </div>
              <div class="form-group">
                <label>ปริมาตร/ลัง (CBM) <span class="text-muted text-sm">คำนวณอัตโนมัติ</span></label>
                <input class="form-control" id="im-carton-volume" type="number" step="0.0001" placeholder="0.0000">
              </div>
            </div>
          </div>
          <div class="form-group" style="margin-top:16px">
            <label>📷 รูปหลักฐานการวัดขนาด (Measurement Photo)</label>
            <input type="file" class="form-control" id="im-photo-file" accept="image/*" style="padding:6px">
            <div id="im-photo-preview" style="margin-top:8px"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="hideModal('im-modal')">ยกเลิก</button>
          <button class="btn-primary" onclick="saveItemMaster()">💾 บันทึก</button>
        </div>
      </div>
    </div>`;
}

function toggleItemTypeFields() {
  const type = document.getElementById('im-item-type')?.value;
  const matFields = document.getElementById('im-material-fields');
  const wtRow = document.getElementById('im-default-weight-row');
  if (!matFields || !wtRow) return;
  matFields.style.display = type === 'Material' ? '' : 'none';
  wtRow.style.display = type === 'Product' ? '' : 'none';
}
function autoCalcCBM() {
  const w = +document.getElementById('im-carton-width')?.value || 0;
  const l = +document.getElementById('im-carton-length')?.value || 0;
  const h = +document.getElementById('im-carton-height')?.value || 0;
  const vol = document.getElementById('im-carton-volume');
  if (vol) vol.value = (w * l * h / 1e6).toFixed(4);
}
function openItemMasterModal(item) {
  document.getElementById('im-modal-title').textContent = item ? '✏ แก้ไขสินค้า' : '➕ เพิ่มสินค้า';
  document.getElementById('im-edit-id').value = item?.item_id || '';
  document.getElementById('im-item-id').value = item?.item_id || '';
  document.getElementById('im-item-id').disabled = !!item;
  document.getElementById('im-item-name').value = item?.item_name || '';
  document.getElementById('im-item-type').value = item?.item_type || 'Product';
  document.getElementById('im-default-weight').value = item?.default_weight_per_pc || 0.3;
  document.getElementById('im-qty-per-carton').value = item?.qty_per_carton || '';
  document.getElementById('im-carton-weight').value = item?.carton_weight || '';
  document.getElementById('im-carton-width').value = item?.carton_width || '';
  document.getElementById('im-carton-length').value = item?.carton_length || '';
  document.getElementById('im-carton-height').value = item?.carton_height || '';
  document.getElementById('im-carton-volume').value = item?.carton_volume || '';
  // Reset photo input and show existing photo thumbnail
  const fileInput = document.getElementById('im-photo-file');
  const preview   = document.getElementById('im-photo-preview');
  if (fileInput) fileInput.value = '';
  if (preview) {
    preview.innerHTML = item?.measurement_photo_url
      ? `<div style="display:flex;align-items:center;gap:10px">
           <img src="${item.measurement_photo_url}" style="height:60px;border-radius:6px;cursor:zoom-in;border:1px solid rgba(33,55,60,.10)" onclick="window.open('${item.measurement_photo_url}','_blank')">
           <span class="text-sm text-muted">รูปปัจจุบัน (เลือกไฟล์ใหม่เพื่อเปลี่ยน)</span>
         </div>`
      : '';
  }
  toggleItemTypeFields();
  showModal('im-modal');
}
async function saveItemMaster() {
  const editId = document.getElementById('im-edit-id').value;
  const payload = {
    item_id: document.getElementById('im-item-id').value.trim(),
    item_name: document.getElementById('im-item-name').value.trim(),
    item_type: document.getElementById('im-item-type').value,
    default_weight_per_pc: +document.getElementById('im-default-weight').value || 0.3,
    qty_per_carton: +document.getElementById('im-qty-per-carton').value || 1,
    carton_weight: +document.getElementById('im-carton-weight').value || 0,
    carton_width: +document.getElementById('im-carton-width').value || 0,
    carton_length: +document.getElementById('im-carton-length').value || 0,
    carton_height: +document.getElementById('im-carton-height').value || 0,
    carton_volume: +document.getElementById('im-carton-volume').value || 0,
  };
  if (!payload.item_id || !payload.item_name) { toast('กรุณากรอก SKU และชื่อสินค้า', 'error'); return; }
  // Upload measurement photo if selected
  const photoFile = document.getElementById('im-photo-file')?.files?.[0];
  if (photoFile) {
    try {
      const result = await API.uploadPhotos([photoFile]);
      payload.measurement_photo_url = result.urls[0];
    } catch { /* upload failed — save without photo */ }
  }
  try {
    if (editId) await API.put(`/item-master/${editId}`, payload);
    else        await API.post('/item-master', payload);
    hideModal('im-modal');
    toast('บันทึกสำเร็จ', 'success');
    await renderItemMaster(document.getElementById('page-body'), document.getElementById('topbar-inner'));
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteItemMaster(itemId, itemName) {
  if (!confirm(`ลบ "${itemName}" ออกจาก Item Master?`)) return;
  try {
    await API.del(`/item-master/${itemId}`);
    toast('ลบสำเร็จ', 'success');
    await renderItemMaster(document.getElementById('page-body'), document.getElementById('topbar-inner'));
  } catch (err) { toast(err.message, 'error'); }
}

// ============================================================
// LOGISTICS RATES
// ============================================================
async function renderLogisticsRates(body, topbar) {
  topbar.innerHTML = `
    <div class="topbar-left"><h2>🚚 Logistics Rates</h2><p>ตารางเรทค่าขนส่งแต่ละช่องทาง</p></div>
    <div class="topbar-right"><button class="btn-primary" onclick="openRateModal()">＋ เพิ่มเรท</button></div>`;

  const rates = _logisticsRates = await API.get('/logistics-rates');
  const rows = rates.length ? rates.map(r => `
    <tr>
      <td><strong>${r.company_name}</strong></td>
      <td>${r.shipping_method === 'รถ' ? '🚛 รถ' : r.shipping_method === 'เรือ' ? '🚢 เรือ' : r.shipping_method}</td>
      <td><span class="badge ${r.charge_type === 'Weight' ? 'badge-ordered' : 'badge-shipped'}">${r.charge_type === 'Weight' ? '🏋 Weight (kg)' : '📐 Volume (CBM)'}</span></td>
      <td class="text-right"><strong>${(+r.rate_price).toLocaleString()}</strong> บาท/${r.charge_type === 'Weight' ? 'kg' : 'CBM'}</td>
      <td><div class="flex gap-2">
        <button class="btn-secondary btn-sm" onclick="openRateModal(${JSON.stringify(r).replace(/"/g,'&quot;')})">✏</button>
        <button class="btn-danger btn-sm" onclick="deleteRate(${r.id})">ลบ</button>
      </div></td>
    </tr>`).join('') :
    `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">🚚</div><p>ยังไม่มีเรทขนส่ง</p></div></td></tr>`;

  body.innerHTML = `
    <div class="card p-0">
      <div class="table-wrap">
        <table>
          <thead><tr><th>บริษัทขนส่ง</th><th>วิธี</th><th>คิดตาม</th><th style="text-align:right">ราคาต่อหน่วย</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>

    <div class="modal-overlay" id="rate-modal" style="display:none" onclick="if(event.target===this)hideModal('rate-modal')">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3 id="rate-modal-title">➕ เพิ่มเรทขนส่ง</h3>
          <button class="modal-close" onclick="hideModal('rate-modal')">✕</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="rate-edit-id">
          <div class="form-grid">
            <div class="form-group">
              <label>บริษัทขนส่ง</label>
              <input class="form-control" id="rate-company" placeholder="HLT, CTW...">
            </div>
            <div class="form-group">
              <label>วิธีขนส่ง</label>
              <input class="form-control" id="rate-method" placeholder="รถ, เรือ, EK...">
            </div>
            <div class="form-group">
              <label>คิดตาม</label>
              <select class="form-control" id="rate-charge-type">
                <option value="Weight">🏋 น้ำหนัก (per kg)</option>
                <option value="Volume">📐 ปริมาตร (per CBM)</option>
              </select>
            </div>
            <div class="form-group">
              <label>ราคาต่อหน่วย (บาท)</label>
              <input class="form-control" id="rate-price" type="number" step="0.01" placeholder="0">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="hideModal('rate-modal')">ยกเลิก</button>
          <button class="btn-primary" onclick="saveRate()">💾 บันทึก</button>
        </div>
      </div>
    </div>`;
}

function openRateModal(rate) {
  document.getElementById('rate-modal-title').textContent = rate ? '✏ แก้ไขเรท' : '➕ เพิ่มเรทขนส่ง';
  document.getElementById('rate-edit-id').value = rate?.id || '';
  document.getElementById('rate-company').value = rate?.company_name || '';
  document.getElementById('rate-method').value = rate?.shipping_method || '';
  document.getElementById('rate-charge-type').value = rate?.charge_type || 'Weight';
  document.getElementById('rate-price').value = rate?.rate_price || '';
  showModal('rate-modal');
}
async function saveRate() {
  const editId = document.getElementById('rate-edit-id').value;
  const payload = {
    company_name: document.getElementById('rate-company').value.trim(),
    shipping_method: document.getElementById('rate-method').value.trim(),
    charge_type: document.getElementById('rate-charge-type').value,
    rate_price: +document.getElementById('rate-price').value,
  };
  if (!payload.company_name || !payload.shipping_method) { toast('กรุณากรอกให้ครบ', 'error'); return; }
  try {
    if (editId) await API.put(`/logistics-rates/${editId}`, payload);
    else        await API.post('/logistics-rates', payload);
    hideModal('rate-modal');
    toast('บันทึกสำเร็จ', 'success');
    await renderLogisticsRates(document.getElementById('page-body'), document.getElementById('topbar-inner'));
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteRate(id) {
  if (!confirm('ลบเรทนี้?')) return;
  try {
    await API.del(`/logistics-rates/${id}`);
    toast('ลบสำเร็จ', 'success');
    await renderLogisticsRates(document.getElementById('page-body'), document.getElementById('topbar-inner'));
  } catch (err) { toast(err.message, 'error'); }
}

// ============================================================
// SIDEBAR (mobile open/close)
// ============================================================
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-backdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('open');
  document.body.style.overflow = '';
}

// ============================================================
// MOBILE BOTTOM NAV
// ============================================================
function renderMobileNav() {
  const container = document.getElementById('mobile-nav-items');
  if (!container) return;

  const purchaseItems = [
    { view: 'dashboard', icon: '📊', label: 'Dashboard' },
    { view: 'po-list',   icon: '📋', label: 'รายการ PO', badge: true },
    { view: 'create-po', icon: '➕', label: 'สร้าง PO' },
    { view: '__role__',  icon: '🏭', label: 'คลัง' },
  ];
  const warehouseItems = [
    { view: 'dashboard',  icon: '📊', label: 'Dashboard' },
    { view: 'wh-search',  icon: '🔍', label: 'รับสินค้า' },
    { view: '__role__',   icon: '🛒', label: 'จัดซื้อ' },
  ];

  const items = currentRole === 'purchase' ? purchaseItems : warehouseItems;
  container.innerHTML = items.map(item => {
    if (item.view === '__role__') {
      const switchTo = currentRole === 'purchase' ? 'warehouse' : 'purchase';
      return `<button class="mobile-nav-item" onclick="setRole('${switchTo}')" style="color:#64748b">
        <span class="mn-icon">${item.icon}</span><span>${item.label}</span>
      </button>`;
    }
    const isActive = currentView === item.view;
    return `<button class="mobile-nav-item ${isActive ? 'active' : ''}" onclick="navigate('${item.view}')">
      <span class="mn-icon">${item.icon}</span>
      <span>${item.label}</span>
      ${item.badge ? `<span class="mn-badge" id="mn-overdue-badge" style="display:none">0</span>` : ''}
    </button>`;
  }).join('');
}

function updateMobileNavActive() {
  document.querySelectorAll('.mobile-nav-item').forEach(btn => {
    const onclick = btn.getAttribute('onclick') || '';
    const match = onclick.match(/navigate\('([^']+)'\)/);
    if (match) btn.classList.toggle('active', match[1] === currentView);
  });
}

// ============================================================
// ROLE SWITCH
// ============================================================
function setRole(role) {
  currentRole = role;
  document.querySelectorAll('.role-btn').forEach(b => b.classList.toggle('active', b.dataset.role === role));
  document.querySelectorAll('[data-role-section]').forEach(el => {
    el.style.display = el.dataset.roleSection === role || el.dataset.roleSection === 'all' ? '' : 'none';
  });
  renderMobileNav();
  closeSidebar();
  if (role === 'purchase') navigate('dashboard');
  if (role === 'warehouse') navigate('wh-search');
}

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Check API health
  try {
    const health = await fetch(`${API_BASE}/health`);
    if (!health.ok) throw new Error('Server not responding');
  } catch {
    document.getElementById('page-body').innerHTML = `
      <div class="alert alert-red" style="margin:40px auto;max-width:500px">
        <span class="alert-icon">❌</span>
        <div class="alert-body">
          <div class="alert-title">ไม่สามารถเชื่อมต่อ Server ได้</div>
          <p>กรุณารัน <code style="background:#fff3;padding:2px 6px;border-radius:4px">node server.js</code> แล้วรีเฟรช</p>
        </div>
      </div>`;
    return;
  }
  setRole('purchase');
});
