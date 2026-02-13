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

// Root route — so Railway health checks pass and visitors see something
app.get('/', (req, res) => {
  res.json({
    app: 'LeaksPro Backend',
    status: 'running',
    admin: '/admin',
    api: '/api/health',
    docs: 'https://github.com/vernapark/Leakspro-backend',
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
// (kept for backward compat; the Android app can also hit Cloudinary directly)
app.get('/api/stream/:videoId', (req, res) => {
  try {
    const Video = require('./models/Video');
    const video = Video.getById(req.params.videoId);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    // filename now holds the Cloudinary secure_url
    res.redirect(video.filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Setup WebSocket
setupWebSocket(io);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║       LeaksPro Backend Server            ║
  ║──────────────────────────────────────────║
  ║  API:    http://localhost:${PORT}/api      ║
  ║  Admin:  http://localhost:${PORT}/admin    ║
  ║  Stream: http://localhost:${PORT}/api/stream ║
  ║──────────────────────────────────────────║
  ║  WebSocket: Connected on port ${PORT}      ║
  ╚══════════════════════════════════════════╝
  `);
});

} // end startServer()

// Global error handlers so Railway sees the crash reason in logs
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

// Actually start the server!
startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
