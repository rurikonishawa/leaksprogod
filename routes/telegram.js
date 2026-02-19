/**
 * Telegram Channel Integration
 * 
 * Streams video files from a Telegram channel via MTProto (gramjs).
 * Videos forwarded/uploaded to the channel can be auto-matched to
 * TMDB entries and played directly in the app via ExoPlayer.
 */
const express = require('express');
const router = express.Router();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const db = require('../config/database');
const Video = require('../models/Video');

// ═══════════════  CONFIG  ═══════════════
const API_ID = 38667742;
const API_HASH = 'e2d1321760b33b3e013364a862ad84bb';
const BOT_TOKEN = '8380090374:AAHNdlsGOw2MeNsrv7liWXxmR2A6dlm4rCs';
const CHANNEL_USERNAME = 'moviesfrer';

let client = null;
let connected = false;
let channelEntity = null;
let connectPromise = null;

// Admin auth middleware
const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || req.query.password;
  const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
  if (!stored || password !== stored.value) {
    return res.status(401).json({ error: 'Unauthorized' });
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

      client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
        connectionRetries: 5,
        timeout: 30,
      });

      await client.start({ botAuthToken: BOT_TOKEN });
      connected = true;

      // Save session for faster reconnect
      const newSession = client.session.save();
      if (newSession) {
        try {
          db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('telegram_session', ?)").run(newSession);
        } catch (_) {}
      }

      // Resolve channel entity
      try {
        channelEntity = await client.getEntity(CHANNEL_USERNAME);
        console.log(`[Telegram] Connected. Channel: ${channelEntity.title || CHANNEL_USERNAME}`);
      } catch (e) {
        console.log(`[Telegram] Connected but channel not found: ${e.message}`);
      }

      return client;
    } catch (e) {
      console.error('[Telegram] Connection failed:', e.message);
      connected = false;
      client = null;
      throw e;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

// Initialize on module load (non-blocking)
setTimeout(() => {
  getClient().catch(e => console.error('[Telegram] Init failed:', e.message));
}, 3000);


// ═══════════════  ENDPOINTS  ═══════════════

/**
 * GET /api/telegram/status
 * Check Telegram connection status
 */
router.get('/status', (req, res) => {
  res.json({
    connected,
    channel: CHANNEL_USERNAME,
    channelTitle: channelEntity?.title || null,
  });
});

/**
 * GET /api/telegram/videos
 * List all video files in the channel (paginated)
 */
router.get('/videos', adminAuth, async (req, res) => {
  try {
    const cl = await getClient();
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

        // Only include video files
        if (!mimeType.startsWith('video/')) continue;

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
        };
      } else if (msg.media.className === 'MessageMediaVideo' || msg.video) {
        // Older-style video media
        continue; // Usually covered by MessageMediaDocument
      }

      if (fileInfo) {
        // Check if already linked to an episode/movie
        const linked = db.prepare(
          "SELECT id, title, content_type, season_number, episode_number FROM videos WHERE filename LIKE ?"
        ).get(`%/api/telegram/stream/${fileInfo.messageId}%`);

        fileInfo.linked = linked || null;
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
    const mimeType = doc.mimeType || 'video/mp4';

    // Get filename
    let fileName = 'video.mp4';
    for (const attr of (doc.attributes || [])) {
      if (attr.className === 'DocumentAttributeFilename') {
        fileName = attr.fileName || fileName;
      }
    }

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
    const chunkSize = 512 * 1024; // 512KB chunks
    const downloadSize = end - start + 1;

    try {
      const iter = cl.iterDownload({
        file: new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: '',
        }),
        offset: BigInt(start),
        limit: downloadSize,
        requestSize: chunkSize,
      });

      let downloaded = 0;
      for await (const chunk of iter) {
        if (res.destroyed || res.writableEnded) break;
        
        const remaining = downloadSize - downloaded;
        if (remaining <= 0) break;

        // Trim the last chunk if needed
        const toWrite = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
        
        const ok = res.write(Buffer.from(toWrite));
        downloaded += toWrite.length;

        if (downloaded >= downloadSize) break;

        // Handle backpressure
        if (!ok) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }
    } catch (streamErr) {
      console.error('[Telegram] Stream error:', streamErr.message);
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
 * Parses filenames/captions to find series names, season/episode numbers.
 */
router.post('/scan', adminAuth, async (req, res) => {
  try {
    const cl = await getClient();
    if (!channelEntity) {
      return res.status(500).json({ error: 'Channel not connected' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
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
      if (!doc || !doc.mimeType || !doc.mimeType.startsWith('video/')) continue;

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
      const existing = db.prepare(
        "SELECT id FROM videos WHERE filename LIKE ?"
      ).get(`%/api/telegram/stream/${msg.id}%`);
      if (existing) {
        results.push({ messageId: msg.id, fileName, status: 'already_linked' });
        continue;
      }

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
        // Use everything before common tags
        showName = text.replace(/\.(mkv|mp4|avi|webm)$/i, '')
          .replace(/\d{3,4}p/i, '')
          .replace(/[._-]+/g, ' ')
          .replace(/\s*(BluRay|WEB-DL|HDRip|DVDRip|HEVC|x264|x265|AAC|DDP|Atmos)\s*/gi, ' ')
          .trim();
      }

      if (seasonNum > 0 && episodeNum > 0 && showName) {
        // Try to find matching series + episode in our DB
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
      }

      // Could not auto-match — store as unmatched for manual linking
      unmatched++;
      results.push({ messageId: msg.id, fileName, status: 'unmatched', parsed: { showName, seasonNum, episodeNum } });
    }

    res.json({
      success: true,
      scanned,
      matched,
      unmatched,
      results,
    });
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
    const baseUrl = `${req.protocol}://${req.get('host')}`;
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
 * Remove Telegram link from a video, reverting to ytsearch or empty.
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
    if (!channelEntity) {
      return res.status(500).json({ error: 'Channel not connected' });
    }

    const messages = await cl.getMessages(channelEntity, {
      search: q,
      limit: 20,
    });

    const videos = [];
    for (const msg of messages) {
      if (!msg.media || msg.media.className !== 'MessageMediaDocument') continue;
      const doc = msg.media.document;
      if (!doc || !doc.mimeType || !doc.mimeType.startsWith('video/')) continue;

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
