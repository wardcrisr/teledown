// Simple mock Telegram service for testing
class TelegramService {
  constructor() {
    this.sessions = new Map();
  }

  // Initialize client (mock)
  async initializeClient(sessionId, stringSession = '') {
    this.sessions.set(sessionId, {
      authenticated: false,
      stringSession
    });
    return { connected: true };
  }

  // Send authentication code (mock)
  async sendCode(sessionId, phoneNumber) {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) {
      throw new Error('Session not found');
    }

    // Mock: Just return success for any phone number
    sessionData.phoneCodeHash = 'mock_hash_' + Date.now();
    sessionData.phone = phoneNumber;

    console.log(`Mock: Code would be sent to ${phoneNumber}`);
    
    return {
      phoneCodeHash: sessionData.phoneCodeHash,
      message: 'Mock code sent successfully (use any 5-digit code like 12345)'
    };
  }

  // Sign in with code (mock)
  async signIn(sessionId, phoneNumber, code, password = '') {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) {
      throw new Error('Session not found');
    }

    // Mock: Accept any 5-digit code
    if (code && code.length === 5) {
      sessionData.authenticated = true;
      sessionData.user = {
        firstName: 'Test',
        lastName: 'User',
        username: 'testuser',
        phone: phoneNumber
      };
      sessionData.stringSession = 'mock_session_' + Date.now();

      return {
        success: true,
        user: sessionData.user,
        sessionString: sessionData.stringSession
      };
    } else {
      throw new Error('Invalid code format');
    }
  }

  // Get user's channels (mock)
  async getChannels(sessionId) {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.authenticated) {
      throw new Error('User not authenticated');
    }

    // Mock channels data
    const mockChannels = [
      {
        id: '1001234567',
        title: 'Tech News Channel',
        username: 'technews',
        participantsCount: 150000,
        type: 'channel'
      },
      {
        id: '1001234568',
        title: 'Programming Tips',
        username: 'progTips',
        participantsCount: 89000,
        type: 'channel'
      },
      {
        id: '1001234569',
        title: 'Design Inspiration',
        username: 'designInspiration',
        participantsCount: 45000,
        type: 'channel'
      }
    ];

    return mockChannels;
  }

  // Get messages from channel (mock)
  async getChannelMessages(sessionId, channelId, limit = 20, offsetId = 0) {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.authenticated) {
      throw new Error('User not authenticated');
    }

    // Mock video messages
    const mockVideos = [
      {
        id: 101,
        text: 'Latest AI breakthrough video',
        date: new Date('2024-01-15'),
        media: {
          duration: 330, // 5:30
          size: 26214400, // 25MB
          mimeType: 'video/mp4',
          fileName: 'ai_breakthrough.mp4'
        }
      },
      {
        id: 102,
        text: 'Tech review: New smartphone',
        date: new Date('2024-01-14'),
        media: {
          duration: 525, // 8:45
          size: 47185920, // 45MB
          mimeType: 'video/mp4',
          fileName: 'smartphone_review.mp4'
        }
      },
      {
        id: 103,
        text: 'JavaScript tips and tricks',
        date: new Date('2024-01-16'),
        media: {
          duration: 735, // 12:15
          size: 71303168, // 68MB
          mimeType: 'video/mp4',
          fileName: 'js_tips.mp4'
        }
      }
    ];

    return mockVideos;
  }

  // Download media (mock)
  async downloadMedia(sessionId, channelId, messageId, progressCallback) {
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData || !sessionData.authenticated) {
      throw new Error('User not authenticated');
    }

    const fileName = `video_${messageId}.mp4`;
    const filePath = require('path').join(process.cwd(), 'downloads', fileName);
    
    // Mock download with progress simulation
    return new Promise((resolve, reject) => {
      let progress = 0;
      const interval = setInterval(() => {
        progress += Math.random() * 15;
        if (progressCallback) {
          progressCallback(Math.min(progress, 100), progress * 1000, 100000);
        }
        
        if (progress >= 100) {
          clearInterval(interval);
          
          // Create a dummy file
          const fs = require('fs');
          const dummyContent = `Mock video file for message ${messageId}`;
          fs.writeFileSync(filePath, dummyContent);
          
          resolve({
            fileName,
            filePath,
            size: dummyContent.length
          });
        }
      }, 500);
    });
  }

  // Clean up session
  cleanupSession(sessionId) {
    this.sessions.delete(sessionId);
  }
}

module.exports = new TelegramService();