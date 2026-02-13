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

    // Handle chunk upload via WebSocket (for ultra-fast uploads)
    socket.on('upload_chunk_ws', (data) => {
      const { uploadId, chunkIndex, totalChunks, chunkData, filename } = data;
      const fs = require('fs');
      const path = require('path');

      const chunkDir = path.join(__dirname, '..', 'uploads', 'chunks', uploadId);
      if (!fs.existsSync(chunkDir)) {
        fs.mkdirSync(chunkDir, { recursive: true });
      }

      // Write chunk
      const chunkPath = path.join(chunkDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
      const buffer = Buffer.from(chunkData);
      fs.writeFileSync(chunkPath, buffer);

      const progress = ((chunkIndex + 1) / totalChunks) * 100;

      // Emit progress back to uploader
      socket.emit('chunk_received', {
        uploadId,
        chunkIndex,
        progress: Math.round(progress),
      });

      // Broadcast upload progress to all admin clients
      io.emit('upload_progress', {
        uploadId,
        chunkIndex,
        totalChunks,
        progress: Math.round(progress),
        filename,
      });

      // If all chunks uploaded, merge
      if (chunkIndex + 1 === totalChunks) {
        const finalFilename = `${uploadId}_${filename}`;
        const finalPath = path.join(__dirname, '..', 'uploads', 'videos', finalFilename);
        const writeStream = fs.createWriteStream(finalPath);

        let merged = 0;
        const mergeNext = () => {
          if (merged >= totalChunks) {
            writeStream.end(() => {
              fs.rmSync(chunkDir, { recursive: true, force: true });
              const stat = fs.statSync(finalPath);
              socket.emit('upload_merged', {
                uploadId,
                filename: finalFilename,
                size: stat.size,
              });
              io.emit('upload_complete', {
                uploadId,
                filename: finalFilename,
                size: stat.size,
              });
            });
            return;
          }
          const cp = path.join(chunkDir, `chunk_${String(merged).padStart(6, '0')}`);
          const chunkBuf = fs.readFileSync(cp);
          writeStream.write(chunkBuf, () => {
            merged++;
            mergeNext();
          });
        };
        mergeNext();
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
