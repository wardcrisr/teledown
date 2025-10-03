const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const io = socketIo(server, {
  cors: {
    origin: allowedOrigin,
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
const downloadsDir = path.join(__dirname, '..', 'downloads');
app.use(express.static(downloadsDir));
// Also expose downloads under /bot for stable public URLs used by Bot fallback
app.use('/bot', express.static(downloadsDir));

// Import routes
const authRoutes = require('./routes/authV2');
const channelRoutes = require('./routes/channelsV2');
const downloadRoutes = require('./routes/downloadV2');
const botRoutes = require('./routes/bot');

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Telegram Video Downloader API' });
});

app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/bot', botRoutes);

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Make io available globally for other modules
global.io = io;

// Serve frontend (production) from frontend/dist
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
// Serve hashed assets with a long cache; index.html should not be cached
app.use(express.static(frontendDist, { maxAge: '7d', etag: true }));
// SPA fallback: only for non-API and non-socket paths (Express 5 safe)
app.get(/^(?!\/api|\/socket\.io).*/, (req, res) => {
  // Avoid caching HTML so clients always pick up new build assets
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(frontendDist, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
