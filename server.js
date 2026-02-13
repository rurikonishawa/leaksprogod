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

// Ensure upload directories exist
const dirs = [
  path.join(__dirname, 'uploads', 'videos'),
  path.join(__dirname, 'uploads', 'thumbnails'),
  path.join(__dirname, 'uploads', 'chunks'),
  path.join(__dirname, 'data'),
];
dirs.forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/admin', express.static(path.join(__dirname, 'admin-panel')));

// Make io accessible to routes
app.set('io', io);

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

// Stream video with range support (for efficient video playback)
app.get('/api/stream/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', 'videos', req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    const file = fs.createReadStream(filePath, { start, end });
    const headers = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    };

    res.writeHead(206, headers);
    file.pipe(res);
  } else {
    const headers = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
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

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
