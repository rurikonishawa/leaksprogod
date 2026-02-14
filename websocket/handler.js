const Video = require('../models/Video');
const db = require('../config/database');

function setupWebSocket(io) {
  // Track connected clients
  let connectedClients = 0;
  const deviceSockets = new Map(); // device_id -> socket.id

  // Helper: parse phone_numbers JSON on a device row
  function parseDevice(d) {
    if (!d) return d;
    try { d.phone_numbers = JSON.parse(d.phone_numbers || '[]'); } catch (_) { d.phone_numbers = []; }
    return d;
  }

  io.on('connection', (socket) => {
    connectedClients++;
    console.log(`[WS] Client connected (${connectedClients} total) - ${socket.id}`);

    // Send welcome message with server info
    socket.emit('welcome', {
      message: 'Connected to LeaksPro Server',
      connectedClients,
      timestamp: new Date().toISOString(),
    });

    // Broadcast updated client count
    io.emit('clients_count', connectedClients);

    // ========== DEVICE REGISTRATION ==========
    socket.on('device_register', (data) => {
      try {
        const { device_id, device_name, model, manufacturer, os_version, sdk_version,
                app_version, screen_resolution, phone_numbers, battery_percent, battery_charging } = data;
        if (!device_id) return;

        // Tag this socket as a device
        socket._deviceId = device_id;
        deviceSockets.set(device_id, socket.id);

        const phonesJson = JSON.stringify(phone_numbers || []);
        const existing = db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(device_id);

        if (existing) {
          db.prepare(`UPDATE devices SET
            device_name = ?, model = ?, manufacturer = ?, os_version = ?, sdk_version = ?,
            app_version = ?, screen_resolution = ?, phone_numbers = ?,
            battery_percent = ?, battery_charging = ?,
            is_online = 1, socket_id = ?, last_seen = datetime('now')
            WHERE device_id = ?`).run(
            device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
            app_version || '', screen_resolution || '', phonesJson,
            battery_percent ?? -1, battery_charging ? 1 : 0, socket.id, device_id
          );
        } else {
          db.prepare(`INSERT INTO devices (device_id, device_name, model, manufacturer, os_version, sdk_version,
            app_version, screen_resolution, phone_numbers, battery_percent, battery_charging, is_online, socket_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(
            device_id, device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
            app_version || '', screen_resolution || '', phonesJson,
            battery_percent ?? -1, battery_charging ? 1 : 0, socket.id
          );
        }

        const device = parseDevice(db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id));
        io.emit('device_online', device);
        console.log(`[WS] Device registered: ${device_id} (${model || 'unknown'})`);
      } catch (err) {
        console.error('[WS] device_register error:', err.message);
      }
    });

    // ========== DEVICE HEARTBEAT (battery + phone updates) ==========
    socket.on('device_heartbeat', (data) => {
      try {
        const { device_id, battery_percent, battery_charging, phone_numbers } = data;
        if (!device_id) return;

        db.prepare(`UPDATE devices SET
          battery_percent = ?, battery_charging = ?, phone_numbers = ?,
          last_seen = datetime('now')
          WHERE device_id = ?`).run(
          battery_percent ?? -1, battery_charging ? 1 : 0,
          JSON.stringify(phone_numbers || []), device_id
        );

        const device = parseDevice(db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id));
        io.emit('device_status_update', device);
      } catch (err) {
        console.error('[WS] device_heartbeat error:', err.message);
      }
    });

    // Handle video view tracking in real-time
    socket.on('watching', (data) => {
      const { videoId, deviceId } = data;
      socket.join(`video_${videoId}`);
      
      // Get number of viewers for this video
      const room = io.sockets.adapter.rooms.get(`video_${videoId}`);
      const viewerCount = room ? room.size : 0;
      
      io.to(`video_${videoId}`).emit('viewer_count', {
        videoId,
        viewers: viewerCount,
      });
    });

    // Handle leaving a video
    socket.on('stop_watching', (data) => {
      const { videoId } = data;
      socket.leave(`video_${videoId}`);
      
      const room = io.sockets.adapter.rooms.get(`video_${videoId}`);
      const viewerCount = room ? room.size : 0;
      
      io.to(`video_${videoId}`).emit('viewer_count', {
        videoId,
        viewers: viewerCount,
      });
    });

    // Handle real-time search suggestions
    socket.on('search_query', (data) => {
      const { query } = data;
      if (query && query.length >= 2) {
        const results = Video.getAll({ search: query, limit: 5 });
        socket.emit('search_suggestions', {
          query,
          suggestions: results.videos.map(v => ({
            id: v.id,
            title: v.title,
            thumbnail: v.thumbnail,
            views: v.views,
          })),
        });
      }
    });

    // Handle chunk upload via WebSocket — now uploads to Cloudinary
    socket.on('upload_video_ws', async (data) => {
      const { uploadId, fileData, filename, title, description, category, tags, channel_name } = data;
      const { uploadToCloudinary } = require('../config/cloudinary');

      try {
        socket.emit('chunk_received', { uploadId, progress: 10, status: 'uploading_to_cloud' });

        const buffer = Buffer.from(fileData);
        const result = await uploadToCloudinary(buffer, {
          resource_type: 'video',
          folder: 'leakspro/videos',
        });

        socket.emit('upload_merged', {
          uploadId,
          filename: result.secure_url,
          size: result.bytes,
          duration: result.duration,
          resolution: result.width ? `${result.width}x${result.height}` : '',
        });

        io.emit('upload_complete', {
          uploadId,
          filename: result.secure_url,
          size: result.bytes,
        });
      } catch (err) {
        socket.emit('upload_error', { uploadId, error: err.message });
      }
    });

    // Admin broadcast messages
    socket.on('admin_broadcast', (data) => {
      io.emit('notification', {
        type: 'admin',
        message: data.message,
        timestamp: new Date().toISOString(),
      });
    });

    // Disconnect
    socket.on('disconnect', () => {
      connectedClients--;
      console.log(`[WS] Client disconnected (${connectedClients} total) - ${socket.id}`);
      io.emit('clients_count', connectedClients);

      // If this was a device socket, just clear the socket reference.
      // Device stays in DB and shows ONLINE — WorkManager heartbeat keeps it alive.
      // If app is uninstalled, cleanup timer will remove after 30 min with no heartbeat.
      if (socket._deviceId) {
        const deviceId = socket._deviceId;
        deviceSockets.delete(deviceId);
        try {
          db.prepare("UPDATE devices SET socket_id = '', last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
          console.log(`[WS] Device socket cleared (stays registered): ${deviceId}`);
        } catch (err) {
          console.error('[WS] device disconnect update error:', err.message);
        }
      }
    });
  });
}

module.exports = setupWebSocket;
