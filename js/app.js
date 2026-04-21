// ============================================================
// PO Tracking & Warehouse Management System
// API-backed version (Node.js + MySQL)
// ============================================================

// const API_BASE = 'http://localhost:4002/api';
const API_BASE = '/api';

// --- State ---
let currentRole = 'purchase';
let currentView = 'dashboard';
let editingPO = null;    // full PO object with items + logs
let receivingPO = null;
let dashFilter = { year: '', month: '', logistics_company: '', shipping_method: '' };

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
  body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:300px;gap:12px;color:#64748b">
    <div style="width:32px;height:32px;border:3px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;animation:spin .6s linear infinite"></div>
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
      case 'create-po':  renderCreatePO(body, topbar); break;
      case 'po-detail':  await renderPODetail(body, topbar); break;
      case 'wh-search':  await renderWHSearch(body, topbar); break;
      case 'wh-receive': await renderWHReceive(body, topbar); break;
      default:           await renderDashboard(body, topbar);
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
  dashFilter.year              = document.getElementById('dash-year')?.value     || '';
  dashFilter.month             = document.getElementById('dash-month')?.value    || '';
  dashFilter.logistics_company = document.getElementById('dash-logistics')?.value || '';
  dashFilter.shipping_method   = document.getElementById('dash-method')?.value   || '';
  renderView('dashboard');
}
function clearDashFilter() {
  dashFilter = { year: '', month: '', logistics_company: '', shipping_method: '' };
  renderView('dashboard');
}
function exportDashboard() {
  const p = new URLSearchParams();
  if (dashFilter.year)              p.set('year',              dashFilter.year);
  if (dashFilter.month)             p.set('month',             dashFilter.month);
  if (dashFilter.logistics_company) p.set('logistics_company', dashFilter.logistics_company);
  if (dashFilter.shipping_method)   p.set('shipping_method',   dashFilter.shipping_method);
  window.location.href = `${API_BASE}/export?${p.toString()}`;
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

  const hasFilter = dashFilter.year || dashFilter.month || dashFilter.logistics_company || dashFilter.shipping_method;
  const filterBar = `
    <div class="card" style="padding:14px 20px;margin-bottom:20px">
      <div class="filter-row" style="flex-wrap:wrap;gap:10px;align-items:center">
        <span style="font-size:13px;font-weight:600;color:#374151">🔽 ตัวกรอง</span>
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
  if (dashFilter.year)  filtered = filtered.filter(p => p.order_date && p.order_date.startsWith(dashFilter.year));
  if (dashFilter.month) {
    const m = String(dashFilter.month).padStart(2, '0');
    filtered = filtered.filter(p => p.order_date && p.order_date.substring(5, 7) === m);
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
    return `<tr class="${overdue ? 'overdue-row' : ''}" style="cursor:pointer" onclick="viewPODetail('${po.po_number}')">
      <td><span class="po-number-tag">${po.po_number}</span>${logBadge}</td>
      <td>${po.project_name}</td>
      <td>${statusBadge(po.status, overdue)}</td>
      <td class="td-muted">${formatDate(po.departure_date)}</td>
      <td>${eta ? `<div class="eta-bar"><div class="eta-progress"><div class="eta-progress-fill" style="width:${progress}%;background:${overdue ? '#ef4444' : progress > 80 ? '#f59e0b' : '#3b82f6'}"></div></div><span class="eta-text" style="color:${overdue ? '#dc2626' : ''}">${formatDate(eta)}</span></div>` : '<span class="text-muted">ยังไม่ระบุ</span>'}</td>
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
        <div class="stat-card-value" style="color:${overdueList.length ? '#dc2626' : '#1e293b'}">${overdueList.length}</div>
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
          <input type="text" id="search-po" placeholder="ค้นหา PO Number, Project หรือ SKU..." oninput="applyPOListFilter()">
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
  const q = (document.getElementById('search-po')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('filter-status')?.value || '';
  let headers = [..._allPOHeaders];

  // Filter by status
  if (statusFilter === '__overdue__') headers = headers.filter(p => isOverdue(p));
  else if (statusFilter) headers = headers.filter(p => p.status === statusFilter);

  // Filter by search query (PO number, project, OR sku)
  let matchedSkus = {}; // { po_number: [matched skus] }
  if (q) {
    headers = headers.filter(p => {
      const inHeader = p.po_number.toLowerCase().includes(q) || p.project_name.toLowerCase().includes(q);
      const skuMatches = (p.skus || []).filter(s => s.toLowerCase().includes(q));
      if (skuMatches.length) matchedSkus[p.po_number] = skuMatches;
      return inHeader || skuMatches.length > 0;
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

  const itemRows = items.map(item => {
    const log = logs.find(l => l.sku === item.sku);
    const hasReceive = log && log.receive_qty > 0;
    const hasQC = qcDone(log);
    return `<tr>
      <td class="font-mono">${item.sku}</td>
      <td class="text-right">${item.order_qty.toLocaleString()}</td>
      <td class="text-right">${hasReceive ? log.receive_qty.toLocaleString() : '<span class="text-muted">-</span>'}</td>
      <td class="text-right">${hasReceive ? diffChip(item.order_qty, log.receive_qty) : '<span class="text-muted">-</span>'}</td>
      <td class="text-right">${hasQC ? `<span style="color:#059669;font-weight:600">${log.pass_qc_qty}</span>` : '<span class="text-muted">รอ QC</span>'}</td>
      <td class="text-right">${hasQC ? (log.not_pass_qc_qty > 0 ? `<span style="color:#dc2626;font-weight:600">${log.not_pass_qc_qty}</span>` : '<span style="color:#059669">0</span>') : '<span class="text-muted">-</span>'}</td>
      <td class="text-sm text-muted">${item.remark_purchase || ''}</td>
      <td class="text-sm text-muted">${log?.remark_warehouse || ''}</td>
    </tr>`;
  }).join('');

  const etaBar = eta ? `<div class="eta-bar" style="margin-top:8px"><div class="eta-progress"><div class="eta-progress-fill" style="width:${etaProgress(po)}%;background:${overdue ? '#ef4444' : '#3b82f6'}"></div></div><span class="eta-text">${etaProgress(po)}%</span></div>` : '';

  body.innerHTML = `
    ${overdue ? `<div class="alert alert-red"><span class="alert-icon">🚨</span><div class="alert-body"><div class="alert-title">PO นี้เลยกำหนด ETA แล้ว!</div><p>ETA: ${formatDate(eta)}</p></div></div>` : ''}
    <div class="card">
      <div class="card-header"><div class="card-title">🗺 สถานะการขนส่ง</div>${statusBadge(po.status, overdue)}</div>
      <div class="status-progress">${stepsHTML}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;margin-top:20px;padding-top:20px;border-top:1px solid #e2e8f0">
        <div><label style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;display:block;margin-bottom:3px">PO Number</label><span class="po-number-tag">${po.po_number}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;display:block;margin-bottom:3px">Project</label><span style="font-weight:600">${po.project_name}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;display:block;margin-bottom:3px">Order Date</label><span>${formatDate(po.order_date)}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;display:block;margin-bottom:3px">บริษัทขนส่ง</label><span>${po.logistics_company || '<span class="text-muted">-</span>'}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;display:block;margin-bottom:3px">วิธีขนส่ง</label><span>${po.shipping_method ? (po.shipping_method === 'รถ' ? '🚛 รถ' : '🚢 เรือ') : '<span class="text-muted">-</span>'}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;display:block;margin-bottom:3px">Departure</label><span>${formatDate(po.departure_date)}</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;display:block;margin-bottom:3px">Lead Time</label><span>${po.est_lead_time} วัน</span></div>
        <div><label style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600;display:block;margin-bottom:3px">ETA</label><span style="color:${overdue ? '#dc2626' : '#1e293b'};font-weight:${overdue ? '700' : '400'}">${formatDate(eta)}</span>${etaBar}</div>
      </div>
    </div>
    <div class="card p-0">
      <div class="card-header" style="padding:20px 24px 16px">
        <div><div class="card-title">📦 รายการสินค้า (${items.length} SKU)</div><div class="card-subtitle">เปรียบเทียบสั่ง vs รับจริง vs QC</div></div>
      </div>
      <div class="table-wrap" style="border:none;border-top:1px solid #e2e8f0">
        <table>
          <thead><tr><th>SKU</th><th style="text-align:right">Order QTY</th><th style="text-align:right">Receive QTY</th><th style="text-align:right">Check Diff</th><th style="text-align:right">Pass QC</th><th style="text-align:right">Not Pass</th><th>หมายเหตุจัดซื้อ</th><th>หมายเหตุคลัง</th></tr></thead>
          <tbody>${itemRows || `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📦</div><p>ยังไม่มีรายการสินค้า</p></div></td></tr>`}</tbody>
        </table>
      </div>
    </div>
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
function renderCreatePO(body, topbar) {
  topbar.innerHTML = `
    <div class="topbar-left"><h2>➕ สร้าง PO ใหม่</h2></div>
    <div class="topbar-right"><button class="btn-secondary" onclick="navigate('po-list')">ยกเลิก</button></div>`;

  const year = new Date().getFullYear();
  const suggestedPN = `PO-${year}-001`;

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
          <input class="form-control" id="f-project" placeholder="เช่น Muslin Pajamas Summer 2026">
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
      <div class="items-table-wrap">
        <table>
          <thead><tr><th style="width:40px">#</th><th>SKU</th><th style="width:140px">Order QTY</th><th>หมายเหตุ</th><th style="width:50px"></th></tr></thead>
          <tbody id="temp-items-body">
            <tr id="temp-item-0">
              <td class="td-muted">1</td>
              <td><input class="form-control" placeholder="เช่น MP-BJM-001-S" style="border:none;padding:4px 0"></td>
              <td><input class="form-control" type="number" placeholder="0" min="0" style="border:none;padding:4px 0" oninput="calcTotal()"></td>
              <td><input class="form-control" placeholder="หมายเหตุ" style="border:none;padding:4px 0"></td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <div class="add-item-row"><span class="text-sm text-muted">รวม: <strong id="total-qty">0</strong> ชิ้น จาก <strong id="total-sku">0</strong> SKU</span></div>
      </div>
    </div>
    <div class="flex gap-3" style="justify-content:flex-end">
      <button class="btn-secondary" onclick="navigate('po-list')">ยกเลิก</button>
      <button class="btn-primary" onclick="savePO('Draft')">💾 บันทึกเป็น Draft</button>
      <button class="btn-primary" style="background:#059669" onclick="savePO('Ordered')">✅ บันทึก & สั่งซื้อ</button>
    </div>`;

  tempItemCount = 1; calcTotal();
}

let tempItemCount = 1;
function addTempItem() {
  const idx = tempItemCount++;
  const tbody = document.getElementById('temp-items-body');
  const tr = document.createElement('tr');
  tr.id = `temp-item-${idx}`;
  tr.innerHTML = `
    <td class="td-muted">${idx + 1}</td>
    <td><input class="form-control" placeholder="SKU" style="border:none;padding:4px 0"></td>
    <td><input class="form-control" type="number" placeholder="0" min="0" style="border:none;padding:4px 0" oninput="calcTotal()"></td>
    <td><input class="form-control" placeholder="หมายเหตุ" style="border:none;padding:4px 0"></td>
    <td><button style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:18px">✕</button></td>`;
  tr.querySelector('button').onclick = () => { tr.remove(); calcTotal(); };
  tbody.appendChild(tr);
  calcTotal();
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

  const rows = document.querySelectorAll('#temp-items-body tr');
  const items = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const sku = inputs[0]?.value.trim();
    const order_qty = parseInt(inputs[1]?.value || '0');
    const remark_purchase = inputs[2]?.value.trim();
    if (sku && order_qty > 0) items.push({ sku, order_qty, remark_purchase: remark_purchase || '' });
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
  const status           = document.getElementById('edit-status').value;
  const departure_date   = document.getElementById('edit-departure').value || null;
  const logistics_company = document.getElementById('edit-logistics-company')?.value || null;
  const shipping_method  = document.getElementById('edit-shipping-method')?.value || null;
  const est_lead_time    = parseInt(document.getElementById('edit-leadtime').value);
  try {
    await API.put(`/po/${po.po_number}`, { status, departure_date, logistics_company, shipping_method, est_lead_time });
    hideModal('edit-status-modal');
    toast(`อัปเดต ${po.po_number} → ${STATUS_LABELS[status]} สำเร็จ`, 'success');
    // Refresh data
    _allPOHeaders = await API.get('/po');
    editingPO = _allPOHeaders.find(p => p.po_number === po.po_number) || editingPO;
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
  const q = document.getElementById('wh-search-input').value.trim().toLowerCase();
  const resultsEl = document.getElementById('wh-search-results');
  if (!q) { resultsEl.innerHTML = ''; return; }
  const matches = _allPOHeaders.filter(p => p.po_number.toLowerCase().includes(q) || p.project_name.toLowerCase().includes(q)).slice(0, 5);
  if (!matches.length) { resultsEl.innerHTML = `<div class="alert alert-amber"><span class="alert-icon">⚠</span><div class="alert-body"><p>ไม่พบ PO ที่ตรงกับ "${q}"</p></div></div>`; return; }
  resultsEl.innerHTML = matches.map(po => `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;margin-bottom:8px;display:flex;align-items:center;gap:12px;cursor:pointer" onclick="goReceive('${po.po_number}')" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
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
let photoFiles = {}; // {idx: [File, ...]}

async function renderWHReceive(body, topbar) {
  let po = receivingPO;
  if (!po) { navigate('wh-search'); return; }
  // Refresh
  po = await API.get(`/po/${po.po_number}`);
  receivingPO = po;

  const items = po.items || [];
  const logs = po.logs || [];
  photoFiles = {};

  topbar.innerHTML = `
    <div class="topbar-left"><h2>📦 รับสินค้า & QC</h2><p><span class="po-number-tag">${po.po_number}</span> — ${po.project_name}</p></div>
    <div class="topbar-right"><button class="btn-secondary" onclick="navigate('wh-search')">← กลับ</button></div>`;

  const itemForms = items.map((item, idx) => {
    const log = logs.find(l => l.sku === item.sku);
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header" style="margin-bottom:16px">
          <div><div class="card-title font-mono">${item.sku}</div><div class="text-sm text-muted">${item.remark_purchase || 'ไม่มีหมายเหตุ'}</div></div>
          <div class="qty-block"><span class="qty-main">${item.order_qty.toLocaleString()}</span><span class="qty-sub">Order QTY</span></div>
        </div>
        <div class="form-grid form-grid-3">
          <div class="form-group">
            <label>วันที่รับสินค้า <span style="color:#ef4444">*</span></label>
            <input class="form-control" type="date" id="arrived-${idx}"
              value="${log?.arrived_date ? log.arrived_date.substring(0,10) : today()}">
          </div>
          <div class="form-group">
            <label>จำนวนนับได้จริง <span style="color:#ef4444">*</span></label>
            <input class="form-control" type="number" id="receive-qty-${idx}" placeholder="0" min="0"
              value="${log && log.receive_qty > 0 ? log.receive_qty : ''}"
              oninput="calcQC(${idx}, ${item.order_qty})">
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
        <div class="form-group mt-3">
          <label>รูปภาพหลักฐาน</label>
          <div class="photo-upload-area" onclick="document.getElementById('photo-upload-${idx}').click()"
            ondragover="event.preventDefault();this.classList.add('drag')" ondragleave="this.classList.remove('drag')"
            ondrop="handleDrop(event,${idx})">
            <input type="file" id="photo-upload-${idx}" accept="image/*" multiple onchange="handlePhotoUpload(this,${idx})" style="display:none">
            <div class="upload-icon">📷</div>
            <p>คลิกหรือลากวางรูปที่นี่</p>
            <small>JPG, PNG, WEBP — ไม่เกิน 5MB</small>
          </div>
          <div class="photo-preview-grid" id="photo-preview-${idx}"></div>
          ${log?.photo_url ? `<div class="text-sm text-muted mt-3">📎 รูปที่บันทึกแล้ว: ${log.photo_url}</div>` : ''}
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
      <button class="btn-primary" id="save-receiving-btn" style="background:#059669" onclick="saveReceiving()">💾 บันทึกการรับสินค้าทั้งหมด</button>
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

function handlePhotoUpload(input, idx) {
  if (!photoFiles[idx]) photoFiles[idx] = [];
  photoFiles[idx].push(...Array.from(input.files));
  renderPhotoPreviews(idx);
}
function handleDrop(event, idx) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag');
  if (!photoFiles[idx]) photoFiles[idx] = [];
  photoFiles[idx].push(...Array.from(event.dataTransfer.files).filter(f => f.type.startsWith('image/')));
  renderPhotoPreviews(idx);
}
function renderPhotoPreviews(idx) {
  const grid = document.getElementById(`photo-preview-${idx}`); if (!grid) return;
  grid.innerHTML = (photoFiles[idx] || []).map((f, i) => {
    const url = URL.createObjectURL(f);
    return `<div class="photo-preview-item"><img src="${url}"><button class="remove-photo" onclick="removePhoto(${idx},${i})">✕</button></div>`;
  }).join('');
}
function removePhoto(idx, i) { photoFiles[idx].splice(i, 1); renderPhotoPreviews(idx); }

async function saveReceiving() {
  const po = receivingPO; if (!po) return;
  const items = po.items || [];
  const new_status = document.getElementById('wh-status-update')?.value || po.status;
  const btn = document.getElementById('save-receiving-btn');

  // Upload photos first
  const uploadedUrls = {};
  for (let idx = 0; idx < items.length; idx++) {
    const files = photoFiles[idx] || [];
    if (files.length) {
      try {
        const result = await API.uploadPhotos(files);
        uploadedUrls[idx] = result.urls.join(', ');
      } catch { uploadedUrls[idx] = ''; }
    }
  }

  const logs = [];
  let hasData = false;
  items.forEach((item, idx) => {
    const arrived_date = document.getElementById(`arrived-${idx}`)?.value;
    const receive_qty = parseInt(document.getElementById(`receive-qty-${idx}`)?.value || '0');
    const pass_qc_qty = parseInt(document.getElementById(`pass-qc-${idx}`)?.value || '0');
    const not_pass_qc_qty = parseInt(document.getElementById(`not-pass-qc-${idx}`)?.value || '0');
    const remark_warehouse = document.getElementById(`remark-wh-${idx}`)?.value.trim();
    const photo_url = uploadedUrls[idx] || '';
    if (receive_qty > 0) {
      hasData = true;
      logs.push({ sku: item.sku, arrived_date: arrived_date || today(), receive_qty, pass_qc_qty, not_pass_qc_qty, photo_url, remark_warehouse: remark_warehouse || '' });
    }
  });

  if (!hasData) { toast('กรุณากรอกจำนวนรับสินค้าอย่างน้อย 1 รายการ', 'error'); return; }

  try {
    if (btn) { btn.disabled = true; btn.textContent = 'กำลังบันทึก...'; }
    await API.post('/receiving', { po_number: po.po_number, logs, new_status });
    photoFiles = {};
    toast(`บันทึกการรับสินค้า ${po.po_number} สำเร็จ!`, 'success');
    navigate('wh-search');
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💾 บันทึกการรับสินค้าทั้งหมด'; }
  }
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
