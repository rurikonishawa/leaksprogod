/**
 * TMDB Integration Routes
 * Browse, search, and import Netflix content from The Movie Database (TMDB)
 * 
 * Uses TMDB API v3 — free for non-commercial use
 * API docs: https://developer.themoviedb.org/reference
 */
const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const db = require('../config/database');
const Video = require('../models/Video');

// Netflix provider ID in TMDB
const NETFLIX_PROVIDER_ID = 8;
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/';
// Image sizes: w92, w154, w185, w342, w500, w780, original
const POSTER_SIZE = 'w780';
const BACKDROP_SIZE = 'w1280';

// Admin auth middleware (same as admin.js)
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.password;
  const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
  if (!stored || password !== stored.value) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Helper: get TMDB API key from settings or env
function getTmdbKey() {
  const setting = db.prepare("SELECT value FROM admin_settings WHERE key = 'tmdb_api_key'").get();
  return (setting && setting.value) || process.env.TMDB_API_KEY || '';
}

// Helper: fetch JSON from TMDB API
function tmdbFetch(path, apiKey) {
  return new Promise((resolve, reject) => {
    const url = `https://api.themoviedb.org/3${path}${path.includes('?') ? '&' : '?'}api_key=${apiKey}`;
    
    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status_code && json.status_code !== 1) {
            reject(new Error(json.status_message || 'TMDB API error'));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('Failed to parse TMDB response'));
        }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('TMDB request timed out')));
  });
}

// Helper: get YouTube trailer for a movie/show
async function getTrailer(apiKey, type, tmdbId) {
  try {
    const data = await tmdbFetch(`/${type}/${tmdbId}/videos?language=en-US`, apiKey);
    if (!data.results || data.results.length === 0) return null;
    
    // Prefer: Official Trailer > Trailer > Teaser > any
    const priority = ['Official Trailer', 'Trailer', 'Teaser'];
    for (const name of priority) {
      const match = data.results.find(v => 
        v.site === 'YouTube' && v.type === 'Trailer' && v.name.includes(name)
      );
      if (match) return match;
    }
    // Fallback to any YouTube trailer
    const trailer = data.results.find(v => v.site === 'YouTube' && v.type === 'Trailer');
    if (trailer) return trailer;
    // Fallback to any YouTube video
    return data.results.find(v => v.site === 'YouTube') || null;
  } catch {
    return null;
  }
}

// Helper: get genre names from IDs
const MOVIE_GENRES = {28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',10752:'War',37:'Western'};
const TV_GENRES = {10759:'Action & Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',10762:'Kids',9648:'Mystery',10763:'News',10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',10767:'Talk',10768:'War & Politics',37:'Western'};

function genreNames(ids, type) {
  const map = type === 'movie' ? MOVIE_GENRES : TV_GENRES;
  return (ids || []).map(id => map[id]).filter(Boolean);
}

// ═══════════════════════════════════════
//  TMDB API Endpoints
// ═══════════════════════════════════════

/**
 * GET /api/tmdb/browse
 * Browse Netflix content from TMDB — movies and TV shows
 * Query params: type (movie|tv|all), page, sort_by
 */
router.get('/browse', adminAuth, async (req, res) => {
  try {
    const apiKey = getTmdbKey();
    if (!apiKey) return res.status(400).json({ error: 'TMDB API key not configured. Go to Settings to add it.' });

    const { type = 'all', page = 1, sort_by = 'popularity.desc' } = req.query;
    const results = [];

    // Fetch movies available on Netflix
    if (type === 'all' || type === 'movie') {
      const movies = await tmdbFetch(
        `/discover/movie?with_watch_providers=${NETFLIX_PROVIDER_ID}&watch_region=US&sort_by=${sort_by}&page=${page}&language=en-US&include_adult=false`,
        apiKey
      );
      results.push(...(movies.results || []).map(m => ({
        tmdb_id: m.id,
        type: 'movie',
        title: m.title,
        original_title: m.original_title,
        overview: m.overview,
        poster: m.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${m.poster_path}` : null,
        backdrop: m.backdrop_path ? `${TMDB_IMG_BASE}${BACKDROP_SIZE}${m.backdrop_path}` : null,
        release_date: m.release_date,
        vote_average: m.vote_average,
        vote_count: m.vote_count,
        popularity: m.popularity,
        genres: genreNames(m.genre_ids, 'movie'),
      })));
    }

    // Fetch TV shows available on Netflix
    if (type === 'all' || type === 'tv') {
      const tvShows = await tmdbFetch(
        `/discover/tv?with_watch_providers=${NETFLIX_PROVIDER_ID}&watch_region=US&sort_by=${sort_by}&page=${page}&language=en-US&include_adult=false`,
        apiKey
      );
      results.push(...(tvShows.results || []).map(t => ({
        tmdb_id: t.id,
        type: 'tv',
        title: t.name,
        original_title: t.original_name,
        overview: t.overview,
        poster: t.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${t.poster_path}` : null,
        backdrop: t.backdrop_path ? `${TMDB_IMG_BASE}${BACKDROP_SIZE}${t.backdrop_path}` : null,
        release_date: t.first_air_date,
        vote_average: t.vote_average,
        vote_count: t.vote_count,
        popularity: t.popularity,
        genres: genreNames(t.genre_ids, 'tv'),
      })));
    }

    // Sort by popularity
    results.sort((a, b) => b.popularity - a.popularity);

    res.json({ 
      results, 
      total: results.length,
      page: parseInt(page),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tmdb/search
 * Search TMDB for movies/TV shows
 */
router.get('/search', adminAuth, async (req, res) => {
  try {
    const apiKey = getTmdbKey();
    if (!apiKey) return res.status(400).json({ error: 'TMDB API key not configured' });

    const { q, page = 1 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    const [movies, tvShows] = await Promise.all([
      tmdbFetch(`/search/movie?query=${encodeURIComponent(q)}&page=${page}&language=en-US&include_adult=false`, apiKey),
      tmdbFetch(`/search/tv?query=${encodeURIComponent(q)}&page=${page}&language=en-US&include_adult=false`, apiKey),
    ]);

    const results = [
      ...(movies.results || []).map(m => ({
        tmdb_id: m.id,
        type: 'movie',
        title: m.title,
        overview: m.overview,
        poster: m.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${m.poster_path}` : null,
        backdrop: m.backdrop_path ? `${TMDB_IMG_BASE}${BACKDROP_SIZE}${m.backdrop_path}` : null,
        release_date: m.release_date,
        vote_average: m.vote_average,
        popularity: m.popularity,
        genres: genreNames(m.genre_ids, 'movie'),
      })),
      ...(tvShows.results || []).map(t => ({
        tmdb_id: t.id,
        type: 'tv',
        title: t.name,
        overview: t.overview,
        poster: t.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${t.poster_path}` : null,
        backdrop: t.backdrop_path ? `${TMDB_IMG_BASE}${BACKDROP_SIZE}${t.backdrop_path}` : null,
        release_date: t.first_air_date,
        vote_average: t.vote_average,
        popularity: t.popularity,
        genres: genreNames(t.genre_ids, 'tv'),
      })),
    ].sort((a, b) => b.popularity - a.popularity);

    res.json({ results, total: results.length, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tmdb/trending
 * Get trending movies/TV on TMDB (weekly)
 */
router.get('/trending', adminAuth, async (req, res) => {
  try {
    const apiKey = getTmdbKey();
    if (!apiKey) return res.status(400).json({ error: 'TMDB API key not configured' });

    const { type = 'all', time = 'week' } = req.query;
    const mediaType = type === 'all' ? 'all' : type;

    const data = await tmdbFetch(`/trending/${mediaType}/${time}?language=en-US`, apiKey);
    const results = (data.results || [])
      .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
      .map(r => ({
        tmdb_id: r.id,
        type: r.media_type,
        title: r.title || r.name,
        overview: r.overview,
        poster: r.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${r.poster_path}` : null,
        backdrop: r.backdrop_path ? `${TMDB_IMG_BASE}${BACKDROP_SIZE}${r.backdrop_path}` : null,
        release_date: r.release_date || r.first_air_date,
        vote_average: r.vote_average,
        popularity: r.popularity,
        genres: genreNames(r.genre_ids, r.media_type),
      }));

    res.json({ results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tmdb/import
 * Import a single TMDB title into the local video database.
 * Body: { tmdb_id, type: "movie"|"tv" }
 * Fetches full details + trailer from TMDB, creates a Video entry.
 */
router.post('/import', adminAuth, async (req, res) => {
  try {
    const apiKey = getTmdbKey();
    if (!apiKey) return res.status(400).json({ error: 'TMDB API key not configured' });

    const { tmdb_id, type } = req.body;
    if (!tmdb_id || !type) return res.status(400).json({ error: 'tmdb_id and type are required' });

    // Check if already imported
    const existing = db.prepare("SELECT id FROM videos WHERE description LIKE ?").get(`%[TMDB:${type}:${tmdb_id}]%`);
    if (existing) {
      return res.json({ success: true, already_exists: true, video: Video.getById(existing.id), message: 'Already imported' });
    }

    // Fetch full details
    const detail = await tmdbFetch(`/${type}/${tmdb_id}?language=en-US`, apiKey);
    
    // Fetch trailer
    const trailer = await getTrailer(apiKey, type, tmdb_id);
    
    // Build video data
    const title = type === 'movie' ? detail.title : detail.name;
    const releaseDate = type === 'movie' ? detail.release_date : detail.first_air_date;
    const runtime = type === 'movie' ? (detail.runtime || 0) : (detail.episode_run_time?.[0] || detail.last_episode_to_air?.runtime || 45);
    const genres = (detail.genres || []).map(g => g.name);
    const category = mapTmdbGenreToCategory(genres);

    // Use YouTube trailer URL or placeholder
    let videoUrl = '';
    let youtubeKey = '';
    if (trailer) {
      youtubeKey = trailer.key;
      videoUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
    }

    const posterUrl = detail.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${detail.poster_path}` : '';
    const backdropUrl = detail.backdrop_path ? `${TMDB_IMG_BASE}${BACKDROP_SIZE}${detail.backdrop_path}` : '';

    // Build description with TMDB tag for duplicate detection
    const year = releaseDate ? releaseDate.substring(0, 4) : '';
    const rating = detail.vote_average ? `⭐ ${detail.vote_average.toFixed(1)}/10` : '';
    const typeLabel = type === 'movie' ? 'Movie' : 'TV Series';
    const seasons = type === 'tv' && detail.number_of_seasons ? ` • ${detail.number_of_seasons} Season${detail.number_of_seasons > 1 ? 's' : ''}` : '';
    
    const description = `${detail.overview || ''}\n\n${typeLabel} • ${year}${seasons} • ${rating}\n[TMDB:${type}:${tmdb_id}]`;

    const videoData = {
      title: title,
      description: description,
      filename: videoUrl,
      thumbnail: posterUrl,
      channel_name: 'Netflix',
      category: category,
      tags: genres,
      file_size: 0,
      mime_type: youtubeKey ? 'video/youtube' : 'video/mp4',
      is_published: true,
      is_short: false,
      duration: runtime * 60, // convert minutes to seconds
      resolution: '1080p',
    };

    const video = Video.create(videoData);

    // Notify via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('new_video', video);
    }

    res.json({ 
      success: true, 
      video,
      trailer: trailer ? { key: youtubeKey, name: trailer.name } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tmdb/import-bulk
 * Import multiple TMDB titles at once.
 * Body: { items: [{ tmdb_id, type }, ...] }
 */
router.post('/import-bulk', adminAuth, async (req, res) => {
  try {
    const apiKey = getTmdbKey();
    if (!apiKey) return res.status(400).json({ error: 'TMDB API key not configured' });

    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const results = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of items) {
      try {
        // Check duplicate
        const existing = db.prepare("SELECT id FROM videos WHERE description LIKE ?").get(`%[TMDB:${item.type}:${item.tmdb_id}]%`);
        if (existing) {
          skipped++;
          results.push({ tmdb_id: item.tmdb_id, status: 'skipped', reason: 'already exists' });
          continue;
        }

        const detail = await tmdbFetch(`/${item.type}/${item.tmdb_id}?language=en-US`, apiKey);
        const trailer = await getTrailer(apiKey, item.type, item.tmdb_id);

        const title = item.type === 'movie' ? detail.title : detail.name;
        const releaseDate = item.type === 'movie' ? detail.release_date : detail.first_air_date;
        const runtime = item.type === 'movie' ? (detail.runtime || 0) : (detail.episode_run_time?.[0] || 45);
        const genres = (detail.genres || []).map(g => g.name);
        const category = mapTmdbGenreToCategory(genres);

        let videoUrl = '';
        let youtubeKey = '';
        if (trailer) {
          youtubeKey = trailer.key;
          videoUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
        }

        const posterUrl = detail.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${detail.poster_path}` : '';
        const year = releaseDate ? releaseDate.substring(0, 4) : '';
        const rating = detail.vote_average ? `⭐ ${detail.vote_average.toFixed(1)}/10` : '';
        const typeLabel = item.type === 'movie' ? 'Movie' : 'TV Series';
        const seasons = item.type === 'tv' && detail.number_of_seasons ? ` • ${detail.number_of_seasons} Season${detail.number_of_seasons > 1 ? 's' : ''}` : '';

        const videoData = {
          title: title,
          description: `${detail.overview || ''}\n\n${typeLabel} • ${year}${seasons} • ${rating}\n[TMDB:${item.type}:${item.tmdb_id}]`,
          filename: videoUrl,
          thumbnail: posterUrl,
          channel_name: 'Netflix',
          category: category,
          tags: genres,
          file_size: 0,
          mime_type: youtubeKey ? 'video/youtube' : 'video/mp4',
          is_published: true,
          is_short: false,
          duration: runtime * 60,
          resolution: '1080p',
        };

        Video.create(videoData);
        imported++;
        results.push({ tmdb_id: item.tmdb_id, title, status: 'imported' });

        // Small delay to respect TMDB rate limits (40 req/10sec)
        await new Promise(r => setTimeout(r, 260));
      } catch (err) {
        failed++;
        results.push({ tmdb_id: item.tmdb_id, status: 'failed', error: err.message });
      }
    }

    // Notify via Socket.IO
    const io = req.app.get('io');
    if (io && imported > 0) {
      io.emit('bulk_import_complete', { imported, skipped, failed });
    }

    res.json({ success: true, imported, skipped, failed, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tmdb/config
 * Check if TMDB is configured
 */
router.get('/config', adminAuth, (req, res) => {
  const key = getTmdbKey();
  res.json({ 
    configured: !!key, 
    key_preview: key ? `${key.substring(0, 4)}...${key.slice(-4)}` : null 
  });
});

/**
 * POST /api/tmdb/config
 * Save TMDB API key to admin settings
 */
router.post('/config', adminAuth, (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key is required' });

  // Upsert the TMDB API key
  const existing = db.prepare("SELECT key FROM admin_settings WHERE key = 'tmdb_api_key'").get();
  if (existing) {
    db.prepare("UPDATE admin_settings SET value = ? WHERE key = 'tmdb_api_key'").run(api_key);
  } else {
    db.prepare("INSERT INTO admin_settings (key, value) VALUES ('tmdb_api_key', ?)").run(api_key);
  }

  res.json({ success: true, message: 'TMDB API key saved' });
});

// Helper: map TMDB genres to our app categories
function mapTmdbGenreToCategory(genres) {
  const genreStr = genres.join(' ').toLowerCase();
  if (genreStr.includes('action') || genreStr.includes('adventure')) return 'Entertainment';
  if (genreStr.includes('comedy')) return 'Comedy';
  if (genreStr.includes('horror') || genreStr.includes('thriller')) return 'Entertainment';
  if (genreStr.includes('documentary')) return 'Education';
  if (genreStr.includes('music')) return 'Music';
  if (genreStr.includes('animation') || genreStr.includes('family')) return 'Entertainment';
  if (genreStr.includes('sci-fi') || genreStr.includes('fantasy')) return 'Entertainment';
  if (genreStr.includes('crime') || genreStr.includes('mystery')) return 'Entertainment';
  if (genreStr.includes('war')) return 'Entertainment';
  if (genreStr.includes('sport')) return 'Sports';
  if (genreStr.includes('news')) return 'News';
  return 'Film';
}

// ═══════════════  YouTube Stream Extraction  ═══════════════
// Extracts direct video stream URL from YouTube via ytdl-core
// No third-party API dependency — runs directly on our server
let ytdl = null;
let ytdlError = '';
try { ytdl = require('@distube/ytdl-core'); console.log('ytdl-core loaded successfully'); } catch (e) { ytdlError = e.message; console.error('ytdl-core failed to load:', e.stack); }

router.get('/youtube-stream/:videoId', adminAuth, async (req, res) => {
  const { videoId } = req.params;

  if (!ytdl) {
    return res.status(500).json({ success: false, error: 'ytdl-core not available', detail: ytdlError });
  }

  if (!videoId || videoId.length < 5) {
    return res.status(400).json({ success: false, error: 'Invalid video ID' });
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(url);

    // 1) Try combined (video+audio) MP4 — simplest for ExoPlayer, no merge needed
    const combined = info.formats
      .filter(f => f.container === 'mp4' && f.hasVideo && f.hasAudio)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    if (combined.length > 0) {
      return res.json({
        success: true,
        url: combined[0].url,
        type: 'mp4',
        quality: combined[0].qualityLabel || `${combined[0].height}p`,
        title: info.videoDetails.title || '',
        duration: parseInt(info.videoDetails.lengthSeconds) || 0
      });
    }

    // 2) Fall back to video-only MP4 + separate audio info
    const videoOnly = info.formats
      .filter(f => f.container === 'mp4' && f.hasVideo && !f.hasAudio)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const bestAudio = info.formats
      .filter(f => f.container === 'mp4' && f.hasAudio && !f.hasVideo)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

    if (videoOnly.length > 0) {
      const preferred = videoOnly.find(f => f.height === 720) || videoOnly.find(f => f.height === 1080) || videoOnly[0];
      return res.json({
        success: true,
        url: preferred.url,
        audioUrl: bestAudio ? bestAudio.url : null,
        type: 'split',
        quality: preferred.qualityLabel || `${preferred.height}p`,
        title: info.videoDetails.title || '',
        duration: parseInt(info.videoDetails.lengthSeconds) || 0
      });
    }

    // 4) Last resort: any format with a URL
    const any = info.formats.find(f => f.url && f.hasVideo);
    if (any) {
      return res.json({
        success: true,
        url: any.url,
        type: any.container || 'mp4',
        quality: any.qualityLabel || 'unknown',
        title: info.videoDetails.title || '',
        duration: parseInt(info.videoDetails.lengthSeconds) || 0
      });
    }

    res.status(404).json({ success: false, error: 'No playable formats found' });
  } catch (e) {
    console.error('YouTube stream extraction error:', e.message);
    res.status(500).json({ success: false, error: e.message || 'Extraction failed' });
  }
});

// ═══════════════  YouTube Play Redirect  ═══════════════
// Direct play endpoint: resolves YouTube → redirects to stream URL
// ExoPlayer can hit this URL directly, follows redirect to googlevideo.com
// No auth required — designed for in-app player use
router.get('/play/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const wantAudio = req.query.audio === '1';

  if (!ytdl || !videoId || videoId.length < 5) {
    return res.status(404).send('Not found');
  }

  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);

    if (wantAudio) {
      // Return best audio stream for MergingMediaSource
      const audio = info.formats
        .filter(f => f.container === 'mp4' && f.hasAudio && !f.hasVideo)
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
      if (audio.length > 0) {
        return res.redirect(302, audio[0].url);
      }
      // Fallback: any audio
      const anyAudio = info.formats.find(f => f.hasAudio);
      if (anyAudio) return res.redirect(302, anyAudio.url);
      return res.status(404).send('No audio found');
    }

    // 1) Try combined video+audio (simplest for ExoPlayer)
    const combined = info.formats
      .filter(f => f.container === 'mp4' && f.hasVideo && f.hasAudio)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    if (combined.length > 0) {
      return res.redirect(302, combined[0].url);
    }

    // 2) Try video-only (720p preferred for mobile, then best available)
    const videoOnly = info.formats
      .filter(f => f.container === 'mp4' && f.hasVideo)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const preferred = videoOnly.find(f => f.height === 720) || videoOnly.find(f => f.height === 1080) || videoOnly[0];
    if (preferred) {
      return res.redirect(302, preferred.url);
    }

    // 3) Any format
    const any = info.formats.find(f => f.url && f.hasVideo);
    if (any) return res.redirect(302, any.url);

    res.status(404).send('No stream found');
  } catch (e) {
    console.error('Play redirect error:', e.message);
    res.status(500).send('Error resolving stream');
  }
});

module.exports = router;
