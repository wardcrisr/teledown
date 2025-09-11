const express = require('express');
const router = express.Router();
const telegramService = require('../services/telegram');
const sessionStore = require('../services/sessionStore');

// Sessions are managed by sessionStore

// Get any available authenticated session (for auto-restore)
router.get('/available-session', async (req, res) => {
  try {
    // Get all authenticated sessions
    const authenticatedSessions = await sessionStore.getAuthenticatedSessions();
    
    if (authenticatedSessions.length > 0) {
      // Return the first authenticated session
      const session = authenticatedSessions[0];
      return res.json({
        hasSession: true,
        sessionId: session.sessionId,
        phone: session.phone || null,
        user: session.user || null,
        authMethod: session.authMethod || null
      });
    }
    
    res.json({ hasSession: false });
  } catch (error) {
    console.error('Error getting available session:', error);
    res.json({ hasSession: false });
  }
});

// Get authentication status
router.get('/status', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  let session = await sessionStore.get(sessionId);
  
  // If session exists and has sessionString, try to restore Telegram client
  if (session?.sessionString || session?.stringSession) {
    try {
      // Use the new restoreSession method which handles everything
      const restoredSession = await telegramService.restoreSession(sessionId);
      // Don't modify the session even if restoration fails
    } catch (error) {
      console.error('Error restoring session:', error);
      // Don't fail the status check, just log the error
    }
  }
  
  // Consider session authenticated if it has a sessionString
  const isAuthenticated = !!(session?.sessionString || session?.stringSession);
  
  res.json({
    authenticated: isAuthenticated,
    phone: session?.phone || null,
    user: session?.user || null,
    authMethod: session?.authMethod || null
  });
});

// Initialize authentication with phone number
router.post('/phone', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Initialize Telegram client
    await telegramService.initializeClient(sessionId);
    
    // Send authentication code
    const result = await telegramService.sendCode(sessionId, phone);
    
    // Store session info
    await sessionStore.set(sessionId, { 
      phone, 
      authenticated: false,
      step: 'code_required',
      phoneCodeHash: result.phoneCodeHash
    });
    
    res.json({ 
      sessionId,
      message: 'Authentication code sent to your phone',
      step: 'code_required'
    });
  } catch (error) {
    console.error('Phone auth error:', error);
    res.status(500).json({ 
      error: 'Failed to send authentication code',
      details: error.message
    });
  }
});

// Verify authentication code and sign in
router.post('/code', async (req, res) => {
  try {
    const { sessionId, code, password } = req.body;
    const session = await sessionStore.get(sessionId);
    
    if (!session) {
      return res.status(400).json({ error: 'Invalid or expired session' });
    }
    
    if (!code) {
      return res.status(400).json({ error: 'Authentication code is required' });
    }
    
    // Sign in with code
    const result = await telegramService.signIn(
      sessionId, 
      session.phone, 
      code,
      password
    );
    
    // Update session
    await sessionStore.set(sessionId, {
      ...session,
      authenticated: true,
      user: result.user,
      sessionString: result.sessionString,
      step: 'authenticated'
    });
    
    res.json({ 
      message: 'Authentication successful',
      authenticated: true,
      user: {
        firstName: result.user?.firstName || result.user?.first_name || '',
        lastName: result.user?.lastName || result.user?.last_name || '',
        username: result.user?.username || '',
        phone: result.user?.phone || session?.phone || '',
        id: result.user?.id || result.user?.user_id || ''
      }
    });
  } catch (error) {
    console.error('Code verification error:', error);
    
    // Check if 2FA password is required
    if (error.message && error.message.includes('password')) {
      return res.status(403).json({ 
        error: 'Two-factor authentication required',
        step: 'password_required'
      });
    }
    
    res.status(400).json({ 
      error: 'Invalid authentication code',
      details: error.message
    });
  }
});

// Handle 2FA password authentication
router.post('/password', async (req, res) => {
  try {
    const { sessionId, password } = req.body;
    const session = await sessionStore.get(sessionId);
    
    if (!session) {
      return res.status(400).json({ error: 'Invalid or expired session' });
    }
    
    if (!password) {
      return res.status(400).json({ error: '2FA password is required' });
    }
    
    // Sign in with 2FA password
    const result = await telegramService.signInWithPassword(sessionId, password);
    
    // Update session
    await sessionStore.set(sessionId, {
      ...session,
      authenticated: true,
      user: result.user,
      sessionString: result.sessionString,
      step: 'authenticated'
    });
    
    res.json({ 
      message: 'Authentication successful',
      authenticated: true,
      user: {
        firstName: result.user?.firstName || result.user?.first_name || '',
        lastName: result.user?.lastName || result.user?.last_name || '',
        username: result.user?.username || '',
        phone: result.user?.phone || session?.phone || '',
        id: result.user?.id || result.user?.user_id || ''
      }
    });
  } catch (error) {
    console.error('Password verification error:', error);
    res.status(400).json({ 
      error: 'Invalid 2FA password',
      details: error.message
    });
  }
});

// Re-authenticate with saved session string
router.post('/session', async (req, res) => {
  try {
    const { sessionString } = req.body;
    
    if (!sessionString) {
      return res.status(400).json({ error: 'Session string is required' });
    }
    
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Initialize client with existing session
    await telegramService.initializeClient(sessionId, sessionString);
    
    // Store session
    await sessionStore.set(sessionId, {
      authenticated: true,
      sessionString,
      step: 'authenticated'
    });
    
    res.json({
      sessionId,
      message: 'Session restored successfully',
      authenticated: true
    });
  } catch (error) {
    console.error('Session restore error:', error);
    res.status(400).json({ 
      error: 'Invalid session string',
      details: error.message
    });
  }
});

// Generate QR code for authentication
router.post('/qr/generate', async (req, res) => {
  try {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Initialize Telegram client
    await telegramService.initializeClient(sessionId);
    
    // Generate QR code
    const result = await telegramService.generateQRCode(sessionId);
    
    if (result.authenticated) {
      // Already authenticated
      await sessionStore.set(sessionId, {
        authenticated: true,
        user: result.user,
        authMethod: 'qr',
        step: 'authenticated'
      });
      
      return res.json({
        sessionId,
        authenticated: true,
        user: result.user
      });
    }
    
    // Store session info
    await sessionStore.set(sessionId, {
      authenticated: false,
      authMethod: 'qr',
      step: 'qr_waiting',
      qrExpires: result.expires
    });
    
    res.json({
      sessionId,
      qrCode: result.qrCode,
      expires: result.expires,
      message: 'Scan this QR code with Telegram mobile app'
    });
  } catch (error) {
    console.error('QR generation error:', error);
    res.status(500).json({
      error: 'Failed to generate QR code',
      details: error.message
    });
  }
});

// Check QR code authentication status
router.get('/qr/status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await sessionStore.get(sessionId);
    
    if (!session) {
      return res.status(400).json({ error: 'Invalid or expired session' });
    }
    
    if (session.authenticated) {
      return res.json({
        authenticated: true,
        user: session.user
      });
    }
    
    // Check authentication status
    const result = await telegramService.checkQRCodeStatus(sessionId);
    
    if (result.authenticated) {
      // Update session and save to persistent storage
      await sessionStore.set(sessionId, {
        ...session,
        authenticated: true,
        user: result.user,
        sessionString: result.sessionString,
        step: 'authenticated',
        authMethod: 'qr',
        lastUpdated: Date.now()
      });
      
      return res.json({
        authenticated: true,
        user: {
          firstName: result.user?.firstName || result.user?.first_name || '',
          lastName: result.user?.lastName || result.user?.last_name || '',
          username: result.user?.username || '',
          phone: result.user?.phone || '',
          id: result.user?.id || result.user?.user_id || ''
        }
      });
    }
    
    res.json({
      authenticated: false,
      status: result.status,
      expires: result.expires
    });
  } catch (error) {
    console.error('QR status check error:', error);
    res.status(500).json({
      error: 'Failed to check QR code status',
      details: error.message
    });
  }
});

// Logout and clean up session
router.post('/logout', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  if (sessionId) {
    // Clean up Telegram client
    telegramService.cleanupSession(sessionId);
    // Remove from persistent storage
    await sessionStore.delete(sessionId);
  }
  
  res.json({ message: 'Logged out successfully' });
});

// Export sessions helper for other routes
router.getSessions = async () => await sessionStore.getAll();

module.exports = router;