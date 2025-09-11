const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Store active downloads
let activeDownloads = new Map();

// Middleware to check authentication
const requireAuth = (req, res, next) => {
  const sessionId = req.headers['x-session-id'];
  // TODO: Implement proper session verification
  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Start video download
router.post('/start', requireAuth, async (req, res) => {
  try {
    const { videoId, channelId, title } = req.body;
    
    if (!videoId || !channelId || !title) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const downloadId = `${channelId}_${videoId}_${Date.now()}`;
    const fileName = `${title.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`;
    const filePath = path.join(process.cwd(), 'downloads', fileName);
    
    // Check if already downloading
    if (activeDownloads.has(downloadId)) {
      return res.status(409).json({ error: 'Download already in progress' });
    }
    
    // Initialize download tracking
    activeDownloads.set(downloadId, {
      id: downloadId,
      videoId,
      channelId,
      title,
      fileName,
      filePath,
      progress: 0,
      status: 'starting',
      startTime: Date.now()
    });
    
    // Start the download process
    startDownload(downloadId);
    
    res.json({ 
      downloadId,
      message: 'Download started',
      fileName
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get download status
router.get('/status/:downloadId', requireAuth, (req, res) => {
  const { downloadId } = req.params;
  const download = activeDownloads.get(downloadId);
  
  if (!download) {
    return res.status(404).json({ error: 'Download not found' });
  }
  
  res.json(download);
});

// Get all downloads
router.get('/list', requireAuth, (req, res) => {
  const downloads = Array.from(activeDownloads.values());
  res.json({ downloads });
});

// Cancel download
router.post('/cancel/:downloadId', requireAuth, (req, res) => {
  const { downloadId } = req.params;
  const download = activeDownloads.get(downloadId);
  
  if (!download) {
    return res.status(404).json({ error: 'Download not found' });
  }
  
  download.status = 'cancelled';
  activeDownloads.delete(downloadId);
  
  // Clean up partial file if exists
  if (fs.existsSync(download.filePath)) {
    fs.unlinkSync(download.filePath);
  }
  
  res.json({ message: 'Download cancelled' });
});

// Simulate download process
function startDownload(downloadId) {
  const download = activeDownloads.get(downloadId);
  if (!download) return;
  
  download.status = 'downloading';
  
  // Simulate download progress
  const interval = setInterval(() => {
    if (!activeDownloads.has(downloadId)) {
      clearInterval(interval);
      return;
    }
    
    const currentDownload = activeDownloads.get(downloadId);
    
    if (currentDownload.status === 'cancelled') {
      clearInterval(interval);
      return;
    }
    
    // Simulate progress increment
    currentDownload.progress += Math.random() * 10;
    
    if (currentDownload.progress >= 100) {
      currentDownload.progress = 100;
      currentDownload.status = 'completed';
      currentDownload.completedTime = Date.now();
      
      // Create a dummy file for demonstration
      fs.writeFileSync(currentDownload.filePath, `Dummy video file for ${currentDownload.title}`);
      
      clearInterval(interval);
      
      // Emit progress to connected clients
      if (global.io) {
        global.io.emit('download-complete', currentDownload);
      }
    } else {
      // Emit progress to connected clients
      if (global.io) {
        global.io.emit('download-progress', currentDownload);
      }
    }
  }, 1000);
}

module.exports = router;