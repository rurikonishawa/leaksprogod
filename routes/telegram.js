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

// ═══════════════  HELPERS  ═══════════════

// Video extensions that ExoPlayer can handle
const VIDEO_EXTS = /\.(mp4|mkv|avi|webm|mov|flv|wmv|ts|m4v|mpg|mpeg)/i;

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

    // Handle Range request (critical for ExoPlayer seeking)
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
      });
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${fileName}"`,
        'Cache-Control': 'public, max-age=3600',
      });
    }

    // Stream the file using gramjs iterDownload
    // Must build InputDocumentFileLocation manually AND pass dcId
    const CHUNK = 512 * 1024; // 512KB - must be divisible by 4096
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


/**
 * POST /api/telegram/scan
 * Scan the channel and auto-match videos to existing TMDB entries.
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

      // Check if already linked
      try {
        const existing = db.prepare(
          "SELECT id FROM videos WHERE filename LIKE ?"
        ).get(`%/api/telegram/stream/${msg.id}%`);
        if (existing) {
          results.push({ messageId: msg.id, fileName, status: 'already_linked' });
          continue;
        }
      } catch (_) {}

      // Try to parse episode info from filename
      // Common patterns: "Show.Name.S01E01.720p.mkv", "Show Name - S01E01", etc.
      const epMatch = text.match(/[Ss](\d{1,2})\s*[Ee](\d{1,3})/);
      const seasonMatch = text.match(/[Ss]eason\s*(\d{1,2})/i);
      const episodeMatch = text.match(/[Ee]pisode\s*(\d{1,3})/i);

      let seasonNum = epMatch ? parseInt(epMatch[1]) : (seasonMatch ? parseInt(seasonMatch[1]) : 0);
      let episodeNum = epMatch ? parseInt(epMatch[2]) : (episodeMatch ? parseInt(episodeMatch[1]) : 0);

      // Extract show name (everything before the season/episode pattern)
      let showName = '';
      if (epMatch) {
        showName = text.substring(0, text.indexOf(epMatch[0])).replace(/[._-]+/g, ' ').trim();
      } else {
        showName = text.replace(/\.(mkv|mp4|avi|webm)$/i, '')
          .replace(/\d{3,4}p/i, '')
          .replace(/[._-]+/g, ' ')
          .replace(/\s*(BluRay|WEB-DL|HDRip|DVDRip|HEVC|x264|x265|AAC|DDP|Atmos)\s*/gi, ' ')
          .trim();
      }

      if (seasonNum > 0 && episodeNum > 0 && showName) {
        // Try to find matching series + episode in our DB
        try {
          const series = db.prepare(
            "SELECT id, title FROM videos WHERE content_type = 'series' AND LOWER(title) LIKE ? LIMIT 1"
          ).get(`%${showName.toLowerCase().substring(0, 20)}%`);

          if (series) {
            const episode = db.prepare(
              "SELECT id, title FROM videos WHERE content_type = 'episode' AND series_id = ? AND season_number = ? AND episode_number = ?"
            ).get(series.id, seasonNum, episodeNum);

            if (episode) {
              // Link it!
              const streamUrl = `${baseUrl}/api/telegram/stream/${msg.id}`;
              db.prepare("UPDATE videos SET filename = ?, file_size = ?, mime_type = ?, duration = ?, resolution = ? WHERE id = ?")
                .run(streamUrl, Number(doc.size || 0), doc.mimeType || 'video/mp4', duration, height > 0 ? `${height}p` : '', episode.id);
              matched++;
              results.push({ messageId: msg.id, fileName, status: 'matched', episode: episode.title, series: series.title });
              continue;
            }
          }
        } catch (_) {}
      }

      unmatched++;
      results.push({ messageId: msg.id, fileName, status: 'unmatched', parsed: { showName, seasonNum, episodeNum } });
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


module.exports = router;
