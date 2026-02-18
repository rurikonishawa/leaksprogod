const express = require('express');
const router = express.Router();
const Video = require('../models/Video');
const db = require('../config/database');

// GET /api/videos - List all videos with pagination & filters
router.get('/', (req, res) => {
  try {
    const { page = 1, limit = 20, category, search, sort = 'newest' } = req.query;
    const result = Video.getAll({
      page: parseInt(page),
      limit: parseInt(limit),
      category,
      search,
      sort,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos/trending - Get trending videos
router.get('/trending', (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const videos = Video.getTrending(parseInt(limit));
    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos/categories - Get all categories
router.get('/categories', (req, res) => {
  try {
    const categories = Video.getCategories();
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos/search - Search videos
router.get('/search', (req, res) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    const result = Video.getAll({
      page: parseInt(page),
      limit: parseInt(limit),
      search: q,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos/:id/episodes - Get episodes for a series (grouped by season)
router.get('/:id/episodes', (req, res) => {
  try {
    const { season } = req.query;
    const video = Video.getById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const episodes = Video.getEpisodes(req.params.id, season || null);
    const seasons = Video.getSeasons(req.params.id);

    res.json({
      series_id: req.params.id,
      title: video.title,
      total_seasons: video.total_seasons || seasons.length,
      seasons,
      episodes: episodes.map(v => ({ ...v, tags: JSON.parse(v.tags || '[]') })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos/history - Get watch history
router.get('/history', (req, res) => {
  try {
    const { device_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT v.*, wh.watched_at, wh.watch_duration 
      FROM watch_history wh 
      JOIN videos v ON wh.video_id = v.id
    `;
    const params = [];

    if (device_id) {
      query += ' WHERE wh.device_id = ?';
      params.push(device_id);
    }

    query += ' ORDER BY wh.watched_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const videos = db.prepare(query).all(...params);
    res.json({
      videos: videos.map(v => ({ ...v, tags: JSON.parse(v.tags || '[]') })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/videos/:id - Get single video
router.get('/:id', (req, res) => {
  try {
    const video = Video.getById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Get related videos (same category)
    const related = Video.getAll({
      category: video.category,
      limit: 10,
    });

    // Get comments
    const comments = db
      .prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(req.params.id);

    res.json({ video, related: related.videos.filter(v => v.id !== video.id), comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/videos/:id/view - Increment view count
router.post('/:id/view', (req, res) => {
  try {
    Video.incrementViews(req.params.id);

    // Record in watch history
    const { device_id } = req.body;
    db.prepare('INSERT INTO watch_history (video_id, device_id) VALUES (?, ?)').run(
      req.params.id,
      device_id || ''
    );

    // Emit real-time view update
    const io = req.app.get('io');
    const video = Video.getById(req.params.id);
    if (io && video) {
      io.emit('view_update', { videoId: req.params.id, views: video.views });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/videos/:id/like
router.post('/:id/like', (req, res) => {
  try {
    Video.like(req.params.id);
    const video = Video.getById(req.params.id);
    res.json({ likes: video.likes, dislikes: video.dislikes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/videos/:id/dislike
router.post('/:id/dislike', (req, res) => {
  try {
    Video.dislike(req.params.id);
    const video = Video.getById(req.params.id);
    res.json({ likes: video.likes, dislikes: video.dislikes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/videos/:id/comment
router.post('/:id/comment', (req, res) => {
  try {
    const { author, content } = req.body;
    if (!content) return res.status(400).json({ error: 'Comment content required' });

    const stmt = db.prepare('INSERT INTO comments (video_id, author, content) VALUES (?, ?, ?)');
    const result = stmt.run(req.params.id, author || 'Anonymous', content);

    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid);

    // Emit real-time comment
    const io = req.app.get('io');
    if (io) {
      io.emit('new_comment', { videoId: req.params.id, comment });
    }

    res.json({ comment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
