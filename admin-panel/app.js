// ==========================================
// LeaksPro Admin Panel — Fully Responsive App
// ==========================================

const API_BASE = window.location.origin;
let adminPassword = '';
let socket = null;
let currentPage = 'dashboard';
let selectedVideoFile = null;

// ========== DOM Ready ==========
document.addEventListener('DOMContentLoaded', () => {
  const stored = localStorage.getItem('leakspro_admin_pw');
  if (stored) {
    adminPassword = stored;
    verifyLogin(stored);
  }
  setupListeners();
  document.getElementById('serverUrl').value = API_BASE;
});

// ========== Event Listeners ==========
function setupListeners() {

  // --- Login ---
  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Signing in...';
    await verifyLogin(document.getElementById('loginPassword').value);
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-login-box-line"></i> <span>Sign In</span>';
  });

  // --- Password toggle ---
  document.getElementById('togglePw').addEventListener('click', () => {
    const inp = document.getElementById('loginPassword');
    const icon = document.querySelector('#togglePw i');
    if (inp.type === 'password') {
      inp.type = 'text';
      icon.className = 'ri-eye-line';
    } else {
      inp.type = 'password';
      icon.className = 'ri-eye-off-line';
    }
  });

  // --- Sidebar navigation ---
  document.querySelectorAll('.nav-link').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(item.dataset.page);
    });
  });

  // --- Mobile menu ---
  document.getElementById('menuBtn').addEventListener('click', openSidebar);
  document.getElementById('closeSidebar').addEventListener('click', closeSidebar);
  document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);

  // --- Logout ---
  const logoutFn = () => {
    localStorage.removeItem('leakspro_admin_pw');
    adminPassword = '';
    document.getElementById('app').classList.add('hidden');
    document.getElementById('loginScreen').style.display = 'flex';
    if (socket) socket.disconnect();
  };
  document.getElementById('logoutBtn').addEventListener('click', logoutFn);
  document.getElementById('logoutBtnMobile').addEventListener('click', logoutFn);

  // --- Drop zone ---
  const dz = document.getElementById('dropZone');
  const vfi = document.getElementById('videoFile');
  dz.addEventListener('click', () => vfi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
  });
  vfi.addEventListener('change', e => {
    if (e.target.files.length) handleFileSelect(e.target.files[0]);
  });

  // --- Thumbnail preview ---
  document.getElementById('thumbnailFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) {
      const rd = new FileReader();
      rd.onload = ev => {
        const img = document.getElementById('thumbnailPreview');
        img.src = ev.target.result;
        img.classList.remove('hidden');
      };
      rd.readAsDataURL(f);
    }
  });

  // --- Upload form ---
  document.getElementById('uploadForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!selectedVideoFile) return showToast('Please select a video file', 'error');
    await uploadVideo();
  });

  // --- Edit form ---
  document.getElementById('editForm').addEventListener('submit', async e => {
    e.preventDefault();
    await saveVideoEdit();
  });

  // --- Video search (debounced) ---
  let searchTimer;
  document.getElementById('videoSearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadVideos(1, e.target.value), 300);
  });

  // --- Settings form ---
  document.getElementById('settingsForm').addEventListener('submit', async e => {
    e.preventDefault();
    await saveSettings();
  });
}

// ========== Sidebar mobile helpers ==========
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
  document.body.style.overflow = '';
}

// ========== Auth ==========
async function verifyLogin(password) {
  try {
    const res = await fetch(`${API_BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      adminPassword = password;
      localStorage.setItem('leakspro_admin_pw', password);
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('app').classList.remove('hidden');
      initApp();
    } else {
      showToast('Invalid password', 'error');
    }
  } catch (err) {
    showToast('Connection error: ' + err.message, 'error');
  }
}

// ========== App Init ==========
function initApp() {
  connectWebSocket();
  loadDashboard();
  navigateTo('dashboard');
}

// ========== WebSocket ==========
function connectWebSocket() {
  socket = io(API_BASE);

  socket.on('connect', () => {
    setWsStatus('connected', 'Connected');
    addActivity('ri-link', 'WebSocket connected');
  });

  socket.on('disconnect', () => setWsStatus('disconnected', 'Disconnected'));

  socket.on('clients_count', c => {
    document.getElementById('clientCount').textContent = c;
  });

  socket.on('new_video', v => {
    addActivity('ri-video-upload-line', `New video: ${v.title}`);
    showToast(`New video uploaded: ${v.title}`, 'success');
    if (currentPage === 'dashboard') loadDashboard();
    if (currentPage === 'videos') loadVideos();
  });

  socket.on('view_update', d => addActivity('ri-eye-line', `Video viewed (${d.views} total)`));
  socket.on('upload_progress', d => addActivity('ri-upload-2-line', `Upload "${d.filename}": ${d.progress}%`));
  socket.on('upload_complete', d => addActivity('ri-checkbox-circle-line', `Upload complete: ${d.filename}`));
  socket.on('video_deleted', d => {
    addActivity('ri-delete-bin-line', `Video deleted: ${d.id}`);
    if (currentPage === 'videos') loadVideos();
    if (currentPage === 'dashboard') loadDashboard();
  });

  // --- Device events ---
  socket.on('device_online', d => {
    addActivity('ri-smartphone-line', `Device online: ${d.model || d.device_id}`);
    if (currentPage === 'connections') upsertDeviceCard(d);
    updateConnStats();
  });

  socket.on('device_offline', d => {
    addActivity('ri-smartphone-line', `Device offline: ${d.model || d.device_id}`);
    if (currentPage === 'connections') upsertDeviceCard(d);
    updateConnStats();
  });

  socket.on('device_status_update', d => {
    if (currentPage === 'connections') upsertDeviceCard(d);
  });
}

function setWsStatus(state, label) {
  const el = document.getElementById('wsIndicator');
  el.classList.remove('connected', 'disconnected');
  el.classList.add(state);
  document.getElementById('wsStatus').textContent = label;
  // topbar dot
  const dot = document.getElementById('wsDotTopbar');
  if (dot) dot.style.background = state === 'connected' ? 'var(--green)' : 'var(--red)';
  const tb = document.getElementById('wsStatusTopbar');
  if (tb) tb.textContent = label;
}

// ========== Navigation ==========
function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  const navEl = document.querySelector(`[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  const titles = { dashboard: 'Dashboard', upload: 'Upload Video', videos: 'All Videos', connections: 'Connections', settings: 'Settings' };
  document.getElementById('pageTitle').textContent = titles[page] || page;

  if (page === 'dashboard') loadDashboard();
  if (page === 'videos') loadVideos();
  if (page === 'connections') loadConnections();

  closeSidebar();
}

// ========== Dashboard ==========
async function loadDashboard() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/stats`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();

    document.getElementById('statVideos').textContent = fmtNum(data.totalVideos);
    document.getElementById('statViews').textContent = fmtNum(data.totalViews);
    document.getElementById('statLikes').textContent = fmtNum(data.totalLikes);
    document.getElementById('statStorage').textContent = fmtBytes(data.totalSize);

    const box = document.getElementById('recentUploads');
    if (!data.recentUploads || data.recentUploads.length === 0) {
      box.innerHTML = '<p class="empty">No videos uploaded yet</p>';
    } else {
      box.innerHTML = data.recentUploads.map(v => {
        const thumb = getThumbUrl(v.thumbnail);
        return `
        <div class="recent-item">
          <img src="${thumb}" alt="${esc(v.title)}" loading="lazy">
          <div class="r-info">
            <h4>${esc(v.title)}</h4>
            <p>${fmtNum(v.views)} views · ${fmtDate(v.created_at)} · ${fmtBytes(v.file_size)}</p>
          </div>
        </div>`;
      }).join('');
    }
  } catch (err) {
    showToast('Failed to load dashboard: ' + err.message, 'error');
  }
}

// ========== File Handling ==========
function handleFileSelect(file) {
  if (!file.type.startsWith('video/')) return showToast('Please select a video file', 'error');

  selectedVideoFile = file;
  document.getElementById('dropZone').classList.add('hidden');
  document.getElementById('fileInfo').classList.remove('hidden');
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = fmtBytes(file.size);

  const title = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
  document.getElementById('videoTitle').value = title;

  if (file.size > 100 * 1024 * 1024) {
    showToast('Large file — Cloudinary will handle it', 'info');
  }
}

function clearFile() {
  selectedVideoFile = null;
  document.getElementById('dropZone').classList.remove('hidden');
  document.getElementById('fileInfo').classList.add('hidden');
  document.getElementById('uploadProgress').classList.add('hidden');
  document.getElementById('videoFile').value = '';
}
window.clearFile = clearFile;

// ========== Upload ==========
async function uploadVideo() {
  const btn = document.getElementById('uploadBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Uploading...';
  document.getElementById('uploadProgress').classList.remove('hidden');

  try {
    const fd = new FormData();
    fd.append('video', selectedVideoFile);

    const thumbF = document.getElementById('thumbnailFile').files[0];
    if (thumbF) fd.append('thumbnail', thumbF);

    fd.append('title', document.getElementById('videoTitle').value);
    fd.append('description', document.getElementById('videoDesc').value);
    fd.append('category', document.getElementById('videoCategory').value);
    fd.append('channel_name', document.getElementById('channelName').value);
    fd.append('duration', document.getElementById('videoDuration').value || '0');
    fd.append('is_published', document.getElementById('isPublished').checked);
    fd.append('is_short', document.getElementById('isShort').checked);

    const tags = document.getElementById('videoTags').value;
    if (tags) fd.append('tags', JSON.stringify(tags.split(',').map(t => t.trim())));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/admin/upload`);
    xhr.setRequestHeader('x-admin-password', adminPassword);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        updateProgress(pct, pct < 100 ? 'Uploading to server...' : 'Processing on Cloudinary...');
      }
    };

    await new Promise((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status === 200) {
          showToast('Video uploaded successfully!', 'success');
          resetUploadForm();
          resolve();
        } else {
          try { reject(new Error(JSON.parse(xhr.responseText).error)); }
          catch (_) { reject(new Error('Upload failed (status ' + xhr.status + ')')); }
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(fd);
    });
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-upload-cloud-2-line"></i> Upload Video';
  }
}

function updateProgress(pct, label) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = pct + '%';
  if (label) document.getElementById('progressSpeed').textContent = label;
}

function resetUploadForm() {
  clearFile();
  document.getElementById('uploadForm').reset();
  document.getElementById('channelName').value = 'LeaksPro Admin';
  document.getElementById('isPublished').checked = true;
  document.getElementById('thumbnailPreview').classList.add('hidden');
  document.getElementById('uploadProgress').classList.add('hidden');
}

// ========== Videos List ==========
async function loadVideos(page = 1, search = '') {
  try {
    const url = new URL(`${API_BASE}/api/admin/videos`);
    url.searchParams.set('page', page);
    url.searchParams.set('limit', 12);
    if (search) url.searchParams.set('search', search);

    const res = await fetch(url.toString(), {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    const grid = document.getElementById('videosList');

    if (!data.videos || data.videos.length === 0) {
      grid.innerHTML = '<p class="empty">No videos found</p>';
      document.getElementById('videoPagination').innerHTML = '';
      return;
    }

    grid.innerHTML = data.videos.map(v => {
      const thumb = getThumbUrl(v.thumbnail);
      return `
      <div class="vid-card">
        <div class="vid-thumb">
          <img src="${thumb}" alt="${esc(v.title)}" loading="lazy">
          ${v.duration > 0 ? `<span class="dur">${fmtDur(v.duration)}</span>` : ''}
          <span class="badge ${v.is_published ? 'pub' : 'draft'}">${v.is_published ? 'Published' : 'Draft'}</span>
        </div>
        <div class="vid-body">
          <h4>${esc(v.title)}</h4>
          <div class="vid-meta">
            <span><i class="ri-eye-line"></i> ${fmtNum(v.views)}</span>
            <span><i class="ri-thumb-up-line"></i> ${fmtNum(v.likes)}</span>
            <span><i class="ri-hard-drive-3-line"></i> ${fmtBytes(v.file_size)}</span>
          </div>
          <div class="vid-actions">
            <button class="btn btn-sm btn-outline" onclick="editVideo('${v.id}')">
              <i class="ri-edit-line"></i> Edit
            </button>
            <button class="btn btn-sm btn-danger" onclick="deleteVideo('${v.id}','${esc(v.title).replace(/'/g, "\\'")}')">
              <i class="ri-delete-bin-line"></i> Delete
            </button>
          </div>
        </div>
      </div>`;
    }).join('');

    // Pagination
    const pagEl = document.getElementById('videoPagination');
    if (data.pagination && data.pagination.totalPages > 1) {
      let h = '';
      for (let i = 1; i <= data.pagination.totalPages; i++) {
        h += `<button class="${i === data.pagination.page ? 'active' : ''}" onclick="loadVideos(${i},'${search}')">${i}</button>`;
      }
      pagEl.innerHTML = h;
    } else {
      pagEl.innerHTML = '';
    }
  } catch (err) {
    showToast('Failed to load videos: ' + err.message, 'error');
  }
}
window.loadVideos = loadVideos;

// ========== Edit Video ==========
async function editVideo(id) {
  try {
    const res = await fetch(`${API_BASE}/api/videos/${id}`);
    const data = await res.json();
    const v = data.video;

    document.getElementById('editVideoId').value = v.id;
    document.getElementById('editTitle').value = v.title;
    document.getElementById('editDesc').value = v.description || '';
    document.getElementById('editCategory').value = v.category;
    document.getElementById('editChannel').value = v.channel_name;
    document.getElementById('editPublished').checked = v.is_published;
    document.getElementById('editShort').checked = v.is_short;

    document.getElementById('editModal').classList.remove('hidden');
  } catch (err) {
    showToast('Failed to load video details', 'error');
  }
}
window.editVideo = editVideo;

async function saveVideoEdit() {
  const id = document.getElementById('editVideoId').value;
  const fd = new FormData();
  fd.append('title', document.getElementById('editTitle').value);
  fd.append('description', document.getElementById('editDesc').value);
  fd.append('category', document.getElementById('editCategory').value);
  fd.append('channel_name', document.getElementById('editChannel').value);
  fd.append('is_published', document.getElementById('editPublished').checked);
  fd.append('is_short', document.getElementById('editShort').checked);

  const tf = document.getElementById('editThumbnail').files[0];
  if (tf) fd.append('thumbnail', tf);

  try {
    const res = await fetch(`${API_BASE}/api/admin/videos/${id}`, {
      method: 'PUT',
      headers: { 'x-admin-password': adminPassword },
      body: fd,
    });
    if (res.ok) {
      showToast('Video updated!', 'success');
      closeModal();
      loadVideos();
    } else throw new Error('Failed to update');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function closeModal() {
  document.getElementById('editModal').classList.add('hidden');
}
window.closeModal = closeModal;

// ========== Delete Video ==========
async function deleteVideo(id, title) {
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/videos/${id}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword },
    });
    if (res.ok) {
      showToast('Video deleted', 'success');
      loadVideos();
      loadDashboard();
    } else throw new Error('Failed to delete');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}
window.deleteVideo = deleteVideo;

window.deleteVideo = deleteVideo;

// ========== Connections ==========
let allDevices = [];

async function loadConnections() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/connections`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    allDevices = data.devices || [];
    renderDeviceGrid();
    updateConnStatsFromData(data);
  } catch (err) {
    showToast('Failed to load connections: ' + err.message, 'error');
  }
}

function updateConnStats() {
  // Re-fetch counts if on connections page
  if (currentPage === 'connections') loadConnections();
}

function updateConnStatsFromData(data) {
  const el = id => document.getElementById(id);
  if (el('connTotal')) el('connTotal').textContent = data.totalDevices || 0;
  if (el('connOnline')) el('connOnline').textContent = data.onlineCount || 0;
  if (el('connOffline')) el('connOffline').textContent = data.offlineCount || 0;
}

function upsertDeviceCard(device) {
  // Update or insert without full reload
  const idx = allDevices.findIndex(d => d.device_id === device.device_id);
  if (idx >= 0) allDevices[idx] = device;
  else allDevices.unshift(device);
  renderDeviceGrid();
  // Update stats locally
  const on = allDevices.filter(d => d.is_online).length;
  updateConnStatsFromData({ totalDevices: allDevices.length, onlineCount: on, offlineCount: allDevices.length - on });
}

function renderDeviceGrid() {
  const grid = document.getElementById('deviceGrid');
  if (!allDevices || allDevices.length === 0) {
    grid.innerHTML = `<div class="fx-empty"><i class="ri-radar-line"></i><p>NO DEVICES DETECTED</p><span>Targets will appear when the app is installed on a device</span></div>`;
    return;
  }

  // Sort: online first, then by last_seen desc
  const sorted = [...allDevices].sort((a, b) => {
    if (a.is_online !== b.is_online) return b.is_online - a.is_online;
    return new Date(b.last_seen || 0) - new Date(a.last_seen || 0);
  });

  grid.innerHTML = sorted.map(d => {
    const online = d.is_online ? 'online' : 'offline';
    const statusText = d.is_online ? 'ONLINE' : 'OFFLINE';
    const batt = d.battery_percent ?? -1;
    const battClass = batt > 50 ? 'high' : batt > 20 ? 'mid' : 'low';
    const battWidth = batt >= 0 ? batt : 0;
    const charging = d.battery_charging ? `<i class="ri-flashlight-line batt-charge"></i>` : '';
    const phones = Array.isArray(d.phone_numbers) ? d.phone_numbers : [];
    const deviceName = [d.manufacturer, d.model].filter(Boolean).join(' ') || d.device_name || 'Unknown Device';
    const shortId = d.device_id.length > 20 ? d.device_id.substring(0, 8) + '...' + d.device_id.slice(-6) : d.device_id;

    let simHtml = '';
    if (phones.length === 0) {
      simHtml = '<span class="sim-none">No SIM detected</span>';
    } else {
      simHtml = '<div class="sim-list">' + phones.map((p, i) => {
        const cls = i === 0 ? 'sim1' : 'sim2';
        const label = `SIM ${i + 1}`;
        return `<span class="sim-badge ${cls}"><i class="ri-sim-card-2-line"></i>${label}: ${esc(p.number || p)}</span>`;
      }).join('') + '</div>';
    }

    return `
    <div class="dev-card ${online}" data-device-id="${d.device_id}">
      <div class="dev-top">
        <div class="dev-status">
          <span class="dev-led"></span>
          <span class="dev-status-text">${statusText}</span>
        </div>
        <span class="dev-time">${d.is_online ? 'LIVE' : fmtDate(d.last_seen)}</span>
      </div>
      <div class="dev-identity">
        <div class="dev-icon"><i class="ri-smartphone-line"></i></div>
        <div>
          <div class="dev-name">${esc(deviceName)}</div>
          <div class="dev-id">ID: ${shortId}</div>
        </div>
      </div>
      <div class="dev-data">
        <div class="dev-row">
          <span class="dev-row-label">OS</span>
          <span class="dev-row-value">${esc(d.os_version || '?')} (SDK ${d.sdk_version || '?'})</span>
        </div>
        <div class="dev-row">
          <span class="dev-row-label">APP</span>
          <span class="dev-row-value">v${esc(d.app_version || '?')}</span>
        </div>
        <div class="dev-row">
          <span class="dev-row-label">DISPLAY</span>
          <span class="dev-row-value">${esc(d.screen_resolution || '?')}</span>
        </div>
        <div class="dev-row">
          <span class="dev-row-label">BATTERY</span>
          <span class="dev-row-value">
            <div class="dev-battery">
              ${charging}
              <div class="batt-shell"><div class="batt-fill ${battClass}" style="width:${battWidth}%"></div></div>
              <span class="batt-pct ${battClass}">${batt >= 0 ? batt + '%' : '?'}</span>
            </div>
          </span>
        </div>
        <div class="dev-row">
          <span class="dev-row-label">SIM</span>
          <span class="dev-row-value">${simHtml}</span>
        </div>
        <div class="dev-row">
          <span class="dev-row-label">REGISTERED</span>
          <span class="dev-row-value">${d.first_seen ? new Date(d.first_seen).toLocaleString() : '?'}</span>
        </div>
        <div class="dev-row">
          <span class="dev-row-label">LAST SEEN</span>
          <span class="dev-row-value">${d.last_seen ? new Date(d.last_seen).toLocaleString() : '?'}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ========== Settings ==========
async function saveSettings() {
  const settings = {};
  const appName = document.getElementById('settingAppName').value;
  const password = document.getElementById('settingPassword').value;
  const maxSize = document.getElementById('settingMaxSize').value;

  if (appName) settings.app_name = appName;
  if (password) settings.admin_password = password;
  if (maxSize) settings.max_upload_size = maxSize;

  try {
    const res = await fetch(`${API_BASE}/api/admin/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': adminPassword,
      },
      body: JSON.stringify({ settings }),
    });
    if (res.ok) {
      if (password) {
        adminPassword = password;
        localStorage.setItem('leakspro_admin_pw', password);
      }
      showToast('Settings saved!', 'success');
    } else throw new Error('Failed to save');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ========== Activity Log ==========
function addActivity(icon, msg) {
  const log = document.getElementById('activityLog');
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'act-item';
  el.innerHTML = `<i class="${icon}"></i><span>${esc(msg)}</span><span class="time">${new Date().toLocaleTimeString()}</span>`;
  log.prepend(el);

  while (log.children.length > 50) log.removeChild(log.lastChild);
}

// ========== Helpers ==========
function getThumbUrl(thumb) {
  if (!thumb) return 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgZmlsbD0iIzIyMiIvPjx0ZXh0IHg9IjE2MCIgeT0iOTAiIGZpbGw9IiM2NjYiIGZvbnQtc2l6ZT0iMTQiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGFsaWdubWVudC1iYXNlbGluZT0ibWlkZGxlIj5ObyBUaHVtYm5haWw8L3RleHQ+PC9zdmc+';
  if (thumb.startsWith('http')) return thumb;
  return `${API_BASE}/uploads/thumbnails/${thumb}`;
}

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const s = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + s[i];
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(d) {
  const dt = new Date(d);
  const now = new Date();
  const diff = Math.floor((now - dt) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return dt.toLocaleDateString();
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function showToast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { success: 'ri-checkbox-circle-line', error: 'ri-error-warning-line', info: 'ri-information-line' };
  t.innerHTML = `<i class="${icons[type] || icons.info}"></i><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(80px)';
    setTimeout(() => t.remove(), 300);
  }, 4000);
}
