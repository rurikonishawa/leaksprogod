// ==========================================
// LeaksPro Admin Panel - Frontend Application
// ==========================================

const API_BASE = window.location.origin;
let adminPassword = '';
let socket = null;
let uploadMode = 'standard'; // 'standard' or 'chunked'
let currentPage = 'dashboard';
let selectedVideoFile = null;

// ========== Initialization ==========
document.addEventListener('DOMContentLoaded', () => {
  // Check stored password
  const stored = localStorage.getItem('leakspro_admin_pw');
  if (stored) {
    adminPassword = stored;
    verifyLogin(stored);
  }

  setupEventListeners();
  document.getElementById('serverUrl').value = API_BASE;
});

function setupEventListeners() {
  // Login form
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('loginPassword').value;
    await verifyLogin(pw);
  });

  // Sidebar navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      navigateTo(page);
    });
  });

  // Sidebar toggle (mobile)
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.toggle('open');
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('leakspro_admin_pw');
    adminPassword = '';
    document.getElementById('app').classList.add('hidden');
    document.getElementById('loginOverlay').style.display = 'flex';
    if (socket) socket.disconnect();
  });

  // Drop zone
  const dropZone = document.getElementById('dropZone');
  const videoFileInput = document.getElementById('videoFile');

  dropZone.addEventListener('click', () => videoFileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  });

  videoFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
  });

  // Thumbnail preview
  document.getElementById('thumbnailFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const preview = document.getElementById('thumbnailPreview');
        preview.src = ev.target.result;
        preview.classList.remove('hidden');
      };
      reader.readAsDataURL(file);
    }
  });

  // Upload form
  document.getElementById('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedVideoFile) return showToast('Please select a video file', 'error');
    await uploadVideo();
  });

  // Edit form
  document.getElementById('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveVideoEdit();
  });

  // Video search
  let searchTimeout;
  document.getElementById('videoSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadVideos(1, e.target.value), 300);
  });

  // Settings form
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSettings();
  });
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
      document.getElementById('loginOverlay').style.display = 'none';
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
    const wsEl = document.querySelector('.ws-status');
    wsEl.classList.add('connected');
    wsEl.classList.remove('disconnected');
    document.getElementById('wsStatus').textContent = 'Connected';
    addActivity('ri-link', 'WebSocket connected');
  });

  socket.on('disconnect', () => {
    const wsEl = document.querySelector('.ws-status');
    wsEl.classList.remove('connected');
    wsEl.classList.add('disconnected');
    document.getElementById('wsStatus').textContent = 'Disconnected';
  });

  socket.on('clients_count', (count) => {
    document.getElementById('clientCount').textContent = count;
  });

  socket.on('new_video', (video) => {
    addActivity('ri-video-upload-line', `New video: ${video.title}`);
    showToast(`New video uploaded: ${video.title}`, 'success');
    if (currentPage === 'dashboard') loadDashboard();
    if (currentPage === 'videos') loadVideos();
  });

  socket.on('view_update', (data) => {
    addActivity('ri-eye-line', `Video viewed (${data.views} total views)`);
  });

  socket.on('upload_progress', (data) => {
    addActivity('ri-upload-2-line', `Upload "${data.filename}": ${data.progress}%`);
  });

  socket.on('upload_complete', (data) => {
    addActivity('ri-checkbox-circle-line', `Upload complete: ${data.filename}`);
  });

  socket.on('video_deleted', (data) => {
    addActivity('ri-delete-bin-line', `Video deleted: ${data.id}`);
    if (currentPage === 'videos') loadVideos();
    if (currentPage === 'dashboard') loadDashboard();
  });
}

// ========== Navigation ==========
function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelector(`[data-page="${page}"]`).classList.add('active');

  const titles = { dashboard: 'Dashboard', upload: 'Upload Video', videos: 'All Videos', settings: 'Settings' };
  document.getElementById('pageTitle').textContent = titles[page] || page;

  // Load page data
  if (page === 'dashboard') loadDashboard();
  if (page === 'videos') loadVideos();

  // Close mobile sidebar
  document.querySelector('.sidebar').classList.remove('open');
}

// ========== Dashboard ==========
async function loadDashboard() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/stats`, {
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();

    document.getElementById('statVideos').textContent = formatNumber(data.totalVideos);
    document.getElementById('statViews').textContent = formatNumber(data.totalViews);
    document.getElementById('statLikes').textContent = formatNumber(data.totalLikes);
    document.getElementById('statStorage').textContent = formatBytes(data.totalSize);

    // Recent uploads
    const recentEl = document.getElementById('recentUploads');
    if (data.recentUploads.length === 0) {
      recentEl.innerHTML = '<p class="empty-state">No videos uploaded yet</p>';
    } else {
      recentEl.innerHTML = data.recentUploads.map(v => `
        <div class="video-list-item">
          <img src="${v.thumbnail ? `/uploads/thumbnails/${v.thumbnail}` : 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTIwIiBoZWlnaHQ9IjY4IiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iNjgiIGZpbGw9IiMzMzMiLz48dGV4dCB4PSI2MCIgeT0iMzQiIGZpbGw9IiM4ODgiIGZvbnQtc2l6ZT0iMTIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGFsaWdubWVudC1iYXNlbGluZT0ibWlkZGxlIj5ObyBUaHVtYjwvdGV4dD48L3N2Zz4='}" alt="${v.title}">
          <div class="info">
            <h4>${escapeHtml(v.title)}</h4>
            <p>${formatNumber(v.views)} views · ${formatDate(v.created_at)} · ${formatBytes(v.file_size)}</p>
          </div>
        </div>
      `).join('');
    }
  } catch (err) {
    showToast('Failed to load dashboard: ' + err.message, 'error');
  }
}

// ========== File Handling ==========
function handleFileSelect(file) {
  if (!file.type.startsWith('video/')) {
    return showToast('Please select a video file', 'error');
  }

  selectedVideoFile = file;
  document.getElementById('dropZone').classList.add('hidden');
  document.getElementById('fileInfo').classList.remove('hidden');
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatBytes(file.size);

  // Auto-fill title from filename
  const title = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
  document.getElementById('videoTitle').value = title;

  // Suggest chunked mode for large files
  if (file.size > 100 * 1024 * 1024) { // > 100MB
    setUploadMode('chunked');
    showToast('Large file detected - switched to chunked upload for better speed', 'info');
  }
}

function clearFile() {
  selectedVideoFile = null;
  document.getElementById('dropZone').classList.remove('hidden');
  document.getElementById('fileInfo').classList.add('hidden');
  document.getElementById('uploadProgress').classList.add('hidden');
  document.getElementById('videoFile').value = '';
}

function setUploadMode(mode) {
  uploadMode = mode;
  document.getElementById('modeStandard').classList.toggle('active', mode === 'standard');
  document.getElementById('modeChunked').classList.toggle('active', mode === 'chunked');
}
// Make it globally accessible
window.setUploadMode = setUploadMode;

// ========== Upload ==========
async function uploadVideo() {
  const btn = document.getElementById('uploadBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line"></i> Uploading...';

  document.getElementById('uploadProgress').classList.remove('hidden');

  try {
    if (uploadMode === 'chunked') {
      await chunkedUpload();
    } else {
      await standardUpload();
    }
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ri-upload-cloud-2-line"></i> Upload Video';
  }
}

async function standardUpload() {
  const formData = new FormData();
  formData.append('video', selectedVideoFile);

  const thumbnailFile = document.getElementById('thumbnailFile').files[0];
  if (thumbnailFile) formData.append('thumbnail', thumbnailFile);

  formData.append('title', document.getElementById('videoTitle').value);
  formData.append('description', document.getElementById('videoDesc').value);
  formData.append('category', document.getElementById('videoCategory').value);
  formData.append('channel_name', document.getElementById('channelName').value);
  formData.append('duration', document.getElementById('videoDuration').value || '0');
  formData.append('is_published', document.getElementById('isPublished').checked);
  formData.append('is_short', document.getElementById('isShort').checked);

  const tags = document.getElementById('videoTags').value;
  if (tags) formData.append('tags', JSON.stringify(tags.split(',').map(t => t.trim())));

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/api/admin/upload`);
  xhr.setRequestHeader('x-admin-password', adminPassword);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      updateProgress(pct);
    }
  };

  return new Promise((resolve, reject) => {
    xhr.onload = () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        showToast('Video uploaded successfully!', 'success');
        resetUploadForm();
        resolve(data);
      } else {
        reject(new Error(JSON.parse(xhr.responseText).error || 'Upload failed'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(formData);
  });
}

async function chunkedUpload() {
  const file = selectedVideoFile;
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
  const startTime = Date.now();

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    const formData = new FormData();
    formData.append('chunk', chunk, `chunk_${i}`);
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', String(i).padStart(6, '0'));
    formData.append('totalChunks', totalChunks.toString());
    formData.append('filename', file.name);
    formData.append('originalName', file.name);

    const res = await fetch(`${API_BASE}/api/admin/upload/chunk`, {
      method: 'POST',
      headers: { 'x-admin-password': adminPassword },
      body: formData,
    });

    if (!res.ok) throw new Error('Chunk upload failed');

    const progress = Math.round(((i + 1) / totalChunks) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const speed = (start + (end - start)) / elapsed;
    updateProgress(progress, formatBytes(speed) + '/s');

    const data = await res.json();

    if (data.complete) {
      // Finalize with metadata
      const metaForm = new FormData();
      metaForm.append('filename', data.filename);
      metaForm.append('title', document.getElementById('videoTitle').value);
      metaForm.append('description', document.getElementById('videoDesc').value);
      metaForm.append('category', document.getElementById('videoCategory').value);
      metaForm.append('channel_name', document.getElementById('channelName').value);
      metaForm.append('duration', document.getElementById('videoDuration').value || '0');
      metaForm.append('is_published', document.getElementById('isPublished').checked);
      metaForm.append('is_short', document.getElementById('isShort').checked);
      metaForm.append('file_size', file.size.toString());

      const tags = document.getElementById('videoTags').value;
      if (tags) metaForm.append('tags', JSON.stringify(tags.split(',').map(t => t.trim())));

      const thumbFile = document.getElementById('thumbnailFile').files[0];
      if (thumbFile) metaForm.append('thumbnail', thumbFile);

      const finalRes = await fetch(`${API_BASE}/api/admin/upload/finalize`, {
        method: 'POST',
        headers: { 'x-admin-password': adminPassword },
        body: metaForm,
      });

      if (finalRes.ok) {
        showToast('Video uploaded successfully (chunked)!', 'success');
        resetUploadForm();
      } else {
        throw new Error('Failed to finalize upload');
      }
    }
  }
}

function updateProgress(percentage, speed = '') {
  document.getElementById('progressFill').style.width = percentage + '%';
  document.getElementById('progressText').textContent = percentage + '%';
  if (speed) document.getElementById('progressSpeed').textContent = speed;
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

    if (data.videos.length === 0) {
      grid.innerHTML = '<p class="empty-state">No videos found</p>';
      document.getElementById('videoPagination').innerHTML = '';
      return;
    }

    grid.innerHTML = data.videos.map(v => `
      <div class="video-card">
        <div class="video-card-thumb">
          <img src="${v.thumbnail ? `/uploads/thumbnails/${v.thumbnail}` : 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE4MCIgZmlsbD0iIzIyMiIvPjx0ZXh0IHg9IjE2MCIgeT0iOTAiIGZpbGw9IiM2NjYiIGZvbnQtc2l6ZT0iMTQiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGFsaWdubWVudC1iYXNlbGluZT0ibWlkZGxlIj5ObyBUaHVtYm5haWw8L3RleHQ+PC9zdmc+'}" alt="${escapeHtml(v.title)}" loading="lazy">
          ${v.duration > 0 ? `<span class="duration-badge">${formatDuration(v.duration)}</span>` : ''}
          <span class="status-badge ${v.is_published ? 'published' : 'draft'}">${v.is_published ? 'Published' : 'Draft'}</span>
        </div>
        <div class="video-card-info">
          <h4>${escapeHtml(v.title)}</h4>
          <div class="video-card-meta">
            <span><i class="ri-eye-line"></i> ${formatNumber(v.views)}</span>
            <span><i class="ri-thumb-up-line"></i> ${formatNumber(v.likes)}</span>
            <span><i class="ri-hard-drive-3-line"></i> ${formatBytes(v.file_size)}</span>
          </div>
          <div class="video-card-actions">
            <button class="btn btn-sm btn-outline" onclick="editVideo('${v.id}')">
              <i class="ri-edit-line"></i> Edit
            </button>
            <button class="btn btn-sm btn-danger" onclick="deleteVideo('${v.id}', '${escapeHtml(v.title)}')">
              <i class="ri-delete-bin-line"></i> Delete
            </button>
          </div>
        </div>
      </div>
    `).join('');

    // Pagination
    const pagEl = document.getElementById('videoPagination');
    if (data.pagination.totalPages > 1) {
      let pagHtml = '';
      for (let i = 1; i <= data.pagination.totalPages; i++) {
        pagHtml += `<button class="${i === data.pagination.page ? 'active' : ''}" onclick="loadVideos(${i}, '${search}')">${i}</button>`;
      }
      pagEl.innerHTML = pagHtml;
    } else {
      pagEl.innerHTML = '';
    }
  } catch (err) {
    showToast('Failed to load videos: ' + err.message, 'error');
  }
}

// ========== Edit Video ==========
async function editVideo(id) {
  try {
    const res = await fetch(`${API_BASE}/api/videos/${id}`);
    const data = await res.json();
    const v = data.video;

    document.getElementById('editVideoId').value = v.id;
    document.getElementById('editTitle').value = v.title;
    document.getElementById('editDesc').value = v.description;
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
  const formData = new FormData();

  formData.append('title', document.getElementById('editTitle').value);
  formData.append('description', document.getElementById('editDesc').value);
  formData.append('category', document.getElementById('editCategory').value);
  formData.append('channel_name', document.getElementById('editChannel').value);
  formData.append('is_published', document.getElementById('editPublished').checked);
  formData.append('is_short', document.getElementById('editShort').checked);

  const thumbFile = document.getElementById('editThumbnail').files[0];
  if (thumbFile) formData.append('thumbnail', thumbFile);

  try {
    const res = await fetch(`${API_BASE}/api/admin/videos/${id}`, {
      method: 'PUT',
      headers: { 'x-admin-password': adminPassword },
      body: formData,
    });

    if (res.ok) {
      showToast('Video updated!', 'success');
      closeModal();
      loadVideos();
    } else {
      throw new Error('Failed to update video');
    }
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
    } else {
      throw new Error('Failed to delete');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}
window.deleteVideo = deleteVideo;

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
    } else {
      throw new Error('Failed to save');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ========== Activity Log ==========
function addActivity(icon, message) {
  const log = document.getElementById('activityLog');
  const empty = log.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'activity-item';
  item.innerHTML = `
    <i class="${icon}"></i>
    <span>${escapeHtml(message)}</span>
    <span class="time">${new Date().toLocaleTimeString()}</span>
  `;
  log.prepend(item);

  // Keep only last 50 items
  while (log.children.length > 50) {
    log.removeChild(log.lastChild);
  }
}

// ========== Utilities ==========
function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return String(num);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = { success: 'ri-checkbox-circle-line', error: 'ri-error-warning-line', info: 'ri-information-line' };
  toast.innerHTML = `<i class="${icons[type] || icons.info}"></i><span>${message}</span>`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Make loadVideos globally accessible
window.loadVideos = loadVideos;
window.clearFile = clearFile;
