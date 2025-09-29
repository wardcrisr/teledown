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
app.use(express.static(path.join(__dirname, '..', 'downloads')));

// Import routes
const authRoutes = require('./routes/authV2');
const channelRoutes = require('./routes/channelsV2');
const downloadRoutes = require('./routes/downloadV2');

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Telegram Video Downloader API' });
});

app.use('/api/auth', authRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/download', downloadRoutes);

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
app.use(express.static(frontendDist));
// SPA fallback: only for non-API and non-socket paths (Express 5 safe)
app.get(/^(?!\/api|\/socket\.io).*/, (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
