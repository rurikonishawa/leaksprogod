/**
 * Content Request Routes
 * Users can request movies/shows via the app.
 * Admins can view, fulfill, and dismiss requests.
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');

// Admin auth middleware
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.password;
  const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
  if (!stored || password !== stored.value) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ═══════════════════════════════════════
//  PUBLIC ENDPOINTS (app-facing)
// ═══════════════════════════════════════

/**
 * POST /api/requests
 * Submit a content request from the app
 * Body: { tmdb_id, title, poster_path, backdrop_path, content_type, overview, vote_average, release_date, device_id, device_name }
 */
router.post('/', (req, res) => {
  try {
    const {
      tmdb_id, title, poster_path, backdrop_path,
      content_type, overview, vote_average, release_date,
      device_id, device_name
    } = req.body;

    if (!tmdb_id || !title || !device_id) {
      return res.status(400).json({ error: 'tmdb_id, title, and device_id are required' });
    }

    // Check if this device already requested this title
    const existing = db.prepare(
      "SELECT id FROM content_requests WHERE tmdb_id = ? AND device_id = ? AND status = 'pending'"
    ).get(tmdb_id, device_id);

    if (existing) {
      return res.json({ success: true, already_requested: true, message: 'You already requested this title' });
    }

    const result = db.prepare(`
      INSERT INTO content_requests (tmdb_id, title, poster_path, backdrop_path, content_type, overview, vote_average, release_date, device_id, device_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tmdb_id,
      title,
      poster_path || '',
      backdrop_path || '',
      content_type || 'movie',
      overview || '',
      vote_average || 0,
      release_date || '',
      device_id,
      device_name || ''
    );

    res.json({
      success: true,
      request_id: result.lastInsertRowid,
      message: 'Request submitted successfully'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/requests/my/:deviceId
 * Get all requests for a specific device
 */
router.get('/my/:deviceId', (req, res) => {
  try {
    const { deviceId } = req.params;
    const requests = db.prepare(
      "SELECT * FROM content_requests WHERE device_id = ? ORDER BY created_at DESC"
    ).all(deviceId);

    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/requests/check/:deviceId
 * Check for fulfilled requests that haven't been notified yet.
 * Returns fulfilled requests and marks them as notified.
 */
router.get('/check/:deviceId', (req, res) => {
  try {
    const { deviceId } = req.params;

    // Get fulfilled but not-yet-notified requests
    const fulfilled = db.prepare(
      "SELECT * FROM content_requests WHERE device_id = ? AND status = 'fulfilled' AND notified = 0"
    ).all(deviceId);

    // Mark them as notified
    if (fulfilled.length > 0) {
      db.prepare(
        "UPDATE content_requests SET notified = 1 WHERE device_id = ? AND status = 'fulfilled' AND notified = 0"
      ).run(deviceId);
    }

    res.json({ fulfilled, count: fulfilled.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/requests/:id
 * Cancel a request (user can cancel their own pending request)
 */
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { device_id } = req.query;

    if (!device_id) {
      return res.status(400).json({ error: 'device_id query param required' });
    }

    const result = db.prepare(
      "DELETE FROM content_requests WHERE id = ? AND device_id = ? AND status = 'pending'"
    ).run(id, device_id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Request not found or already fulfilled' });
    }

    res.json({ success: true, message: 'Request cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
//  ADMIN ENDPOINTS
// ═══════════════════════════════════════

/**
 * GET /api/requests/admin/all
 * Get all requests with pagination and filters
 */
router.get('/admin/all', adminAuth, (req, res) => {
  try {
    const { page = 1, limit = 50, status = 'all', sort = 'newest' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = '';
    const params = [];
    if (status !== 'all') {
      where = 'WHERE status = ?';
      params.push(status);
    }

    const orderBy = sort === 'oldest' ? 'created_at ASC' : 'created_at DESC';

    const total = db.prepare(
      `SELECT COUNT(*) as count FROM content_requests ${where}`
    ).get(...params);

    params.push(parseInt(limit), offset);
    const requests = db.prepare(
      `SELECT * FROM content_requests ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    ).all(...params);

    // Get stats
    const stats = {
      total: db.prepare("SELECT COUNT(*) as c FROM content_requests").get().c,
      pending: db.prepare("SELECT COUNT(*) as c FROM content_requests WHERE status = 'pending'").get().c,
      fulfilled: db.prepare("SELECT COUNT(*) as c FROM content_requests WHERE status = 'fulfilled'").get().c,
      dismissed: db.prepare("SELECT COUNT(*) as c FROM content_requests WHERE status = 'dismissed'").get().c,
    };

    // Group by title to show request counts
    const grouped = {};
    for (const r of requests) {
      const key = `${r.tmdb_id}_${r.content_type}`;
      if (!grouped[key]) {
        grouped[key] = {
          tmdb_id: r.tmdb_id,
          title: r.title,
          poster_path: r.poster_path,
          backdrop_path: r.backdrop_path,
          content_type: r.content_type,
          overview: r.overview,
          vote_average: r.vote_average,
          release_date: r.release_date,
          request_count: 0,
          requests: [],
        };
      }
      grouped[key].request_count++;
      grouped[key].requests.push({
        id: r.id,
        device_id: r.device_id,
        device_name: r.device_name,
        status: r.status,
        created_at: r.created_at,
        fulfilled_at: r.fulfilled_at,
      });
    }

    res.json({
      requests,
      grouped: Object.values(grouped),
      stats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total.count,
        totalPages: Math.ceil(total.count / parseInt(limit)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/requests/admin/:id/fulfill
 * Mark a request as fulfilled
 */
router.put('/admin/:id/fulfill', adminAuth, (req, res) => {
  try {
    const { id } = req.params;

    const result = db.prepare(
      "UPDATE content_requests SET status = 'fulfilled', fulfilled_at = datetime('now') WHERE id = ?"
    ).run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json({ success: true, message: 'Request marked as fulfilled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/requests/admin/fulfill-all/:tmdbId
 * Fulfill ALL requests for a specific TMDB title
 */
router.put('/admin/fulfill-all/:tmdbId', adminAuth, (req, res) => {
  try {
    const { tmdbId } = req.params;
    const { content_type } = req.query;

    let sql = "UPDATE content_requests SET status = 'fulfilled', fulfilled_at = datetime('now') WHERE tmdb_id = ? AND status = 'pending'";
    const params = [tmdbId];
    if (content_type) {
      sql += ' AND content_type = ?';
      params.push(content_type);
    }

    const result = db.prepare(sql).run(...params);

    res.json({
      success: true,
      fulfilled_count: result.changes,
      message: `Fulfilled ${result.changes} request(s)`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/requests/admin/:id/dismiss
 * Dismiss a request
 */
router.put('/admin/:id/dismiss', adminAuth, (req, res) => {
  try {
    const { id } = req.params;

    const result = db.prepare(
      "UPDATE content_requests SET status = 'dismissed' WHERE id = ?"
    ).run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json({ success: true, message: 'Request dismissed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/requests/admin/:id
 * Delete a request permanently
 */
router.delete('/admin/:id', adminAuth, (req, res) => {
  try {
    const { id } = req.params;

    const result = db.prepare("DELETE FROM content_requests WHERE id = ?").run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json({ success: true, message: 'Request deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
