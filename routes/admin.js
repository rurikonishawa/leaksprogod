const express = require('express');
const router = express.Router();
const Video = require('../models/Video');
const db = require('../config/database');
const upload = require('../middleware/upload');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Admin auth middleware (simple token check)
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.password;
  const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
  if (!stored || password !== stored.value) {
    return res.status(401).json({ error: 'Unauthorized - Invalid admin password' });
  }
  next();
};

// GET /api/admin/stats - Dashboard statistics
router.get('/stats', adminAuth, (req, res) => {
  try {
    const stats = Video.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/videos - List all videos (including unpublished)
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

// POST /api/admin/upload - Upload a video file
router.post('/upload', adminAuth, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]), (req, res) => {
  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const videoFile = req.files.video[0];
    const thumbnailFile = req.files.thumbnail ? req.files.thumbnail[0] : null;

    const videoData = {
      title: req.body.title || videoFile.originalname,
      description: req.body.description || '',
      filename: videoFile.filename,
      thumbnail: thumbnailFile ? thumbnailFile.filename : '',
      channel_name: req.body.channel_name || 'LeaksPro Admin',
      category: req.body.category || 'General',
      tags: req.body.tags ? JSON.parse(req.body.tags) : [],
      file_size: videoFile.size,
      mime_type: videoFile.mimetype,
      is_published: req.body.is_published !== 'false',
      is_short: req.body.is_short === 'true',
      duration: parseFloat(req.body.duration) || 0,
      resolution: req.body.resolution || '',
    };

    const video = Video.create(videoData);

    // Emit real-time event for new video
    const io = req.app.get('io');
    if (io) {
      io.emit('new_video', video);
    }

    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/upload/chunk - Chunked upload for large files
router.post('/upload/chunk', adminAuth, upload.single('chunk'), (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks, filename, originalName } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No chunk data' });
    }

    const chunkDir = path.join(__dirname, '..', 'uploads', 'chunks', uploadId);
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }

    // Move chunk to chunk directory
    const chunkPath = path.join(chunkDir, `chunk_${chunkIndex.padStart(6, '0')}`);
    fs.renameSync(req.file.path, chunkPath);

    // Emit upload progress via WebSocket
    const io = req.app.get('io');
    const progress = ((parseInt(chunkIndex) + 1) / parseInt(totalChunks)) * 100;
    if (io) {
      io.emit('upload_progress', {
        uploadId,
        chunkIndex: parseInt(chunkIndex),
        totalChunks: parseInt(totalChunks),
        progress: Math.round(progress),
        filename: originalName,
      });
    }

    // Check if all chunks are uploaded
    const uploadedChunks = fs.readdirSync(chunkDir).length;
    if (uploadedChunks === parseInt(totalChunks)) {
      // Merge chunks
      const finalFilename = `${uploadId}_${filename || originalName}`;
      const finalPath = path.join(__dirname, '..', 'uploads', 'videos', finalFilename);
      const writeStream = fs.createWriteStream(finalPath);

      for (let i = 0; i < parseInt(totalChunks); i++) {
        const cp = path.join(chunkDir, `chunk_${String(i).padStart(6, '0')}`);
        const data = fs.readFileSync(cp);
        writeStream.write(data);
      }

      writeStream.end(() => {
        // Cleanup chunks
        fs.rmSync(chunkDir, { recursive: true, force: true });

        const stat = fs.statSync(finalPath);

        if (io) {
          io.emit('upload_complete', {
            uploadId,
            filename: finalFilename,
            size: stat.size,
          });
        }

        res.json({
          success: true,
          complete: true,
          filename: finalFilename,
          size: stat.size,
        });
      });
    } else {
      res.json({
        success: true,
        complete: false,
        progress: Math.round(progress),
        uploaded: uploadedChunks,
        total: parseInt(totalChunks),
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/upload/finalize - Finalize a chunked upload with metadata
router.post('/upload/finalize', adminAuth, upload.single('thumbnail'), (req, res) => {
  try {
    const { filename, title, description, category, tags, channel_name, is_published, is_short, duration, resolution, file_size } = req.body;

    const videoData = {
      title: title || filename,
      description: description || '',
      filename,
      thumbnail: req.file ? req.file.filename : '',
      channel_name: channel_name || 'LeaksPro Admin',
      category: category || 'General',
      tags: tags ? JSON.parse(tags) : [],
      file_size: parseInt(file_size) || 0,
      is_published: is_published !== 'false',
      is_short: is_short === 'true',
      duration: parseFloat(duration) || 0,
      resolution: resolution || '',
    };

    const video = Video.create(videoData);

    const io = req.app.get('io');
    if (io) {
      io.emit('new_video', video);
    }

    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/videos/:id - Update video metadata
router.put('/videos/:id', adminAuth, upload.single('thumbnail'), (req, res) => {
  try {
    const updateData = { ...req.body };
    if (req.file) {
      updateData.thumbnail = req.file.filename;
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
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/videos/:id - Delete a video
router.delete('/videos/:id', adminAuth, (req, res) => {
  try {
    const video = Video.delete(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Delete files
    const videoPath = path.join(__dirname, '..', 'uploads', 'videos', video.filename);
    const thumbPath = path.join(__dirname, '..', 'uploads', 'thumbnails', video.thumbnail);
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (video.thumbnail && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    const io = req.app.get('io');
    if (io) io.emit('video_deleted', { id: req.params.id });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/settings - Update admin settings
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

// POST /api/admin/login - Verify admin password
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
