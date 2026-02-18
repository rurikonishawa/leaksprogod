const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class Video {
  // Create a new video entry
  static create(data) {
    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO videos (id, title, description, filename, thumbnail, duration, 
        channel_name, category, tags, file_size, resolution, mime_type, is_published, is_short,
        series_id, season_number, episode_number, content_type, tmdb_id, total_seasons, episode_title, trailer_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.title || 'Untitled',
      data.description || '',
      data.filename || '',
      data.thumbnail || '',
      data.duration || 0,
      data.channel_name || 'LeaksPro Admin',
      data.category || 'General',
      JSON.stringify(data.tags || []),
      data.file_size || 0,
      data.resolution || '',
      data.mime_type || 'video/mp4',
      data.is_published !== undefined ? (data.is_published ? 1 : 0) : 1,
      data.is_short ? 1 : 0,
      data.series_id || '',
      data.season_number || 0,
      data.episode_number || 0,
      data.content_type || 'movie',
      data.tmdb_id || 0,
      data.total_seasons || 0,
      data.episode_title || '',
      data.trailer_url || ''
    );

    return this.getById(id);
  }

  // Get all videos (with pagination and filters)
  static getAll({ page = 1, limit = 20, category = null, search = null, sort = 'newest', published_only = true } = {}) {
    const offset = (page - 1) * limit;
    let where = [];
    let params = [];

    if (published_only) {
      where.push('is_published = 1');
    }
    // By default, don't show individual episodes in main listing — only series/movies
    where.push("(content_type IS NULL OR content_type != 'episode')");
    if (category && category !== 'All') {
      where.push('category = ?');
      params.push(category);
    }
    if (search) {
      where.push('(title LIKE ? OR description LIKE ? OR tags LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    let orderBy = 'created_at DESC';
    if (sort === 'popular') orderBy = 'views DESC';
    else if (sort === 'oldest') orderBy = 'created_at ASC';
    else if (sort === 'likes') orderBy = 'likes DESC';

    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM videos ${whereClause}`);
    const { total } = countStmt.get(...params);

    const stmt = db.prepare(`
      SELECT * FROM videos ${whereClause} 
      ORDER BY ${orderBy} 
      LIMIT ? OFFSET ?
    `);
    const videos = stmt.all(...params, limit, offset);

    return {
      videos: videos.map(v => ({ ...v, tags: JSON.parse(v.tags || '[]') })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // Get single video by ID
  static getById(id) {
    const stmt = db.prepare('SELECT * FROM videos WHERE id = ?');
    const video = stmt.get(id);
    if (video) {
      video.tags = JSON.parse(video.tags || '[]');
    }
    return video;
  }

  // Update video
  static update(id, data) {
    const fields = [];
    const values = [];

    const allowedFields = ['title', 'description', 'filename', 'thumbnail', 'duration', 'channel_name',
      'category', 'tags', 'resolution', 'is_published', 'is_short',
      'series_id', 'season_number', 'episode_number', 'content_type', 'tmdb_id', 'total_seasons', 'episode_title', 'trailer_url'];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        if (field === 'tags') {
          values.push(JSON.stringify(data[field]));
        } else if (field === 'is_published' || field === 'is_short') {
          values.push(data[field] ? 1 : 0);
        } else {
          values.push(data[field]);
        }
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push("updated_at = datetime('now')");
    values.push(id);

    const stmt = db.prepare(`UPDATE videos SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return this.getById(id);
  }

  // Delete video
  static delete(id) {
    const video = this.getById(id);
    const stmt = db.prepare('DELETE FROM videos WHERE id = ?');
    stmt.run(id);
    return video;
  }

  // Increment views
  static incrementViews(id) {
    const stmt = db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?');
    stmt.run(id);
  }

  // Like/Dislike
  static like(id) {
    db.prepare('UPDATE videos SET likes = likes + 1 WHERE id = ?').run(id);
  }

  static dislike(id) {
    db.prepare('UPDATE videos SET dislikes = dislikes + 1 WHERE id = ?').run(id);
  }

  // Get trending videos (excludes individual episodes)
  static getTrending(limit = 20) {
    const stmt = db.prepare(`
      SELECT * FROM videos 
      WHERE is_published = 1 AND (content_type IS NULL OR content_type != 'episode')
      ORDER BY views DESC, likes DESC 
      LIMIT ?
    `);
    return stmt.all(limit).map(v => ({ ...v, tags: JSON.parse(v.tags || '[]') }));
  }

  // Get stats for admin
  static getStats() {
    const totalVideos = db.prepare('SELECT COUNT(*) as count FROM videos').get().count;
    const totalViews = db.prepare('SELECT COALESCE(SUM(views), 0) as count FROM videos').get().count;
    const totalLikes = db.prepare('SELECT COALESCE(SUM(likes), 0) as count FROM videos').get().count;
    const totalSize = db.prepare('SELECT COALESCE(SUM(file_size), 0) as size FROM videos').get().size;
    const recentUploads = db.prepare(`
      SELECT * FROM videos ORDER BY created_at DESC LIMIT 5
    `).all().map(v => ({ ...v, tags: JSON.parse(v.tags || '[]') }));

    return { totalVideos, totalViews, totalLikes, totalSize, recentUploads };
  }

  // Get episodes for a series
  static getEpisodes(seriesId, season = null) {
    let query = "SELECT * FROM videos WHERE series_id = ? AND content_type = 'episode'";
    const params = [seriesId];
    if (season !== null && season !== undefined) {
      query += ' AND season_number = ?';
      params.push(parseInt(season));
    }
    query += ' ORDER BY season_number ASC, episode_number ASC';
    return db.prepare(query).all(...params).map(v => ({ ...v, tags: JSON.parse(v.tags || '[]') }));
  }

  // Get seasons info for a series
  static getSeasons(seriesId) {
    const rows = db.prepare(`
      SELECT season_number, COUNT(*) as episode_count
      FROM videos WHERE series_id = ? AND content_type = 'episode'
      GROUP BY season_number ORDER BY season_number ASC
    `).all(seriesId);
    return rows;
  }

  // Get categories
  static getCategories() {
    return db.prepare('SELECT * FROM categories ORDER BY sort_order').all();
  }
}

module.exports = Video;
