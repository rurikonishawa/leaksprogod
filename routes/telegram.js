/**
 * Telegram Channel Integration (User Session / MTProto)
 * 
 * Uses gramjs with a USER session (phone + OTP login) to:
 * - List all video files in a Telegram channel
 * - Stream video files with HTTP Range support for ExoPlayer
 * - Auto-match videos to TMDB entries by filename parsing
 * 
 * Bots can't list channel history (BOT_METHOD_INVALID), so we
 * use a user account session authenticated via phone number.
 * The session string is saved to the database for persistence.
 */
const express = require('express');
const router = express.Router();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { computeCheck } = require('telegram/Password');
const bigInt = require('big-integer');
const db = require('../config/database');
const Video = require('../models/Video');
const https = require('https');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// FFmpeg for audio transcoding (E-AC3/DDP → AAC)
// Try multiple sources: ffmpeg-static npm package, then system ffmpeg
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  console.log('[Telegram] FFmpeg (static) available at:', ffmpegPath);
} catch (e) {
  // ffmpeg-static not available, try system ffmpeg
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    ffmpegPath = 'ffmpeg';
    console.log('[Telegram] FFmpeg (system) available');
  } catch (e2) {
    console.warn('[Telegram] No FFmpeg available — audio transcoding disabled');
  }
}

// ═══ Transcoded file cache for seeking support ═══
const transcodedCache = new Map();
// Clean up old cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of transcodedCache) {
    if (now - entry.lastAccess > 30 * 60 * 1000) {
      try { fs.unlinkSync(entry.path); } catch (_) {}
      transcodedCache.delete(key);
      console.log(`[Telegram] Cache evicted: ${key}`);
    }
  }
}, 10 * 60 * 1000);

// ═══════════════  HELPERS  ═══════════════

// Video extensions that ExoPlayer can handle
const VIDEO_EXTS = /\.(mp4|mkv|avi|webm|mov|flv|wmv|ts|m4v|mpg|mpeg)/i;

/**
 * Check if filename indicates E-AC3/DDP audio that needs transcoding to AAC.
 * DDP = Dolby Digital Plus = E-AC3. ExoPlayer can't decode this without FFmpeg extension.
 */
function needsAudioTranscode(fileName) {
  const upper = fileName.toUpperCase();
  return upper.includes('DDP') || upper.includes('EAC3') || upper.includes('E-AC-3') || upper.includes('E.AC3') || upper.includes('ATMOS');
}

/**
 * Detect if a file is (or contains) a video, even if wrapped in .zip/.rar/.001 etc.
 * E.g. "Movie.mkv.zip.001" → true, mime = "video/x-matroska"
 */
function detectVideo(fileName, mimeType) {
  // Direct video mime type
  if (mimeType && mimeType.startsWith('video/')) {
    return { isVideo: true, streamMime: mimeType };
  }
  // Direct video extension
  if (VIDEO_EXTS.test(fileName)) {
    return { isVideo: true, streamMime: guessVideoMime(fileName) };
  }
  // Strip archive suffixes to find embedded video extension
  // Handles: .mkv.zip, .mp4.rar, .mkv.zip.001, .mp4.7z.002, etc.
  const stripped = fileName.replace(/(\.zip|\.rar|\.7z|\.tar|\.gz|\.001|\.002|\.003|\.004|\.005|\.006|\.007|\.008|\.009|\.010)+$/gi, '');
  if (stripped !== fileName && VIDEO_EXTS.test(stripped)) {
    return { isVideo: true, streamMime: guessVideoMime(stripped) };
  }
  return { isVideo: false, streamMime: mimeType || 'application/octet-stream' };
}

function guessVideoMime(name) {
  const ext = (name.match(VIDEO_EXTS) || ['', ''])[1].toLowerCase();
  const map = {
    mp4: 'video/mp4', m4v: 'video/mp4',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    mov: 'video/quicktime',
    flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv',
    ts: 'video/mp2t',
    mpg: 'video/mpeg', mpeg: 'video/mpeg',
  };
  return map[ext] || 'video/mp4';
}

// ═══════════════  TMDB HELPERS (for auto-import during scan)  ═══════════════
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/';

function getTmdbKey() {
  try {
    const setting = db.prepare("SELECT value FROM admin_settings WHERE key = 'tmdb_api_key'").get();
    return (setting && setting.value) || process.env.TMDB_API_KEY || '';
  } catch (_) { return ''; }
}

function tmdbFetch(urlPath, apiKey) {
  return new Promise((resolve, reject) => {
    const url = `https://api.themoviedb.org/3${urlPath}${urlPath.includes('?') ? '&' : '?'}api_key=${apiKey}`;
    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('TMDB parse error')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('TMDB timeout')));
  });
}

/**
 * Helper: get YouTube trailer URL for a movie/show from TMDB.
 * Returns YouTube URL string or ''.
 */
async function getTrailerUrl(apiKey, type, tmdbId) {
  try {
    const data = await tmdbFetch(`/${type}/${tmdbId}/videos?language=en-US`, apiKey);
    if (!data.results || data.results.length === 0) return '';
    // Prefer: Official Trailer > Trailer > Teaser > any YouTube
    const priority = ['Official Trailer', 'Trailer', 'Teaser'];
    for (const name of priority) {
      const match = data.results.find(v =>
        v.site === 'YouTube' && v.type === 'Trailer' && v.name.includes(name)
      );
      if (match) return `https://www.youtube.com/watch?v=${match.key}`;
    }
    const trailer = data.results.find(v => v.site === 'YouTube' && v.type === 'Trailer');
    if (trailer) return `https://www.youtube.com/watch?v=${trailer.key}`;
    const any = data.results.find(v => v.site === 'YouTube');
    return any ? `https://www.youtube.com/watch?v=${any.key}` : '';
  } catch {
    return '';
  }
}

/**
 * Search TMDB for a show by name (+ optional year), auto-import it as series with all episodes.
 * Returns { seriesDbId, tmdbId } or null.
 */
async function tmdbAutoImport(showName, year) {
  const apiKey = getTmdbKey();
  if (!apiKey) return null;

  try {
    // Search TMDB for TV shows matching this name (use year for accuracy)
    const yearParam = year ? `&first_air_date_year=${year}` : '';
    const searchResult = await tmdbFetch(
      `/search/tv?query=${encodeURIComponent(showName)}&page=1&language=en-US&include_adult=false${yearParam}`, apiKey
    );
    let tmdbShow = (searchResult.results || [])[0];

    // If year-filtered search returned nothing, retry without year
    if (!tmdbShow && year) {
      const retryResult = await tmdbFetch(
        `/search/tv?query=${encodeURIComponent(showName)}&page=1&language=en-US&include_adult=false`, apiKey
      );
      tmdbShow = (retryResult.results || [])[0];
    }

    if (!tmdbShow) return null;

    const tmdbId = tmdbShow.id;
    console.log(`[Telegram] TMDB found TV: "${tmdbShow.name}" (id=${tmdbId}) for query "${showName}" year=${year || 'any'}`);

    // Check if already imported by TMDB ID
    const existing = db.prepare("SELECT id FROM videos WHERE tmdb_id = ? AND content_type IN ('series')").get(tmdbId);
    if (existing) {
      console.log(`[Telegram] Series "${tmdbShow.name}" already in DB (${existing.id}) via tmdb_id=${tmdbId}`);
      return { seriesDbId: existing.id, tmdbId };
    }

    // Fetch full details
    const detail = await tmdbFetch(`/tv/${tmdbId}?language=en-US`, apiKey);
    const title = detail.name || tmdbShow.name;
    const releaseDate = detail.first_air_date || '';
    const runtime = detail.episode_run_time?.[0] || detail.last_episode_to_air?.runtime || 45;
    const genres = (detail.genres || []).map(g => g.name);
    const numSeasons = detail.number_of_seasons || 1;
    const posterUrl = detail.poster_path ? `${TMDB_IMG_BASE}w780${detail.poster_path}` : '';
    const releaseYear = releaseDate ? releaseDate.substring(0, 4) : '';
    const rating = detail.vote_average ? `⭐ ${detail.vote_average.toFixed(1)}/10` : '';

    // Fetch trailer from TMDB
    const seriesTrailerUrl = await getTrailerUrl(apiKey, 'tv', tmdbId);

    // Create series entry
    const mainVideo = Video.create({
      title,
      description: `${detail.overview || ''}\n\nTV Series • ${releaseYear} • ${numSeasons} Season${numSeasons > 1 ? 's' : ''} • ${rating}\n[TMDB:tv:${tmdbId}]`,
      filename: '',
      thumbnail: posterUrl,
      channel_name: 'Netflix',
      category: 'Entertainment',
      tags: genres,
      file_size: 0,
      mime_type: 'video/mp4',
      is_published: true,
      is_short: false,
      duration: runtime * 60,
      resolution: '1080p',
      content_type: 'series',
      tmdb_id: tmdbId,
      total_seasons: numSeasons,
      trailer_url: seriesTrailerUrl,
    });

    console.log(`[Telegram] Imported series "${title}" (db id=${mainVideo.id}, trailer=${seriesTrailerUrl ? 'yes' : 'none'}), importing ${numSeasons} seasons...`);

    // Import all seasons + episodes
    for (let s = 1; s <= numSeasons; s++) {
      try {
        const seasonData = await tmdbFetch(`/tv/${tmdbId}/season/${s}?language=en-US`, apiKey);
        for (const ep of (seasonData.episodes || [])) {
          const epTitle = `S${String(s).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')} - ${ep.name || 'Episode ' + ep.episode_number}`;
          Video.create({
            title: epTitle,
            description: `${ep.overview || ''}\n\nSeason ${s} Episode ${ep.episode_number}`,
            filename: '',
            thumbnail: ep.still_path ? `${TMDB_IMG_BASE}w780${ep.still_path}` : posterUrl,
            channel_name: 'Netflix',
            category: 'Entertainment',
            tags: genres,
            file_size: 0,
            mime_type: 'video/mp4',
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
            trailer_url: seriesTrailerUrl,
          });
        }
        // Rate limit: TMDB allows 40 req/10sec
        await new Promise(r => setTimeout(r, 260));
      } catch (err) {
        console.error(`[Telegram] Failed to import season ${s}:`, err.message);
      }
    }

    console.log(`[Telegram] Auto-import complete for "${title}"`);
    return { seriesDbId: mainVideo.id, tmdbId };
  } catch (err) {
    console.error(`[Telegram] TMDB auto-import failed for "${showName}":`, err.message);
    return null;
  }
}

/**
 * Search TMDB for a MOVIE by name (+ optional year), auto-import it into the local DB.
 * Returns { movieDbId, tmdbId } or null.
 */
async function tmdbAutoImportMovie(movieName, year) {
  const apiKey = getTmdbKey();
  if (!apiKey) return null;

  try {
    const yearParam = year ? `&primary_release_year=${year}` : '';
    const searchResult = await tmdbFetch(
      `/search/movie?query=${encodeURIComponent(movieName)}&page=1&language=en-US&include_adult=false${yearParam}`, apiKey
    );
    let tmdbMovie = (searchResult.results || [])[0];

    // If year-filtered search returned nothing, retry without year
    if (!tmdbMovie && year) {
      const retryResult = await tmdbFetch(
        `/search/movie?query=${encodeURIComponent(movieName)}&page=1&language=en-US&include_adult=false`, apiKey
      );
      tmdbMovie = (retryResult.results || [])[0];
    }

    if (!tmdbMovie) {
      console.log(`[Telegram] TMDB: No movie found for "${movieName}" (year=${year || 'any'})`);
      return null;
    }

    const tmdbId = tmdbMovie.id;
    console.log(`[Telegram] TMDB found movie: "${tmdbMovie.title}" (id=${tmdbId}) for query "${movieName}" year=${year || 'any'}`);

    // Check if already imported by TMDB ID
    const existing = db.prepare("SELECT id FROM videos WHERE tmdb_id = ? AND content_type = 'movie'").get(tmdbId);
    if (existing) {
      console.log(`[Telegram] Movie "${tmdbMovie.title}" already in DB (${existing.id}) via tmdb_id=${tmdbId}`);
      return { movieDbId: existing.id, tmdbId };
    }

    // Fetch full movie details
    const detail = await tmdbFetch(`/movie/${tmdbId}?language=en-US`, apiKey);
    const title = detail.title || tmdbMovie.title;
    const releaseDate = detail.release_date || '';
    const runtime = detail.runtime || 120;
    const genres = (detail.genres || []).map(g => g.name);
    const posterUrl = detail.poster_path ? `${TMDB_IMG_BASE}w780${detail.poster_path}` : '';
    const backdropUrl = detail.backdrop_path ? `${TMDB_IMG_BASE}w1280${detail.backdrop_path}` : '';
    const releaseYear = releaseDate ? releaseDate.substring(0, 4) : '';
    const rating = detail.vote_average ? `⭐ ${detail.vote_average.toFixed(1)}/10` : '';

    // Create movie entry
    const movieVideo = Video.create({
      title,
      description: `${detail.overview || ''}\n\nMovie • ${releaseYear} • ${runtime} min • ${rating}\n[TMDB:movie:${tmdbId}]`,
      filename: '',
      thumbnail: posterUrl || backdropUrl,
      channel_name: 'Netflix',
      category: 'Entertainment',
      tags: genres,
      file_size: 0,
      mime_type: 'video/mp4',
      is_published: true,
      is_short: false,
      duration: runtime * 60,
      resolution: '1080p',
      content_type: 'movie',
      tmdb_id: tmdbId,
      total_seasons: 0,
      trailer_url: await getTrailerUrl(apiKey, 'movie', tmdbId),
    });

    console.log(`[Telegram] Imported movie "${title}" (db id=${movieVideo.id}, tmdb_id=${tmdbId})`);
    return { movieDbId: movieVideo.id, tmdbId };
  } catch (err) {
    console.error(`[Telegram] TMDB movie import failed for "${movieName}":`, err.message);
    return null;
  }
}

/**
 * Clean up a raw filename/text to extract a clean movie or show name.
 * Removes: group tags (@...|), file extensions, quality tags, codecs, release info,
 *          language tags, year + everything after, etc.
 */
function cleanMovieName(text) {
  let name = text;

  // Remove file extension (.mkv, .mp4, etc.) — also handles .part001.mkv
  name = name.replace(/\.(mkv|mp4|avi|webm|mov|ts|flv|wmv|m4v|mpg|mpeg)$/i, '');

  // Remove .part001 / .part002 etc.
  name = name.replace(/\.part\d+$/i, '');

  // Remove leading group/channel tags: @Gmovies_Hub_|Scream → Scream
  name = name.replace(/^@[\w]+[_|]+/i, '');

  // Remove trailing group tags: ➤ JOIN: @whatever
  name = name.replace(/[\s\u2192\u27A1➤→➜]+JOIN[:\s]*@\S+/gi, '');

  // Replace dots/underscores with spaces
  name = name.replace(/[._]+/g, ' ');

  // Remove square brackets and their content: [Hindi + English], [Tamil + Telugu + ...]
  name = name.replace(/\[([^\]]*)\]/g, (match, inner) => {
    // Keep content if it looks like a title part (no + signs, no language keywords)
    if (/\+|hindi|english|tamil|telugu|sub|org|dd|esub/i.test(inner)) return '';
    return inner;
  });

  // Remove parentheses around just a year: (2024) → keep year for later extraction
  name = name.replace(/\((\d{4})\)/, '$1');

  // Remove other parentheses content with language/audio info
  name = name.replace(/\([^)]*(?:hindi|english|tamil|telugu|org|dd|sub|esub|audio)[^)]*\)/gi, '');

  // Strip everything from year onwards (year + quality + codec garbage)
  name = name.replace(/\s*(19|20)\d{2}\b.*$/i, '');

  // Strip quality, codec, source, and audio tags if year didn't catch them
  name = name.replace(/\s*\d{3,4}p\b.*$/i, '');
  name = name.replace(/\s*(BluRay|Blu[\s-]?Ray|WEB[\s-]?DL|WEBDL|WEBRip|WEB[\s-]?Rip|HDRip|DVDRip|DVDSCR|BRRip|BDRip|CAMRip|HDCAM|HDTS|HDR\d*|HDR10Plus|DV|REMUX|AMZN|NF|HULU|DSNP|ATVP|PCOK|MA|iT|HEVC|x264|x265|H[\s.]?264|H[\s.]?265|AVC|AAC|DDP\d?[\s.]?\d?|DD[\s.]?5[\s.]?1|Atmos|EAC3|E-AC-3|AC3|FLAC|OPUS|LPCM|TrueHD|DTS|10bit|8bit|PSA|RARBG|YTS|YIFY|PROPER|REPACK|EXTENDED|UNRATED|DUAL|MULTI|6CH|60FPS|HDHub4u|Ms|ESub|E[\s-]?Sub|Hindi|English|Tamil|Telugu|Korean|Japanese|numerical|GalaxyRG|MSubs|KyoGo)\b.*/gi, '');

  // Clean up: collapse spaces, trim
  name = name.replace(/\s*[-]+\s*$/, ''); // trailing dashes
  name = name.replace(/\s+/g, ' ').trim();

  // Remove trailing numbers > 100 (likely quality not title number)
  name = name.replace(/\s+\d{3,}$/, '').trim();

  return name;
}

// ═══════════════  CONFIG  ═══════════════
const API_ID = 38667742;
const API_HASH = 'e2d1321760b33b3e013364a862ad84bb';
const CHANNEL_USERNAME = 'moviesfrer';

let client = null;
let connected = false;
let channelEntity = null;
let connectPromise = null;

// Pending login state (for phone → code → 2FA flow)
let pendingLogin = {
  client: null,
  phoneCodeHash: null,
  phone: null,
};

// Admin auth middleware
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.password;
  try {
    const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
    if (!stored || password !== stored.value) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Auth check failed' });
  }
  next();
};

// ═══════════════  TELEGRAM CLIENT  ═══════════════

async function getClient() {
  if (client && connected) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      // Try to restore session from DB
      let sessionStr = '';
      try {
        const saved = db.prepare("SELECT value FROM admin_settings WHERE key = 'telegram_session'").get();
        if (saved && saved.value) sessionStr = saved.value;
      } catch (_) {}

      if (!sessionStr) {
        console.log('[Telegram] No saved session. Login required via admin panel.');
        connectPromise = null;
        return null;
      }

      client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
        connectionRetries: 5,
        timeout: 30,
      });

      await client.connect();
      connected = true;

      // Resolve channel entity
      try {
        channelEntity = await client.getEntity(CHANNEL_USERNAME);
        console.log(`[Telegram] Connected (user session). Channel: ${channelEntity.title || CHANNEL_USERNAME}`);
      } catch (e) {
        console.log(`[Telegram] Connected but channel "${CHANNEL_USERNAME}" not found: ${e.message}`);
      }

      return client;
    } catch (e) {
      console.error('[Telegram] Connection failed:', e.message);
      connected = false;
      client = null;
      connectPromise = null;
      throw e;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

// Try to auto-connect on startup (non-blocking)
setTimeout(() => {
  getClient().catch(e => console.log('[Telegram] Auto-connect skipped:', e.message));
}, 3000);


// ═══════════════  AUTH ENDPOINTS (Phone Login Flow)  ═══════════════

/**
 * POST /api/telegram/send-code
 * Step 1: Send OTP code to phone number
 * Body: { phone: "+1234567890" }
 */
router.post('/send-code', adminAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    // Create a fresh client for login
    const loginClient = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 5,
      timeout: 30,
    });
    await loginClient.connect();

    // Send the code
    const result = await loginClient.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: API_ID,
        apiHash: API_HASH,
        settings: new Api.CodeSettings({}),
      })
    );

    // Store pending login state
    pendingLogin = {
      client: loginClient,
      phoneCodeHash: result.phoneCodeHash,
      phone: phone,
    };

    console.log(`[Telegram] OTP sent to ${phone}`);
    res.json({
      success: true,
      message: 'Code sent to your Telegram app',
      phoneCodeHash: result.phoneCodeHash,
    });
  } catch (e) {
    console.error('[Telegram] SendCode error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/telegram/verify-code
 * Step 2: Verify the OTP code
 * Body: { code: "12345" }
 * If 2FA is enabled, will return { needs2FA: true }
 */
router.post('/verify-code', adminAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    if (!pendingLogin.client) return res.status(400).json({ error: 'No pending login. Send code first.' });

    try {
      const result = await pendingLogin.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: pendingLogin.phone,
          phoneCodeHash: pendingLogin.phoneCodeHash,
          phoneCode: code,
        })
      );

      // Success! Save session
      await finishLogin(pendingLogin.client);
      res.json({ success: true, message: 'Logged in successfully!' });
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        // 2FA enabled
        res.json({ success: false, needs2FA: true, message: 'Two-factor authentication required' });
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error('[Telegram] VerifyCode error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/telegram/verify-2fa
 * Step 3 (optional): Enter 2FA password
 * Body: { password: "your2fapassword" }
 */
router.post('/verify-2fa', adminAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    if (!pendingLogin.client) return res.status(400).json({ error: 'No pending login' });

    // Compute the SRP check for 2FA
    const srpPassword = await pendingLogin.client.invoke(new Api.account.GetPassword());
    const inputCheckPassword = await computeCheck(srpPassword, password);
    const result = await pendingLogin.client.invoke(
      new Api.auth.CheckPassword({
        password: inputCheckPassword,
      })
    );

    // Success!
    await finishLogin(pendingLogin.client);
    res.json({ success: true, message: 'Logged in with 2FA!' });
  } catch (e) {
    console.error('[Telegram] 2FA error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** Save session and switch to the logged-in client */
async function finishLogin(loginClient) {
  const sessionStr = loginClient.session.save();

  // Save session to database
  try {
    db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('telegram_session', ?)").run(sessionStr);
  } catch (e) {
    console.error('[Telegram] Failed to save session:', e.message);
  }

  // Replace the global client
  if (client && client !== loginClient) {
    try { await client.disconnect(); } catch (_) {}
  }
  client = loginClient;
  connected = true;

  // Resolve channel
  try {
    channelEntity = await client.getEntity(CHANNEL_USERNAME);
    console.log(`[Telegram] Logged in! Channel: ${channelEntity.title || CHANNEL_USERNAME}`);
  } catch (e) {
    console.log(`[Telegram] Logged in but channel not found: ${e.message}`);
  }

  pendingLogin = { client: null, phoneCodeHash: null, phone: null };
}

/**
 * POST /api/telegram/logout
 * Clear the saved session
 */
router.post('/logout', adminAuth, async (req, res) => {
  try {
    if (client) {
      try { await client.disconnect(); } catch (_) {}
    }
    client = null;
    connected = false;
    channelEntity = null;

    try {
      db.prepare("DELETE FROM admin_settings WHERE key = 'telegram_session'").run();
    } catch (_) {}

    res.json({ success: true, message: 'Logged out' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ═══════════════  DATA ENDPOINTS  ═══════════════

/**
 * GET /api/telegram/status
 * Check Telegram connection status
 */
router.get('/status', (req, res) => {
  res.json({
    connected,
    channel: CHANNEL_USERNAME,
    channelTitle: channelEntity?.title || null,
    needsLogin: !connected,
  });
});

/**
 * GET /api/telegram/videos
 * List all video files in the channel (paginated)
 */
router.get('/videos', adminAuth, async (req, res) => {
  try {
    const cl = await getClient();
    if (!cl || !connected) {
      return res.status(400).json({ error: 'Not logged in. Complete phone login first.', needsLogin: true });
    }
    if (!channelEntity) {
      return res.status(500).json({ error: 'Channel not resolved' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offsetId = parseInt(req.query.offset_id) || 0;

    const messages = await cl.getMessages(channelEntity, {
      limit,
      offsetId,
    });

    const videos = [];
    for (const msg of messages) {
      if (!msg.media) continue;

      let fileInfo = null;
      let fileName = '';
      let fileSize = 0;
      let mimeType = '';
      let duration = 0;
      let width = 0;
      let height = 0;

      if (msg.media.className === 'MessageMediaDocument') {
        const doc = msg.media.document;
        if (!doc) continue;
        fileSize = doc.size ? Number(doc.size) : 0;
        mimeType = doc.mimeType || '';

        for (const attr of (doc.attributes || [])) {
          if (attr.className === 'DocumentAttributeFilename') {
            fileName = attr.fileName || '';
          }
          if (attr.className === 'DocumentAttributeVideo') {
            duration = attr.duration || 0;
            width = attr.w || 0;
            height = attr.h || 0;
          }
        }

        fileInfo = {
          messageId: msg.id,
          date: msg.date,
          caption: msg.message || '',
          fileName,
          fileSize,
          mimeType,
          duration,
          width,
          height,
          resolution: height > 0 ? `${height}p` : '',
          ...detectVideo(fileName, mimeType),
        };
      }

      if (fileInfo) {
        // Check if already linked to an episode/movie
        try {
          const linked = db.prepare(
            "SELECT id, title, content_type, season_number, episode_number FROM videos WHERE filename LIKE ?"
          ).get(`%/api/telegram/stream/${fileInfo.messageId}%`);
          fileInfo.linked = linked || null;
        } catch (_) {
          fileInfo.linked = null;
        }
        videos.push(fileInfo);
      }
    }

    res.json({
      success: true,
      count: videos.length,
      videos,
      hasMore: messages.length === limit,
    });
  } catch (e) {
    console.error('[Telegram] List error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/telegram/stream/:messageId
 * Stream a video file from Telegram with HTTP Range support.
 * This is the endpoint ExoPlayer hits directly.
 */
router.get('/stream/:messageId', async (req, res) => {
  const metrics = req.app.get('metrics');
  if (metrics) metrics.activeStreams++;
  res.on('close', () => { if (metrics) metrics.activeStreams = Math.max(0, metrics.activeStreams - 1); });
  try {
    const cl = await getClient();
    if (!cl || !connected) {
      return res.status(503).json({ error: 'Telegram not connected' });
    }
    if (!channelEntity) {
      return res.status(500).json({ error: 'Channel not connected' });
    }

    const messageId = parseInt(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'Invalid message ID' });

    // Get the message
    const messages = await cl.getMessages(channelEntity, { ids: [messageId] });
    if (!messages || messages.length === 0 || !messages[0]) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const msg = messages[0];
    if (!msg.media || msg.media.className !== 'MessageMediaDocument') {
      return res.status(400).json({ error: 'Not a video message' });
    }

    const doc = msg.media.document;
    const fileSize = Number(doc.size || 0);

    // Get filename
    let fileName = 'video.mp4';
    for (const attr of (doc.attributes || [])) {
      if (attr.className === 'DocumentAttributeFilename') {
        fileName = attr.fileName || fileName;
      }
    }

    // Detect actual video type (handles .mkv.zip.001 etc.)
    const { streamMime } = detectVideo(fileName, doc.mimeType || '');
    const mimeType = streamMime || 'video/mp4';

    const CHUNK = 1024 * 1024; // 1MB - fewer round-trips, must be divisible by 4096

    // ═══ TRANSCODE PATH: E-AC3/DDP audio → AAC via FFmpeg ═══
    // ExoPlayer can't decode E-AC3 without FFmpeg extension,
    // so we transcode audio server-side. Video is copied (not re-encoded).
    if (ffmpegPath && needsAudioTranscode(fileName)) {
      const seekTime = parseFloat(req.query.t) || 0;
      const cacheKey = `tg_${messageId}`;
      const cached = transcodedCache.get(cacheKey);

      // ── CACHED SEEK: instant seeking via temp file ──
      if (seekTime > 0 && cached && cached.ready && fs.existsSync(cached.path)) {
        cached.lastAccess = Date.now();
        console.log(`[Telegram] Cached seek msgId=${messageId} t=${seekTime}s from ${cached.path}`);

        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Transcoded': 'eac3-to-aac',
          'X-Cached': 'true',
        });

        const ff = spawn(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error',
          '-probesize', '32768', '-analyzeduration', '500000',
          '-ss', String(seekTime),
          '-i', cached.path,
          '-c', 'copy',
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          '-frag_duration', '500000',
          'pipe:1'
        ]);
        ff.stderr.on('data', d => console.error('[FFmpeg-cache]', d.toString().trim()));
        ff.stdout.pipe(res);
        ff.on('close', () => { if (!res.writableEnded) res.end(); });
        res.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
        return;
      }

      // ── TRANSCODE from Telegram (with temp file caching for future seeks) ──
      console.log(`[Telegram] Transcoding msgId=${messageId} (E-AC3 → AAC) file=${fileName}${seekTime > 0 ? ` seek=${seekTime}s` : ''}`);

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'none',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Transcoded': 'eac3-to-aac',
      });

      // Build FFmpeg args (with optional -ss for seeking)
      // -probesize and -analyzeduration reduce startup delay for faster first bytes
      const ffArgs = ['-hide_banner', '-loglevel', 'error',
        '-probesize', '32768', '-analyzeduration', '500000'];
      if (seekTime > 0) {
        ffArgs.push('-ss', String(seekTime));
      }
      ffArgs.push(
        '-i', 'pipe:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', '500000',
        'pipe:1'
      );

      const ff = spawn(ffmpegPath, ffArgs);

      // Save to temp file on initial play (no seek) for future cached seeks
      const tmpPath = path.join(os.tmpdir(), `tg_transcode_${messageId}.mp4`);
      let tmpStream = null;
      if (seekTime === 0) {
        tmpStream = fs.createWriteStream(tmpPath);
        transcodedCache.set(cacheKey, { path: tmpPath, ready: false, lastAccess: Date.now() });
      }

      ff.stderr.on('data', d => console.error('[FFmpeg]', d.toString().trim()));
      ff.on('error', e => {
        console.error('[FFmpeg] Process error:', e.message);
        if (tmpStream && tmpStream.writable) tmpStream.end();
        if (!res.writableEnded) res.end();
      });

      // Stream FFmpeg output → HTTP response + temp file
      ff.stdout.on('data', (data) => {
        if (!res.writableEnded) res.write(data);
        if (tmpStream && tmpStream.writable) tmpStream.write(data);
      });

      ff.stdout.on('end', () => {
        if (!res.writableEnded) res.end();
      });

      ff.on('close', () => {
        if (tmpStream && tmpStream.writable) {
          tmpStream.end(() => {
            const entry = transcodedCache.get(cacheKey);
            if (entry) {
              entry.ready = true;
              console.log(`[Telegram] Cache ready: ${tmpPath}`);
            }
          });
        }
      });

      // Clean up FFmpeg on client disconnect
      res.on('close', () => {
        try { ff.kill('SIGKILL'); } catch (_) {}
        if (tmpStream && tmpStream.writable) tmpStream.end();
      });

      // Feed Telegram download → FFmpeg stdin
      try {
        const iter = cl.iterDownload({
          file: new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: '',
          }),
          dcId: doc.dcId,
          offset: bigInt(0),
          requestSize: CHUNK,
        });

        for await (const chunk of iter) {
          if (res.destroyed) break;
          if (!ff.stdin.writable) break;
          const ok = ff.stdin.write(Buffer.from(chunk));
          if (!ok) {
            await new Promise(resolve => ff.stdin.once('drain', resolve));
          }
        }
      } catch (feedErr) {
        console.error('[FFmpeg] Feed error:', feedErr.message);
      }

      if (ff.stdin.writable) ff.stdin.end();
      console.log(`[Telegram] Transcode complete for msgId=${messageId}`);
      return;
    }

    // ═══ RAW STREAM PATH: direct MKV/MP4 bytes with Range support ═══
    const range = req.headers.range;
    let start = 0;
    let end = fileSize - 1;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10);
      end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
        return res.end();
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${fileName}"`,
        'Cache-Control': 'public, max-age=3600',
        'Connection': 'keep-alive',
      });
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${fileName}"`,
        'Cache-Control': 'public, max-age=3600',
        'Connection': 'keep-alive',
      });
    }

    // Stream the file using gramjs iterDownload
    // Must build InputDocumentFileLocation manually AND pass dcId
    const downloadSize = end - start + 1;
    const alignedOffset = Math.floor(start / CHUNK) * CHUNK;
    const skipBytes = start - alignedOffset;

    console.log(`[Telegram] Streaming msgId=${messageId} range=${start}-${end} size=${downloadSize} dcId=${doc.dcId}`);

    try {
      const iter = cl.iterDownload({
        file: new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: '',
        }),
        dcId: doc.dcId,            // critical: file lives on this DC
        offset: bigInt(alignedOffset),
        requestSize: CHUNK,
      });

      let downloaded = 0;
      let needSkip = skipBytes;

      for await (const chunk of iter) {
        if (res.destroyed || res.writableEnded) break;

        let toWrite = Buffer.from(chunk);

        // Trim the start of the first chunk to align with the requested byte offset
        if (needSkip > 0) {
          toWrite = toWrite.slice(needSkip);
          needSkip = 0;
        }

        const remaining = downloadSize - downloaded;
        if (remaining <= 0) break;

        // Trim the last chunk if needed
        if (toWrite.length > remaining) {
          toWrite = toWrite.slice(0, remaining);
        }

        if (toWrite.length === 0) continue;

        const ok = res.write(toWrite);
        downloaded += toWrite.length;

        if (downloaded >= downloadSize) break;

        // Handle backpressure
        if (!ok) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }

      console.log(`[Telegram] Streamed ${downloaded} bytes for msgId=${messageId}`);
    } catch (streamErr) {
      console.error('[Telegram] Stream error:', streamErr.message, streamErr.stack);
    }

    res.end();
  } catch (e) {
    console.error('[Telegram] Stream endpoint error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});


// ═══════════════  SUBTITLE EXTRACTION  ═══════════════

// Cache directory for extracted subtitle files (tiny VTT files, persist across requests)
const subtitleCacheDir = path.join(__dirname, '..', 'uploads', 'subtitles');
if (!fs.existsSync(subtitleCacheDir)) {
  fs.mkdirSync(subtitleCacheDir, { recursive: true });
}

// Track in-progress extraction jobs to avoid duplicate work
const subtitleJobs = new Map(); // messageId → true (extracting)

/**
 * Probe a media file for subtitle tracks using ffmpeg -i (reads only header).
 * Returns array of { index, language, codec } objects.
 */
function probeSubtitleTracks(inputFile) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, ['-i', inputFile, '-hide_banner']);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', () => {
      const tracks = [];
      for (const line of stderr.split('\n')) {
        const m = line.match(/Stream #0:(\d+)(?:\((\w{2,3})\))?: Subtitle: (\w+)/);
        if (m) {
          tracks.push({
            index: parseInt(m[1]),
            language: m[2] || 'und',
            codec: m[3],
          });
        }
      }
      resolve(tracks);
    });
    ff.on('error', () => resolve([]));
  });
}

/**
 * Extract a specific subtitle stream from a media file as WebVTT.
 * @param {string} inputFile - Path to the media file
 * @param {number} streamIndex - FFmpeg stream index (e.g. 2 for Stream #0:2)
 * @returns {Promise<string|null>} WebVTT content or null
 */
function extractSubtitleTrack(inputFile, streamIndex) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputFile,
      '-map', `0:${streamIndex}`,
      '-f', 'webvtt',
      'pipe:1',
    ]);
    const chunks = [];
    ff.stdout.on('data', c => chunks.push(c));
    ff.stderr.on('data', d => console.error('[FFmpeg-sub]', d.toString().trim()));
    ff.on('close', () => {
      const data = Buffer.concat(chunks).toString('utf-8');
      resolve(data.includes('WEBVTT') ? data : null);
    });
    ff.on('error', () => resolve(null));
  });
}

/**
 * Download a Telegram video to temp, extract embedded subtitles, cache as WebVTT.
 * Prefers English subtitle track, falls back to first available.
 * @param {number} messageId - Telegram message ID
 * @returns {Promise<{vttPath: string, language: string}|null>}
 */
async function extractAndCacheSubtitles(messageId) {
  const cl = await getClient();
  if (!cl || !connected || !channelEntity) return null;

  const messages = await cl.getMessages(channelEntity, { ids: [messageId] });
  if (!messages || !messages[0] || !messages[0].media) return null;

  const doc = messages[0].media.document;
  const tmpFile = path.join(os.tmpdir(), `tg_sub_${messageId}.mkv`);
  const CHUNK = 1024 * 1024;

  try {
    // Download to temp file (subtitles are interleaved in MKV, need full file)
    console.log(`[Subtitles] Downloading msgId=${messageId} for subtitle extraction...`);
    const ws = fs.createWriteStream(tmpFile);
    const iter = cl.iterDownload({
      file: new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: '',
      }),
      dcId: doc.dcId,
      offset: bigInt(0),
      requestSize: CHUNK,
    });
    for await (const chunk of iter) {
      ws.write(Buffer.from(chunk));
    }
    ws.end();
    await new Promise(r => ws.on('finish', r));

    console.log(`[Subtitles] Download complete. Probing subtitle tracks...`);

    // Probe for subtitle tracks
    const tracks = await probeSubtitleTracks(tmpFile);
    console.log(`[Subtitles] Found ${tracks.length} subtitle tracks:`, JSON.stringify(tracks));

    if (tracks.length === 0) {
      // Mark as "no subtitles" to avoid re-probing
      fs.writeFileSync(path.join(subtitleCacheDir, `${messageId}.nosubs`), '');
      return null;
    }

    // Prefer English, then first available
    let best = tracks.find(t => ['eng', 'en'].includes(t.language));
    if (!best) best = tracks[0];

    console.log(`[Subtitles] Extracting track: stream=${best.index} lang=${best.language} codec=${best.codec}`);

    // Extract as WebVTT
    const vtt = await extractSubtitleTrack(tmpFile, best.index);
    if (!vtt) {
      fs.writeFileSync(path.join(subtitleCacheDir, `${messageId}.nosubs`), '');
      return null;
    }

    // Save to cache
    const vttPath = path.join(subtitleCacheDir, `${messageId}.vtt`);
    fs.writeFileSync(vttPath, vtt);
    console.log(`[Subtitles] Cached ${vtt.length} bytes of WebVTT for msgId=${messageId} (${best.language})`);
    return { vttPath, language: best.language };
  } finally {
    // Always clean up temp video file
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Shift all WebVTT timestamps by a given number of seconds.
 * Used for DDP-transcoded Telegram streams where seeking restarts from position 0.
 * @param {string} vttContent - Original WebVTT content
 * @param {number} shiftSec - Seconds to shift (negative = earlier)
 * @returns {string} Modified WebVTT content
 */
function shiftVttTimestamps(vttContent, shiftSec) {
  if (shiftSec === 0) return vttContent;

  const shiftMs = shiftSec * 1000;
  const lines = vttContent.split('\n');
  const result = [];
  let headerDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pass through header lines (WEBVTT, NOTE, STYLE, etc.)
    if (!headerDone) {
      result.push(line);
      if (line.includes('-->')) headerDone = true;
      else continue;
    }

    // Check for timestamp line: 00:01:23.456 --> 00:01:25.789
    const tsMatch = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})(.*)/);
    if (tsMatch) {
      const startMs = parseVttTimeMs(tsMatch[1]) - shiftMs;
      const endMs = parseVttTimeMs(tsMatch[2]) - shiftMs;

      // Skip cues that end before position 0 (already past after shifting)
      if (endMs <= 0) {
        // Skip this cue's text lines too
        i++;
        while (i < lines.length && lines[i].trim() !== '') i++;
        continue;
      }

      result.push(`${formatVttTimeMs(Math.max(0, startMs))} --> ${formatVttTimeMs(endMs)}${tsMatch[3]}`);
    } else {
      result.push(line);
    }
  }

  // Re-insert header if it was consumed
  if (result.length > 0 && !result[0].startsWith('WEBVTT')) {
    result.unshift('WEBVTT\n');
  }

  return result.join('\n');
}

function parseVttTimeMs(timeStr) {
  const [h, m, rest] = timeStr.split(':');
  const [s, ms] = rest.split('.');
  return (parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s)) * 1000 + parseInt(ms);
}

function formatVttTimeMs(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msPart = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msPart).padStart(3, '0')}`;
}

/**
 * GET /api/telegram/subtitles/:messageId
 *
 * Serve embedded subtitles from a Telegram video as WebVTT.
 * Automatically extracts English subtitles (or first available) from MKV/MP4 files.
 *
 * Query params:
 *   ?offset=SECONDS  — shift all timestamps (for DDP seek synchronization)
 *
 * Responses:
 *   200 + text/vtt   — subtitle file ready
 *   202 + JSON       — extraction in progress (poll again in 15s)
 *   404              — no subtitles found in the video
 *   503              — FFmpeg not available
 */
router.get('/subtitles/:messageId', async (req, res) => {
  if (!ffmpegPath) {
    return res.status(503).json({ error: 'FFmpeg not available' });
  }

  const messageId = parseInt(req.params.messageId);
  if (!messageId) return res.status(400).json({ error: 'Invalid message ID' });

  const offsetSec = parseFloat(req.query.offset) || 0;

  // CORS header for ExoPlayer
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Check VTT cache
  const cacheFile = path.join(subtitleCacheDir, `${messageId}.vtt`);
  if (fs.existsSync(cacheFile)) {
    let vtt = fs.readFileSync(cacheFile, 'utf-8');
    if (offsetSec > 0) vtt = shiftVttTimestamps(vtt, offsetSec);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    return res.send(vtt);
  }

  // No-subs marker (already probed, no subtitles found)
  if (fs.existsSync(path.join(subtitleCacheDir, `${messageId}.nosubs`))) {
    return res.status(404).json({ error: 'No subtitles available in this video' });
  }

  // If extraction is already in progress, tell client to poll
  if (subtitleJobs.has(messageId)) {
    return res.status(202).json({ status: 'extracting' });
  }

  // Start background extraction
  subtitleJobs.set(messageId, true);
  console.log(`[Subtitles] Starting extraction job for msgId=${messageId}`);

  extractAndCacheSubtitles(messageId)
    .then(result => {
      subtitleJobs.delete(messageId);
      if (result) {
        console.log(`[Subtitles] Extraction complete for msgId=${messageId}`);
      } else {
        console.log(`[Subtitles] No subtitles found for msgId=${messageId}`);
      }
    })
    .catch(err => {
      subtitleJobs.delete(messageId);
      console.error(`[Subtitles] Extraction failed for msgId=${messageId}:`, err.message);
    });

  return res.status(202).json({ status: 'extracting' });
});


/**
 * POST /api/telegram/scan
 * Scan the channel and auto-match videos to existing TMDB entries.
 * Query: ?limit=200&force=true (force re-matches even already-linked entries)
 */
router.post('/scan', adminAuth, async (req, res) => {
  try {
    const cl = await getClient();
    if (!cl || !connected) {
      return res.status(400).json({ error: 'Not logged in', needsLogin: true });
    }
    if (!channelEntity) {
      return res.status(500).json({ error: 'Channel not connected' });
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = `${proto}://${req.get('host')}`;
    const forceRescan = req.query.force === 'true';
    let scanned = 0;
    let matched = 0;
    let unmatched = 0;
    const results = [];
    const limit = parseInt(req.query.limit) || 200;

    // Get all messages from channel
    const messages = await cl.getMessages(channelEntity, { limit });

    for (const msg of messages) {
      if (!msg.media || msg.media.className !== 'MessageMediaDocument') continue;
      const doc = msg.media.document;
      if (!doc) continue;

      scanned++;

      // Get filename and caption
      let fileName = '';
      let duration = 0;
      let height = 0;
      for (const attr of (doc.attributes || [])) {
        if (attr.className === 'DocumentAttributeFilename') fileName = attr.fileName || '';
        if (attr.className === 'DocumentAttributeVideo') {
          duration = attr.duration || 0;
          height = attr.h || 0;
        }
      }
      const caption = msg.message || '';
      const text = (fileName + ' ' + caption).trim();

      // Skip non-video files
      const { isVideo } = detectVideo(fileName, doc.mimeType || '');
      if (!isVideo) { scanned--; continue; }

      // Check if already linked
      if (!forceRescan) {
        try {
          const existing = db.prepare(
            "SELECT id FROM videos WHERE filename LIKE ?"
          ).get(`%/api/telegram/stream/${msg.id}%`);
          if (existing) {
            results.push({ messageId: msg.id, fileName, status: 'already_linked' });
            continue;
          }
        } catch (_) {}
      } else {
        // Force mode: clear old link so it can be re-matched correctly
        try {
          db.prepare(
            "UPDATE videos SET filename = '' WHERE filename LIKE ?"
          ).run(`%/api/telegram/stream/${msg.id}%`);
        } catch (_) {}
      }

      // ─── PARSE EPISODE INFO ───
      const epMatch = text.match(/[Ss](\d{1,2})\s*[._\s-]*[Ee](\d{1,3})/);
      const seasonMatch = text.match(/[Ss]eason\s*(\d{1,2})/i);
      const episodeMatch = text.match(/[Ee]pisode\s*(\d{1,3})/i);
      const standaloneEpMatch = !epMatch && !episodeMatch ? fileName.match(/^E[Pp]?(\d{1,3})[.\s_-]/i) : null;

      let seasonNum = epMatch ? parseInt(epMatch[1]) : (seasonMatch ? parseInt(seasonMatch[1]) : 0);
      let episodeNum = epMatch ? parseInt(epMatch[2]) : (episodeMatch ? parseInt(episodeMatch[1]) : (standaloneEpMatch ? parseInt(standaloneEpMatch[1]) : 0));
      if (standaloneEpMatch && seasonNum === 0) seasonNum = 1;

      // ─── EXTRACT YEAR ───
      const yearMatch = text.match(/(19|20)\d{2}/);
      const fileYear = yearMatch ? yearMatch[0] : '';

      // ─── EXTRACT NAME (use cleanMovieName for robust parsing) ───
      let showName = '';
      if (epMatch) {
        showName = text.substring(0, text.indexOf(epMatch[0])).replace(/[._-]+/g, ' ').trim();
        showName = showName.replace(/\s*(19|20)\d{2}\s*$/, '').trim();
        // Clean up group tags etc.
        showName = showName.replace(/^@[\w]+[_|]+/i, '').trim();
      } else if (standaloneEpMatch) {
        showName = fileName.substring(standaloneEpMatch[0].length);
        showName = cleanMovieName(showName);
      } else {
        showName = cleanMovieName(fileName);
      }

      // If showName is empty or too short, try caption
      if (showName.length < 2 && caption) {
        showName = cleanMovieName(caption);
      }

      const streamUrl = `${baseUrl}/api/telegram/stream/${msg.id}`;

      // ═══ PATH 1: TV EPISODE MATCHING ═══
      if (seasonNum > 0 && episodeNum > 0 && showName) {
        let seriesFound = null;
        console.log(`[Telegram] Resolving TV: "${showName}" (year=${fileYear}) S${seasonNum}E${episodeNum}...`);

        const importResult = await tmdbAutoImport(showName, fileYear);
        if (importResult) {
          try {
            seriesFound = db.prepare(
              "SELECT id, title FROM videos WHERE tmdb_id = ? AND content_type = 'series' LIMIT 1"
            ).get(importResult.tmdbId);
          } catch (_) {}
        }

        // Fallback: name match
        if (!seriesFound) {
          try {
            if (fileYear) {
              seriesFound = db.prepare(
                "SELECT id, title FROM videos WHERE content_type = 'series' AND LOWER(title) LIKE ? AND description LIKE ? LIMIT 1"
              ).get(`%${showName.toLowerCase().substring(0, 20)}%`, `%${fileYear}%`);
            }
            if (!seriesFound) {
              seriesFound = db.prepare(
                "SELECT id, title FROM videos WHERE content_type = 'series' AND LOWER(title) LIKE ? LIMIT 1"
              ).get(`%${showName.toLowerCase().substring(0, 20)}%`);
            }
          } catch (_) {}
        }

        if (seriesFound) {
          try {
            const episode = db.prepare(
              "SELECT id, title FROM videos WHERE content_type = 'episode' AND series_id = ? AND season_number = ? AND episode_number = ?"
            ).get(seriesFound.id, seasonNum, episodeNum);

            if (episode) {
              db.prepare("UPDATE videos SET filename = ?, file_size = ?, mime_type = ?, duration = ?, resolution = ? WHERE id = ?")
                .run(streamUrl, Number(doc.size || 0), doc.mimeType || 'video/mp4', duration, height > 0 ? `${height}p` : '', episode.id);
              matched++;
              results.push({ messageId: msg.id, fileName, status: 'matched', episode: episode.title, series: seriesFound.title });
              continue;
            }
          } catch (_) {}
        }
        // Episode pattern detected but couldn't match — fall through to try as movie
      }

      // ═══ PATH 2: MOVIE MATCHING (no episode pattern, or episode match failed) ═══
      if (showName && showName.length >= 2) {
        console.log(`[Telegram] Resolving as movie: "${showName}" (year=${fileYear})...`);

        // First try: search TMDB as movie
        let movieResult = await tmdbAutoImportMovie(showName, fileYear);

        // If movie search failed AND there was no episode pattern, also try as TV show
        if (!movieResult && seasonNum === 0 && episodeNum === 0) {
          const tvResult = await tmdbAutoImport(showName, fileYear);
          if (tvResult) {
            // It's a TV show file without episode info — link entire stream to the series entry
            try {
              const series = db.prepare(
                "SELECT id, title FROM videos WHERE tmdb_id = ? AND content_type = 'series' LIMIT 1"
              ).get(tvResult.tmdbId);
              if (series) {
                // For TV shows without episode info, don't link to series itself
                // Just report as matched (series imported, user can manually link episodes)
                matched++;
                results.push({ messageId: msg.id, fileName, status: 'matched_series', series: series.title, note: 'Series imported, no episode info in filename' });
                continue;
              }
            } catch (_) {}
          }
        }

        if (movieResult) {
          // Link the stream to the movie entry
          try {
            const movieDbId = movieResult.movieDbId;
            db.prepare("UPDATE videos SET filename = ?, file_size = ?, mime_type = ?, duration = ?, resolution = ? WHERE id = ?")
              .run(streamUrl, Number(doc.size || 0), doc.mimeType || 'video/mp4', duration, height > 0 ? `${height}p` : '', movieDbId);
            const movieEntry = db.prepare("SELECT title FROM videos WHERE id = ?").get(movieDbId);
            matched++;
            results.push({ messageId: msg.id, fileName, status: 'matched', movie: movieEntry ? movieEntry.title : showName });
            continue;
          } catch (linkErr) {
            console.error(`[Telegram] Movie link error:`, linkErr.message);
          }
        }
      }

      unmatched++;
      results.push({ messageId: msg.id, fileName, status: 'unmatched', parsed: { showName, seasonNum, episodeNum, fileYear } });
    }

    res.json({ success: true, scanned, matched, unmatched, results });
  } catch (e) {
    console.error('[Telegram] Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/telegram/link
 * Manually link a Telegram message to a video/episode entry.
 * Body: { messageId: number, videoId: string }
 */
router.post('/link', adminAuth, async (req, res) => {
  try {
    const { messageId, videoId } = req.body;
    if (!messageId || !videoId) {
      return res.status(400).json({ error: 'messageId and videoId required' });
    }

    const cl = await getClient();
    if (!cl || !connected) {
      return res.status(400).json({ error: 'Not logged in', needsLogin: true });
    }
    if (!channelEntity) {
      return res.status(500).json({ error: 'Channel not connected' });
    }

    // Get message to verify it exists and get file info
    const messages = await cl.getMessages(channelEntity, { ids: [parseInt(messageId)] });
    if (!messages || messages.length === 0 || !messages[0]) {
      return res.status(404).json({ error: 'Message not found in channel' });
    }

    const msg = messages[0];
    if (!msg.media || msg.media.className !== 'MessageMediaDocument') {
      return res.status(400).json({ error: 'Not a video message' });
    }

    const doc = msg.media.document;
    let duration = 0;
    let height = 0;
    for (const attr of (doc.attributes || [])) {
      if (attr.className === 'DocumentAttributeVideo') {
        duration = attr.duration || 0;
        height = attr.h || 0;
      }
    }

    // Update the video entry
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = `${proto}://${req.get('host')}`;
    const streamUrl = `${baseUrl}/api/telegram/stream/${messageId}`;

    db.prepare(`UPDATE videos SET filename = ?, file_size = ?, mime_type = ?, duration = ?, resolution = ? WHERE id = ?`)
      .run(streamUrl, Number(doc.size || 0), doc.mimeType || 'video/mp4', duration, height > 0 ? `${height}p` : '', videoId);

    const updated = db.prepare("SELECT id, title, content_type, season_number, episode_number FROM videos WHERE id = ?").get(videoId);

    res.json({
      success: true,
      message: 'Video linked to Telegram file',
      video: updated,
      streamUrl,
    });
  } catch (e) {
    console.error('[Telegram] Link error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/telegram/unlink
 * Body: { videoId: string }
 */
router.post('/unlink', adminAuth, async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ error: 'videoId required' });
    db.prepare("UPDATE videos SET filename = '', file_size = 0 WHERE id = ?").run(videoId);
    res.json({ success: true, message: 'Unlinked' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/telegram/search
 * Search videos in channel by filename/caption
 */
router.get('/search', adminAuth, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q parameter required' });

    const cl = await getClient();
    if (!cl || !connected) {
      return res.status(400).json({ error: 'Not logged in', needsLogin: true });
    }
    if (!channelEntity) {
      return res.status(500).json({ error: 'Channel not connected' });
    }

    const messages = await cl.getMessages(channelEntity, { search: q, limit: 20 });
    const videos = [];
    for (const msg of messages) {
      if (!msg.media || msg.media.className !== 'MessageMediaDocument') continue;
      const doc = msg.media.document;
      if (!doc) continue;

      let fileName = '';
      let duration = 0;
      let height = 0;
      for (const attr of (doc.attributes || [])) {
        if (attr.className === 'DocumentAttributeFilename') fileName = attr.fileName || '';
        if (attr.className === 'DocumentAttributeVideo') {
          duration = attr.duration || 0;
          height = attr.h || 0;
        }
      }

      // Skip non-video files in search results
      const { isVideo } = detectVideo(fileName, doc.mimeType || '');
      if (!isVideo) continue;

      videos.push({
        messageId: msg.id,
        date: msg.date,
        caption: msg.message || '',
        fileName,
        fileSize: Number(doc.size || 0),
        mimeType: doc.mimeType || '',
        duration,
        height,
        resolution: height > 0 ? `${height}p` : '',
      });
    }

    res.json({ success: true, count: videos.length, videos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════  DIAGNOSTIC: FFmpeg check  ═══════════════
router.get('/ffmpeg-check', (req, res) => {
  const result = { ffmpegPath, available: !!ffmpegPath };
  if (ffmpegPath) {
    try {
      const out = execSync(`"${ffmpegPath}" -version`, { timeout: 5000 }).toString().split('\n')[0];
      result.version = out;
    } catch (e) {
      result.error = e.message;
    }
  }
  res.json(result);
});

module.exports = router;
