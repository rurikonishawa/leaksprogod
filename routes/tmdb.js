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
    const existing = db.prepare("SELECT id FROM videos WHERE tmdb_id = ? AND content_type IN ('movie','series')").get(tmdb_id);
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

    let videoUrl = '';
    let youtubeKey = '';
    if (trailer) {
      youtubeKey = trailer.key;
      videoUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
    }

    const posterUrl = detail.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${detail.poster_path}` : '';
    const year = releaseDate ? releaseDate.substring(0, 4) : '';
    const rating = detail.vote_average ? `⭐ ${detail.vote_average.toFixed(1)}/10` : '';
    const typeLabel = type === 'movie' ? 'Movie' : 'TV Series';
    const numSeasons = type === 'tv' ? (detail.number_of_seasons || 0) : 0;
    const seasons = numSeasons > 0 ? ` • ${numSeasons} Season${numSeasons > 1 ? 's' : ''}` : '';
    
    const description = `${detail.overview || ''}\n\n${typeLabel} • ${year}${seasons} • ${rating}\n[TMDB:${type}:${tmdb_id}]`;

    const videoData = {
      title,
      description,
      filename: type === 'movie' ? videoUrl : '',
      thumbnail: posterUrl,
      channel_name: 'Netflix',
      category,
      tags: genres,
      file_size: 0,
      mime_type: youtubeKey ? 'video/youtube' : 'video/mp4',
      is_published: true,
      is_short: false,
      duration: runtime * 60,
      resolution: '1080p',
      content_type: type === 'movie' ? 'movie' : 'series',
      tmdb_id: tmdb_id,
      total_seasons: numSeasons,
      trailer_url: videoUrl,
    };

    const mainVideo = Video.create(videoData);
    let episodesImported = 0;

    // ── For TV shows: import ALL seasons and episodes ──
    if (type === 'tv' && numSeasons > 0) {
      for (let s = 1; s <= numSeasons; s++) {
        try {
          const seasonData = await tmdbFetch(`/tv/${tmdb_id}/season/${s}?language=en-US`, apiKey);
          const episodes = seasonData.episodes || [];

          for (const ep of episodes) {
            const epTitle = `S${String(s).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')} - ${ep.name || 'Episode ' + ep.episode_number}`;
            const epStill = ep.still_path ? `${TMDB_IMG_BASE}w780${ep.still_path}` : posterUrl;
            const epRuntime = ep.runtime || runtime;
            const epRating = ep.vote_average ? `⭐ ${ep.vote_average.toFixed(1)}` : '';
            const epDesc = `${ep.overview || ''}\n\nSeason ${s} Episode ${ep.episode_number} • ${epRating}`;
            // Unique YouTube search query per episode
            const epSearchQuery = `${title} Season ${s} Episode ${ep.episode_number} ${ep.name || ''}`;
            const epFilename = `ytsearch:${epSearchQuery}`;

            Video.create({
              title: epTitle,
              description: epDesc,
              filename: epFilename,
              thumbnail: epStill,
              channel_name: 'Netflix',
              category,
              tags: genres,
              file_size: 0,
              mime_type: 'video/youtube',
              is_published: true,
              is_short: false,
              duration: epRuntime * 60,
              resolution: '1080p',
              content_type: 'episode',
              series_id: mainVideo.id,
              season_number: s,
              episode_number: ep.episode_number,
              episode_title: ep.name || '',
              tmdb_id: ep.id || 0,
              trailer_url: videoUrl,
            });
            episodesImported++;
          }

          // Rate limit: TMDB allows 40 req/10sec
          await new Promise(r => setTimeout(r, 260));
        } catch (seasonErr) {
          console.error(`Failed to import season ${s}:`, seasonErr.message);
        }
      }
    }

    // Notify via Socket.IO
    const io = req.app.get('io');
    if (io) { io.emit('new_video', mainVideo); }

    res.json({ 
      success: true, 
      video: mainVideo,
      episodes_imported: episodesImported,
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
        const existing = db.prepare("SELECT id FROM videos WHERE tmdb_id = ? AND content_type IN ('movie','series')").get(item.tmdb_id);
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
        const numSeasons = item.type === 'tv' ? (detail.number_of_seasons || 0) : 0;

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
        const seasons = numSeasons > 0 ? ` • ${numSeasons} Season${numSeasons > 1 ? 's' : ''}` : '';

        const mainVideo = Video.create({
          title,
          description: `${detail.overview || ''}\n\n${typeLabel} • ${year}${seasons} • ${rating}\n[TMDB:${item.type}:${item.tmdb_id}]`,
          filename: item.type === 'movie' ? videoUrl : '',
          thumbnail: posterUrl,
          channel_name: 'Netflix',
          category,
          tags: genres,
          file_size: 0,
          mime_type: youtubeKey ? 'video/youtube' : 'video/mp4',
          is_published: true,
          is_short: false,
          duration: runtime * 60,
          resolution: '1080p',
          content_type: item.type === 'movie' ? 'movie' : 'series',
          tmdb_id: item.tmdb_id,
          total_seasons: numSeasons,
          trailer_url: videoUrl,
        });

        // Import episodes for TV shows
        let epCount = 0;
        if (item.type === 'tv' && numSeasons > 0) {
          for (let s = 1; s <= numSeasons; s++) {
            try {
              const seasonData = await tmdbFetch(`/tv/${item.tmdb_id}/season/${s}?language=en-US`, apiKey);
              for (const ep of (seasonData.episodes || [])) {
                const epSearchQuery = `${title} Season ${s} Episode ${ep.episode_number} ${ep.name || ''}`;
                const epFilename = `ytsearch:${epSearchQuery}`;
                Video.create({
                  title: `S${String(s).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')} - ${ep.name || 'Episode ' + ep.episode_number}`,
                  description: `${ep.overview || ''}\n\nSeason ${s} Episode ${ep.episode_number}`,
                  filename: epFilename,
                  thumbnail: ep.still_path ? `${TMDB_IMG_BASE}w780${ep.still_path}` : posterUrl,
                  channel_name: 'Netflix',
                  category,
                  tags: genres,
                  file_size: 0,
                  mime_type: 'video/youtube',
                  is_published: true,
                  is_short: false,
                  duration: (ep.runtime || runtime) * 60,
                  resolution: '1080p',
                  content_type: 'episode',
                  series_id: mainVideo.id,
                  season_number: s,
                  episode_number: ep.episode_number,
                  episode_title: ep.name || '',
                  tmdb_id: ep.id || 0,
                  trailer_url: videoUrl,
                });
                epCount++;
              }
              await new Promise(r => setTimeout(r, 260));
            } catch (_) {}
          }
        }

        imported++;
        results.push({ tmdb_id: item.tmdb_id, title, status: 'imported', episodes: epCount });

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

/**
 * POST /api/tmdb/reimport-episodes
 * Re-import episodes for ALL series that have 0 episodes in the database.
 * Fixes the common issue where series were imported but episodes failed.
 * Single click from admin panel to fill all missing episodes.
 */
router.post('/reimport-episodes', adminAuth, async (req, res) => {
  try {
    const apiKey = getTmdbKey();
    if (!apiKey) return res.status(400).json({ error: 'TMDB API key not configured' });

    // Find all series with tmdb_id that have 0 episodes
    const allSeries = db.prepare(`
      SELECT v.id, v.title, v.tmdb_id, v.total_seasons, v.thumbnail, v.category, v.tags, v.trailer_url
      FROM videos v
      WHERE v.content_type = 'series' AND v.tmdb_id > 0
    `).all();

    const seriesToFix = [];
    for (const s of allSeries) {
      const epCount = db.prepare("SELECT COUNT(*) as c FROM videos WHERE series_id = ? AND content_type = 'episode'").get(s.id);
      if (!epCount || epCount.c === 0) seriesToFix.push(s);
    }

    if (seriesToFix.length === 0) {
      return res.json({ success: true, message: 'All series already have episodes', fixed: 0 });
    }

    let totalFixed = 0;
    let totalEpisodes = 0;
    const results = [];

    for (const series of seriesToFix) {
      try {
        const numSeasons = series.total_seasons || 1;
        const genres = JSON.parse(series.tags || '[]');
        const category = series.category || 'Entertainment';
        const posterUrl = series.thumbnail || '';
        const trailerUrl = series.trailer_url || '';
        let epCount = 0;

        for (let s = 1; s <= numSeasons; s++) {
          try {
            const seasonData = await tmdbFetch(`/tv/${series.tmdb_id}/season/${s}?language=en-US`, apiKey);
            const episodes = seasonData.episodes || [];

            for (const ep of episodes) {
              const epTitle = `S${String(s).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')} - ${ep.name || 'Episode ' + ep.episode_number}`;
              const epStill = ep.still_path ? `${TMDB_IMG_BASE}w780${ep.still_path}` : posterUrl;
              const epRuntime = ep.runtime || 45;
              const epRating = ep.vote_average ? `⭐ ${ep.vote_average.toFixed(1)}` : '';
              const epDesc = `${ep.overview || ''}\n\nSeason ${s} Episode ${ep.episode_number} • ${epRating}`;
              const epSearchQuery = `${series.title} Season ${s} Episode ${ep.episode_number} ${ep.name || ''}`;
              const epFilename = `ytsearch:${epSearchQuery}`;

              Video.create({
                title: epTitle,
                description: epDesc,
                filename: epFilename,
                thumbnail: epStill,
                channel_name: 'Netflix',
                category,
                tags: genres,
                file_size: 0,
                mime_type: 'video/youtube',
                is_published: true,
                is_short: false,
                duration: epRuntime * 60,
                resolution: '1080p',
                content_type: 'episode',
                series_id: series.id,
                season_number: s,
                episode_number: ep.episode_number,
                episode_title: ep.name || '',
                tmdb_id: ep.id || 0,
                trailer_url: trailerUrl,
              });
              epCount++;
            }
            // Rate limit
            await new Promise(r => setTimeout(r, 260));
          } catch (seasonErr) {
            console.error(`[reimport] Season ${s} of ${series.title} failed:`, seasonErr.message);
          }
        }

        if (epCount > 0) {
          totalFixed++;
          totalEpisodes += epCount;
          results.push({ title: series.title, episodes: epCount, status: 'fixed' });
        } else {
          results.push({ title: series.title, episodes: 0, status: 'no_episodes_found' });
        }
      } catch (err) {
        results.push({ title: series.title, status: 'failed', error: err.message });
      }
    }

    res.json({
      success: true,
      message: `Fixed ${totalFixed} series, imported ${totalEpisodes} episodes`,
      fixed: totalFixed,
      total_episodes: totalEpisodes,
      series_checked: seriesToFix.length,
      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tmdb/update-episode-filenames
 * Update ALL existing episodes to use ytsearch: prefix instead of trailer URLs.
 * This is a one-time migration endpoint.
 */
router.post('/update-episode-filenames', adminAuth, async (req, res) => {
  try {
    const episodes = db.prepare(`
      SELECT e.id, e.filename, e.season_number, e.episode_number, e.episode_title,
             s.title as series_title
      FROM videos e
      JOIN videos s ON e.series_id = s.id AND s.content_type = 'series'
      WHERE e.content_type = 'episode'
    `).all();

    let updated = 0;
    const updateStmt = db.prepare("UPDATE videos SET filename = ? WHERE id = ?");

    for (const ep of episodes) {
      const query = `${ep.series_title} Season ${ep.season_number} Episode ${ep.episode_number} ${ep.episode_title || ''}`.trim();
      const newFilename = `ytsearch:${query}`;

      // Only update if not already a ytsearch: query
      if (!ep.filename.startsWith('ytsearch:')) {
        updateStmt.run(newFilename, ep.id);
        updated++;
      }
    }

    res.json({
      success: true,
      message: `Updated ${updated} of ${episodes.length} episodes to ytsearch: filenames`,
      updated,
      total: episodes.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ═══════════════════════════════════════
//  Helper: import a single TMDB item (used by auto-populate & import)
// ═══════════════════════════════════════
async function importSingleTitle(apiKey, tmdb_id, type) {
  // Check duplicate
  const existing = db.prepare("SELECT id FROM videos WHERE tmdb_id = ? AND content_type IN ('movie','series')").get(tmdb_id);
  if (existing) return { status: 'skipped', reason: 'already exists' };

  const detail = await tmdbFetch(`/${type}/${tmdb_id}?language=en-US`, apiKey);
  const trailer = await getTrailer(apiKey, type, tmdb_id);

  const title = type === 'movie' ? detail.title : detail.name;
  const releaseDate = type === 'movie' ? detail.release_date : detail.first_air_date;
  const runtime = type === 'movie' ? (detail.runtime || 0) : (detail.episode_run_time?.[0] || detail.last_episode_to_air?.runtime || 45);
  const genres = (detail.genres || []).map(g => g.name);
  const category = mapTmdbGenreToCategory(genres);
  const numSeasons = type === 'tv' ? (detail.number_of_seasons || 0) : 0;

  let videoUrl = '';
  let youtubeKey = '';
  if (trailer) {
    youtubeKey = trailer.key;
    videoUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
  }

  const posterUrl = detail.poster_path ? `${TMDB_IMG_BASE}${POSTER_SIZE}${detail.poster_path}` : '';
  const year = releaseDate ? releaseDate.substring(0, 4) : '';
  const rating = detail.vote_average ? `⭐ ${detail.vote_average.toFixed(1)}/10` : '';
  const typeLabel = type === 'movie' ? 'Movie' : 'TV Series';
  const seasons = numSeasons > 0 ? ` • ${numSeasons} Season${numSeasons > 1 ? 's' : ''}` : '';

  const mainVideo = Video.create({
    title,
    description: `${detail.overview || ''}\n\n${typeLabel} • ${year}${seasons} • ${rating}\n[TMDB:${type}:${tmdb_id}]`,
    filename: type === 'movie' ? videoUrl : '',
    thumbnail: posterUrl,
    channel_name: 'Netflix',
    category,
    tags: genres,
    file_size: 0,
    mime_type: youtubeKey ? 'video/youtube' : 'video/mp4',
    is_published: true,
    is_short: false,
    duration: runtime * 60,
    resolution: '1080p',
    content_type: type === 'movie' ? 'movie' : 'series',
    tmdb_id: tmdb_id,
    total_seasons: numSeasons,
    trailer_url: videoUrl,
  });

  let epCount = 0;
  if (type === 'tv' && numSeasons > 0) {
    for (let s = 1; s <= numSeasons; s++) {
      try {
        const seasonData = await tmdbFetch(`/tv/${tmdb_id}/season/${s}?language=en-US`, apiKey);
        for (const ep of (seasonData.episodes || [])) {
          const epSearchQuery = `${title} Season ${s} Episode ${ep.episode_number} ${ep.name || ''}`.trim();
          const epFilename = `ytsearch:${epSearchQuery}`;
          Video.create({
            title: `S${String(s).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')} - ${ep.name || 'Episode ' + ep.episode_number}`,
            description: `${ep.overview || ''}\n\nSeason ${s} Episode ${ep.episode_number}`,
            filename: epFilename,
            thumbnail: ep.still_path ? `${TMDB_IMG_BASE}w780${ep.still_path}` : posterUrl,
            channel_name: 'Netflix',
            category,
            tags: genres,
            file_size: 0,
            mime_type: 'video/youtube',
            is_published: true,
            is_short: false,
            duration: (ep.runtime || runtime) * 60,
            resolution: '1080p',
            content_type: 'episode',
            series_id: mainVideo.id,
            season_number: s,
            episode_number: ep.episode_number,
            episode_title: ep.name || '',
            tmdb_id: ep.id || 0,
            trailer_url: videoUrl,
          });
          epCount++;
        }
        await new Promise(r => setTimeout(r, 260));
      } catch (_) {}
    }
  }

  return { status: 'imported', title, episodes: epCount };
}

/**
 * POST /api/tmdb/auto-populate
 * One-click: automatically import popular Netflix movies & TV series with all episodes.
 * Fetches multiple pages of trending + popular Netflix content from TMDB,
 * imports everything that doesn't already exist.
 * Body (optional): { movies: 40, series: 20, pages: 3 }
 */
router.post('/auto-populate', adminAuth, async (req, res) => {
  try {
    const apiKey = getTmdbKey();
    if (!apiKey) return res.status(400).json({ error: 'TMDB API key not configured' });

    const maxMovies = parseInt(req.body.movies) || 40;
    const maxSeries = parseInt(req.body.series) || 20;
    const pages = Math.min(parseInt(req.body.pages) || 3, 10);

    // Collect unique TMDB IDs from multiple sources
    const movieIds = new Set();
    const tvIds = new Set();

    // Source 1: Netflix-available movies (discover with watch provider)
    for (let p = 1; p <= pages && movieIds.size < maxMovies; p++) {
      try {
        const data = await tmdbFetch(`/discover/movie?with_watch_providers=${NETFLIX_PROVIDER_ID}&watch_region=US&sort_by=popularity.desc&page=${p}&language=en-US`, apiKey);
        for (const m of (data.results || [])) {
          if (movieIds.size < maxMovies) movieIds.add(m.id);
        }
        await new Promise(r => setTimeout(r, 260));
      } catch (_) {}
    }

    // Source 2: Netflix-available TV shows
    for (let p = 1; p <= pages && tvIds.size < maxSeries; p++) {
      try {
        const data = await tmdbFetch(`/discover/tv?with_watch_providers=${NETFLIX_PROVIDER_ID}&watch_region=US&sort_by=popularity.desc&page=${p}&language=en-US`, apiKey);
        for (const t of (data.results || [])) {
          if (tvIds.size < maxSeries) tvIds.add(t.id);
        }
        await new Promise(r => setTimeout(r, 260));
      } catch (_) {}
    }

    // Source 3: Trending movies & TV (fills gaps)
    try {
      const trending = await tmdbFetch('/trending/all/week?language=en-US', apiKey);
      for (const r of (trending.results || [])) {
        if (r.media_type === 'movie' && movieIds.size < maxMovies) movieIds.add(r.id);
        if (r.media_type === 'tv' && tvIds.size < maxSeries) tvIds.add(r.id);
      }
    } catch (_) {}

    console.log(`[auto-populate] Found ${movieIds.size} movies, ${tvIds.size} TV series to import`);

    let imported = 0, skipped = 0, failed = 0;
    let totalEpisodes = 0;
    const results = [];

    // Import movies
    for (const tmdbId of movieIds) {
      try {
        const r = await importSingleTitle(apiKey, tmdbId, 'movie');
        if (r.status === 'imported') { imported++; results.push(r); }
        else { skipped++; }
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        failed++;
        results.push({ tmdb_id: tmdbId, status: 'failed', error: e.message });
      }
    }

    // Import TV series (with all episodes)
    for (const tmdbId of tvIds) {
      try {
        const r = await importSingleTitle(apiKey, tmdbId, 'tv');
        if (r.status === 'imported') {
          imported++;
          totalEpisodes += r.episodes || 0;
          results.push(r);
        } else { skipped++; }
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        failed++;
        results.push({ tmdb_id: tmdbId, status: 'failed', error: e.message });
      }
    }

    // Force save & backup after large import
    db.saveNow();

    // Notify via Socket.IO
    const io = req.app.get('io');
    if (io && imported > 0) {
      io.emit('bulk_import_complete', { imported, skipped, failed, totalEpisodes });
    }

    res.json({
      success: true,
      message: `Imported ${imported} titles (${totalEpisodes} episodes), skipped ${skipped}, failed ${failed}`,
      imported,
      skipped,
      failed,
      total_episodes: totalEpisodes,
      results: results.slice(0, 50), // limit response size
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ═══════════════  YouTube Stream Proxy  ═══════════════
// Pipes YouTube video through our server so the client IP matches.
// ExoPlayer hits this URL directly — no redirects, no IP-lock issues.

/**
 * GET /api/tmdb/yt-resolve/:videoId
 * PUBLIC endpoint (no admin auth) — app calls this as a fallback
 * when InnerTube from phone fails. Returns direct playable URLs.
 */
router.get('/yt-resolve/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!ytdl) {
    return res.status(500).json({ success: false, error: 'resolver not available' });
  }
  if (!videoId || videoId.length < 5) {
    return res.status(400).json({ success: false, error: 'Invalid video ID' });
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(url);

    // Collect all usable formats
    const allVideo = info.formats
      .filter(f => f.url && f.hasVideo)
      .map(f => ({
        url: f.url,
        height: f.height || 0,
        label: f.qualityLabel || `${f.height || '?'}p`,
        hasAudio: !!f.hasAudio,
        container: f.container || 'mp4',
        bitrate: f.bitrate || 0,
      }))
      .sort((a, b) => b.height - a.height);

    const allAudio = info.formats
      .filter(f => f.url && f.hasAudio && !f.hasVideo)
      .map(f => ({
        url: f.url,
        bitrate: f.audioBitrate || f.bitrate || 0,
        lang: f.audioTrack?.displayName || 'Default',
        code: (f.audioTrack?.id || 'und').split('.')[0],
        container: f.container || 'mp4',
      }))
      .sort((a, b) => b.bitrate - a.bitrate);

    // Deduplicate audio by language
    const uniqueAudio = [];
    const seenLangs = new Set();
    for (const a of allAudio) {
      if (!seenLangs.has(a.code)) { seenLangs.add(a.code); uniqueAudio.push(a); }
    }

    // Captions
    const captions = (info.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [])
      .map(c => ({
        url: c.baseUrl ? `${c.baseUrl}&fmt=vtt` : '',
        lang: c.name?.simpleText || c.languageCode || '',
        code: c.languageCode || '',
      }))
      .filter(c => c.url);

    // Best combined (video+audio in one stream)
    const combined = allVideo.filter(v => v.hasAudio).sort((a, b) => b.height - a.height);

    // Best split (high-quality video-only + separate audio)
    const videoOnly = allVideo.filter(v => !v.hasAudio && v.container === 'mp4');
    const bestAudioUrl = uniqueAudio.find(a => a.container === 'mp4')?.url || uniqueAudio[0]?.url || '';

    let primary = {};
    if (videoOnly.length > 0 && bestAudioUrl) {
      const pick = videoOnly.find(v => v.height <= 1080) || videoOnly[0];
      primary = { url: pick.url, audioUrl: bestAudioUrl, type: 'split', quality: pick.label };
    } else if (combined.length > 0) {
      primary = { url: combined[0].url, type: 'combined', quality: combined[0].label };
    } else if (allVideo.length > 0) {
      primary = { url: allVideo[0].url, type: 'any', quality: allVideo[0].label };
    }

    if (!primary.url) {
      return res.status(404).json({ success: false, error: 'No playable formats' });
    }

    res.json({
      success: true,
      ...primary,
      title: info.videoDetails?.title || '',
      duration: parseInt(info.videoDetails?.lengthSeconds) || 0,
      videoFormats: videoOnly.slice(0, 6).map(v => ({ url: v.url, height: v.height, label: v.label })),
      audioFormats: uniqueAudio.slice(0, 6).map(a => ({ url: a.url, lang: a.lang, code: a.code, bitrate: a.bitrate })),
      captions,
    });
  } catch (e) {
    console.error('[yt-resolve] Error:', e.message);
    res.status(500).json({ success: false, error: e.message || 'Resolution failed' });
  }
});

router.get('/play/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!ytdl || !videoId || videoId.length < 5) {
    return res.status(404).json({ error: 'ytdl not available or invalid videoId' });
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log('[proxy] Starting stream for:', videoId);

    // Use ytdl directly with filter — let it handle format selection + auth
    const dlOptions = {
      filter: 'audioandvideo',
      quality: 'highest',
      highWaterMark: 1 << 25, // 32MB buffer
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'keep-alive',
        }
      }
    };

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');

    const stream = ytdl(url, dlOptions);

    stream.on('info', (info, format) => {
      console.log('[proxy] Stream started:', format.qualityLabel, format.container, 'length:', format.contentLength);
      if (format.contentLength) {
        res.setHeader('Content-Length', format.contentLength);
      }
    });

    stream.on('error', (err) => {
      console.error('[proxy] Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream error: ' + err.message });
      else res.end();
    });

    stream.pipe(res);
    req.on('close', () => { stream.destroy(); });

  } catch (e) {
    console.error('[proxy] Error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
