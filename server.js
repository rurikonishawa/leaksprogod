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

  // Socket.IO with CORS
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
    maxHttpBufferSize: 100 * 1024 * 1024, // 100MB for chunk uploads
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
