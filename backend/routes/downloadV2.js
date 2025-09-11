const express = require('express');
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const router = express.Router();
const telegramService = require('../services/telegram');

// Store active downloads
let activeDownloads = new Map();

// Middleware to check authentication
const requireAuth = (req, res, next) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// Find related videos for batch download
router.post('/find-related', requireAuth, async (req, res) => {
  try {
    const { channelId, videoId } = req.body;
    const sessionId = req.headers['x-session-id'];
    
    if (!channelId || !videoId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Get messages from Telegram to find related videos
    const relatedVideos = await telegramService.findRelatedVideos(
      sessionId,
      channelId,
      videoId
    );
    
    res.json(relatedVideos);
    
  } catch (error) {
    console.error('Find related videos error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch download multiple videos
router.post('/batch', requireAuth, async (req, res) => {
  try {
    const { channelId, folderName, videos } = req.body;
    const sessionId = req.headers['x-session-id'];
    
    if (!channelId || !videos || videos.length === 0) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Sanitize folder name for filesystem
    const sanitizedFolderName = folderName
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // Remove invalid characters
      .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
      .trim()
      .substring(0, 100);  // Limit length
    
    // Create folder for this batch
    const downloadsDir = process.env.DOWNLOAD_PATH || path.join(process.cwd(), 'downloads');
    const batchFolder = path.join(downloadsDir, sanitizedFolderName);
    await fsExtra.ensureDir(batchFolder);
    
    const downloadIds = [];
    const downloadQueue = [];
    
    // Prepare all downloads
    for (const video of videos) {
      const downloadId = `${channelId}_${video.id}_${Date.now()}_${Math.random()}`;
      
      // Use filename if available, otherwise use title
      // This ensures consistency with single download
      let fileName;
      if (video.filename) {
        // If we have a filename from Telegram, use it directly
        fileName = video.filename;
        // Ensure it has .mp4 extension
        if (!fileName.endsWith('.mp4')) {
          fileName = fileName.replace(/\.[^/.]+$/, '') + '.mp4';
        }
      } else {
        // Fallback to title-based naming (same as single download)
        const cleanTitle = (video.title || `video_${video.id}`).replace(/[^a-zA-Z0-9\-_\s]/g, '_');
        fileName = `${cleanTitle}.mp4`;
      }
      
      const filePath = path.join(batchFolder, fileName);
      
      // Initialize download tracking
      const downloadInfo = {
        id: downloadId,
        videoId: video.id,
        channelId,
        title: video.title || video.filename || `Video ${video.id}`,
        fileName,
        filePath,
        folderName: sanitizedFolderName,
        progress: 0,
        status: 'queued',
        startTime: Date.now(),
        sessionId
      };
      
      activeDownloads.set(downloadId, downloadInfo);
      downloadIds.push(downloadId);
      
      // Add to queue instead of starting immediately
      downloadQueue.push({
        downloadId,
        batchFolder
      });
    }
    
    // Process download queue with proper concurrency limit
    const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS) || 2;
    console.log(`Starting batch download with max concurrent: ${maxConcurrent}`);
    
    // Process queue in batches sequentially
    processDownloadQueue(downloadQueue, maxConcurrent);
    
    res.json({ 
      downloadIds,
      folderName: sanitizedFolderName,
      message: `Started downloading ${videos.length} videos to ${sanitizedFolderName} (max ${maxConcurrent} concurrent)`
    });
    
  } catch (error) {
    console.error('Batch download start error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Process download queue with concurrency limit
async function processDownloadQueue(queue, maxConcurrent) {
  console.log(`Processing download queue with ${queue.length} items`);
  
  for (let i = 0; i < queue.length; i += maxConcurrent) {
    const batch = queue.slice(i, i + maxConcurrent);
    
    console.log(`Processing batch ${Math.floor(i/maxConcurrent) + 1}: ${batch.length} downloads`);
    
    // Update status for items in this batch
    batch.forEach(item => {
      const download = activeDownloads.get(item.downloadId);
      if (download) {
        download.status = 'starting';
      }
    });
    
    // Start all downloads in this batch
    const batchPromises = batch.map(item => 
      startRealDownloadToFolder(item.downloadId, item.batchFolder)
        .catch(err => {
          console.error(`Download failed for ${item.downloadId}:`, err);
          const download = activeDownloads.get(item.downloadId);
          if (download) {
            download.status = 'failed';
            download.error = err.message;
          }
        })
    );
    
    // Wait for this batch to complete before starting the next
    try {
      await Promise.all(batchPromises);
      console.log(`Batch ${Math.floor(i/maxConcurrent) + 1} completed`);
    } catch (error) {
      console.error(`Error in batch ${Math.floor(i/maxConcurrent) + 1}:`, error);
    }
  }
  
  console.log('All download batches processed');
}

// Start video download using real Telegram API
router.post('/start', requireAuth, async (req, res) => {
  try {
    const { videoId, channelId, title } = req.body;
    const sessionId = req.headers['x-session-id'];
    
    if (!videoId || !channelId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const downloadId = `${channelId}_${videoId}_${Date.now()}`;
    const cleanTitle = (title || `video_${videoId}`).replace(/[^a-zA-Z0-9\-_\s]/g, '_');
    const fileName = `${cleanTitle}.mp4`;
    
    // Use environment variable for download path
    const downloadsDir = process.env.DOWNLOAD_PATH || path.join(process.cwd(), 'downloads');
    await fsExtra.ensureDir(downloadsDir);
    const filePath = path.join(downloadsDir, fileName);
    
    // Check if already downloading
    if (activeDownloads.has(downloadId)) {
      return res.status(409).json({ error: 'Download already in progress' });
    }
    
    // Initialize download tracking
    const downloadInfo = {
      id: downloadId,
      videoId,
      channelId,
      title: title || `Video ${videoId}`,
      fileName,
      filePath,
      progress: 0,
      status: 'starting',
      startTime: Date.now(),
      sessionId
    };
    
    activeDownloads.set(downloadId, downloadInfo);
    
    // Start the real download process
    startRealDownload(downloadId);
    
    res.json({ 
      downloadId,
      message: 'Download started',
      fileName
    });
    
  } catch (error) {
    console.error('Download start error:', error);
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

// Get all downloads for a session
router.get('/list', requireAuth, (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const downloads = Array.from(activeDownloads.values())
    .filter(d => d.sessionId === sessionId);
  
  res.json({ downloads });
});

// Cancel download
router.post('/cancel/:downloadId', requireAuth, async (req, res) => {
  const { downloadId } = req.params;
  const download = activeDownloads.get(downloadId);
  
  if (!download) {
    return res.status(404).json({ error: 'Download not found' });
  }
  
  download.status = 'cancelled';
  
  // Clean up partial file if exists
  try {
    if (await fsExtra.pathExists(download.filePath)) {
      await fsExtra.remove(download.filePath);
    }
  } catch (error) {
    console.error('Error cleaning up file:', error);
  }
  
  activeDownloads.delete(downloadId);
  
  // Notify clients
  if (global.io) {
    global.io.emit('download-cancelled', {
      id: downloadId,
      ...download
    });
  }
  
  res.json({ message: 'Download cancelled' });
});

// Real download process using Telegram API
async function startRealDownload(downloadId) {
  const download = activeDownloads.get(downloadId);
  if (!download) return;
  
  try {
    download.status = 'downloading';
    download.progress = 0;
    
    console.log(`Starting download: ${downloadId}`);
    
    // Emit initial status
    if (global.io) {
      global.io.emit('download-progress', {
        id: downloadId,
        progress: 0,
        status: 'downloading'
      });
    }
    
    // Use the real Telegram API to download
    const result = await telegramService.downloadMedia(
      download.sessionId,
      download.channelId,
      download.videoId,
      (progress, received, total) => {
        // Check if download was cancelled
        if (download.status === 'cancelled') {
          return false; // Signal to abort download
        }
        
        // Update progress
        download.progress = Math.round(progress);
        download.received = received;
        download.total = total;
        
        // Only log every 10% to reduce noise
        if (Math.round(progress) % 10 === 0) {
          console.log(`Download progress ${downloadId}: ${Math.round(progress)}%`);
        }
        
        // Emit progress to connected clients
        if (global.io && download.status !== 'cancelled') {
          global.io.emit('download-progress', {
            id: downloadId,
            progress: Math.round(progress),
            status: 'downloading',
            received,
            total
          });
        }
        
        return true; // Continue download
      }
    );
    
    // Check if download was cancelled during the process
    if (download.status === 'cancelled') {
      return;
    }
    
    // Download completed successfully
    download.progress = 100;
    download.status = 'completed';
    download.completedTime = Date.now();
    download.actualFileName = result.fileName;
    download.actualFilePath = result.filePath;
    download.fileSize = result.size;
    
    console.log(`Download completed: ${result.fileName}`);
    
    // Emit completion to connected clients
    if (global.io) {
      global.io.emit('download-complete', {
        id: downloadId,
        progress: 100,
        status: 'completed',
        completedTime: download.completedTime
      });
    }
    
  } catch (error) {
    console.error(`Download failed for ${downloadId}:`, error);
    
    if (activeDownloads.has(downloadId)) {
      download.status = 'failed';
      download.error = error.message;
      download.completedTime = Date.now();
      
      // Emit error to connected clients
      if (global.io) {
        global.io.emit('download-error', {
          id: downloadId,
          status: 'failed',
          error: error.message
        });
      }
    }
  }
}

// Real download process with custom folder support
async function startRealDownloadToFolder(downloadId, targetFolder) {
  const download = activeDownloads.get(downloadId);
  if (!download) return;
  
  try {
    download.status = 'downloading';
    download.progress = 0;
    
    console.log(`Starting batch download: ${downloadId} to folder: ${targetFolder}`);
    
    // Emit initial status
    if (global.io) {
      global.io.emit('download-progress', {
        id: downloadId,
        progress: 0,
        status: 'downloading',
        folderName: download.folderName
      });
    }
    
    // Use the real Telegram API to download directly to the specified folder
    const result = await telegramService.downloadMediaToPath(
      download.sessionId,
      download.channelId,
      download.videoId,
      download.filePath, // Use the pre-calculated path in the target folder
      (progress, received, total) => {
        // Check if download was cancelled
        if (download.status === 'cancelled') {
          return false; // Signal to abort download
        }
        
        // Update progress
        download.progress = Math.round(progress);
        download.received = received;
        download.total = total;
        
        // Only log every 10% to reduce noise
        if (Math.round(progress) % 10 === 0) {
          console.log(`Download progress ${downloadId}: ${Math.round(progress)}%`);
        }
        
        // Emit progress to connected clients
        if (global.io && download.status !== 'cancelled') {
          global.io.emit('download-progress', {
            id: downloadId,
            progress: Math.round(progress),
            status: 'downloading',
            received,
            total,
            folderName: download.folderName
          });
        }
        
        return true; // Continue download
      }
    );
    
    // Check if download was cancelled during the process
    if (download.status === 'cancelled') {
      return;
    }
    
    // Download completed successfully
    download.progress = 100;
    download.status = 'completed';
    download.completedTime = Date.now();
    download.actualFileName = result.fileName;
    download.actualFilePath = result.filePath;
    download.fileSize = result.size;
    
    console.log(`Batch download completed: ${result.fileName} in ${download.folderName}`);
    
    // Emit completion to connected clients
    if (global.io) {
      global.io.emit('download-complete', {
        id: downloadId,
        progress: 100,
        status: 'completed',
        completedTime: download.completedTime,
        folderName: download.folderName
      });
    }
    
  } catch (error) {
    console.error('Batch download error:', error);
    
    download.status = 'failed';
    download.error = error.message;
    
    // Emit error to connected clients
    if (global.io) {
      global.io.emit('download-error', {
        id: downloadId,
        status: 'failed',
        error: error.message,
        folderName: download.folderName
      });
    }
  }
}

module.exports = router;