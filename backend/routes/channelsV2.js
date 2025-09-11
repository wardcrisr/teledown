const express = require('express');
const router = express.Router();
const telegramService = require('../services/telegram');

// Middleware to check authentication
const requireAuth = (req, res, next) => {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // TODO: Verify session is valid and authenticated
  req.sessionId = sessionId;
  next();
};

// Get user's subscribed channels
router.get('/', requireAuth, async (req, res) => {
  try {
    const channels = await telegramService.getChannels(req.sessionId);
    
    res.json({ 
      channels,
      total: channels.length
    });
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({ 
      error: 'Failed to fetch channels',
      details: error.message
    });
  }
});

// Get videos/messages from a specific channel
router.get('/:channelId/videos', requireAuth, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { limit = 20, offsetId = 0, minId = 0 } = req.query;  // Added minId for newer messages
    
    // If minId is provided, get messages newer than minId
    // Otherwise, get messages older than offsetId (or latest if offsetId = 0)
    const videos = await telegramService.getChannelMessages(
      req.sessionId,
      channelId,
      parseInt(limit),
      parseInt(offsetId),
      parseInt(minId) > 0 ? parseInt(minId) : null  // Pass minId if provided
    );
    
    res.json({ 
      videos,
      channelId,
      count: videos.length,
      hasMore: videos.length === parseInt(limit)
    });
  } catch (error) {
    console.error('Error fetching channel videos:', error);
    res.status(500).json({ 
      error: 'Failed to fetch channel videos',
      details: error.message
    });
  }
});

// Search for messages in a channel
router.get('/:channelId/search', requireAuth, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { query, limit = 50 } = req.query;
    
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    const results = await telegramService.searchChannelMessages(
      req.sessionId,
      channelId,
      query,
      parseInt(limit)
    );
    
    res.json({ 
      results,
      query,
      count: results.length
    });
  } catch (error) {
    console.error('Error searching channel:', error);
    res.status(500).json({ 
      error: 'Failed to search channel',
      details: error.message
    });
  }
});

// Get messages around a specific message ID
router.get('/:channelId/messages-around/:messageId', requireAuth, async (req, res) => {
  try {
    const { channelId, messageId } = req.params;
    const { limit = 20 } = req.query;
    
    const messages = await telegramService.getMessagesAround(
      req.sessionId,
      channelId,
      parseInt(messageId),
      parseInt(limit)
    );
    
    res.json({ 
      videos: messages,
      targetId: messageId,
      count: messages.length
    });
  } catch (error) {
    console.error('Error fetching messages around ID:', error);
    res.status(500).json({ 
      error: 'Failed to fetch messages around ID',
      details: error.message
    });
  }
});

// Get photo from a message - returns actual image
router.get('/:channelId/photo/:messageId', async (req, res) => {
  try {
    const { channelId, messageId } = req.params;
    // Get session from query param or header
    const sessionId = req.query.session || req.headers['x-session-id'];
    
    if (!sessionId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const photo = await telegramService.getMessagePhoto(
      sessionId,
      channelId,
      messageId
    );
    
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    
    // Return photo as image directly
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.send(photo);
  } catch (error) {
    console.error('Error fetching photo:', error);
    res.status(500).json({ 
      error: 'Failed to fetch photo',
      details: error.message
    });
  }
});

// Get channel info and statistics
router.get('/:channelId/info', requireAuth, async (req, res) => {
  try {
    const { channelId } = req.params;
    
    // Get channel details
    const channels = await telegramService.getChannels(req.sessionId);
    const channel = channels.find(c => c.id === channelId);
    
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    res.json({ channel });
  } catch (error) {
    console.error('Error fetching channel info:', error);
    res.status(500).json({ 
      error: 'Failed to fetch channel info',
      details: error.message
    });
  }
});

module.exports = router;