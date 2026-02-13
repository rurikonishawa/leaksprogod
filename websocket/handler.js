const Video = require('../models/Video');

function setupWebSocket(io) {
  // Track connected clients
  let connectedClients = 0;

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
    // (Admin panel sends the full file; we upload it to Cloudinary and report progress)
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
    });
  });
}

module.exports = setupWebSocket;
