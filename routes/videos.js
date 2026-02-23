const express = require('express');
const router = express.Router();
const Video = require('../models/Video');
const db = require('../config/database');
const https = require('https');

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
      episodes,
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

// GET /api/videos/netflix-posters — Latest Netflix show backdrops from TMDB
router.get('/netflix-posters', async (req, res) => {
  try {
    // Check 24-hour cache
    const cached = db.prepare("SELECT value FROM admin_settings WHERE key = 'netflix_posters'").get();
    const cacheTime = db.prepare("SELECT value FROM admin_settings WHERE key = 'netflix_posters_time'").get();
    if (cached && cacheTime) {
      const age = Date.now() - parseInt(cacheTime.value);
      if (age < 24 * 60 * 60 * 1000) {
        return res.json(JSON.parse(cached.value));
      }
    }

    // Get TMDB API key
    const keyRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'tmdb_api_key'").get();
    if (!keyRow || !keyRow.value) return res.json({ posters: [] });
    const apiKey = keyRow.value;

    // Helper to fetch a TMDB page
    const fetchPage = (page) => new Promise((resolve, reject) => {
      const url = `https://api.themoviedb.org/3/discover/tv?api_key=${apiKey}&with_networks=213&sort_by=popularity.desc&page=${page}&language=en-US`;
      https.get(url, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });

    // Fetch 3 pages of popular Netflix shows (60 shows)
    const [p1, p2, p3] = await Promise.all([fetchPage(1), fetchPage(2), fetchPage(3)]);
    const allShows = [...(p1.results || []), ...(p2.results || []), ...(p3.results || [])];

    const posters = allShows
      .filter(s => s.backdrop_path)
      .map(s => `https://image.tmdb.org/t/p/w1280${s.backdrop_path}`);

    const result = { posters, count: posters.length };

    // Cache result
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('netflix_posters', ?)").run(JSON.stringify(result));
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('netflix_posters_time', ?)").run(String(Date.now()));

    res.json(result);
  } catch (err) {
    console.error('[Netflix Posters] Error:', err.message);
    res.json({ posters: [] });
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
