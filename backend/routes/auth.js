const express = require('express');
const router = express.Router();

// Store active sessions (in production, use a proper database)
let sessions = new Map();

// Get authentication status
router.get('/status', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const session = sessions.get(sessionId);
  
  res.json({
    authenticated: !!session,
    phone: session?.phone || null
  });
});

// Initialize phone authentication
router.post('/phone', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    
    // TODO: Implement Telegram phone auth
    // For now, create a mock session
    const sessionId = Date.now().toString();
    sessions.set(sessionId, { 
      phone, 
      authenticated: false,
      step: 'code_required'
    });
    
    res.json({ 
      sessionId,
      message: 'Code sent to your phone',
      step: 'code_required'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify authentication code
router.post('/code', async (req, res) => {
  try {
    const { sessionId, code } = req.body;
    const session = sessions.get(sessionId);
    
    if (!session) {
      return res.status(400).json({ error: 'Invalid session' });
    }
    
    // TODO: Implement actual code verification
    // For now, accept any 5-digit code
    if (code && code.length === 5) {
      session.authenticated = true;
      session.step = 'authenticated';
      
      res.json({ 
        message: 'Authentication successful',
        authenticated: true
      });
    } else {
      res.status(400).json({ error: 'Invalid code' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Logout
router.post('/logout', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  sessions.delete(sessionId);
  
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;