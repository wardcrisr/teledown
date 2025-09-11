const fs = require('fs-extra');
const path = require('path');

class SessionStore {
  constructor() {
    this.storePath = path.join(process.cwd(), 'sessions');
    this.sessionsFile = path.join(this.storePath, 'sessions.json');
    this.sessions = new Map();
    this.initialized = false;
    this.initPromise = this.init();
  }

  async init() {
    try {
      // Ensure sessions directory exists
      await fs.ensureDir(this.storePath);
      
      // Load existing sessions if file exists
      if (await fs.pathExists(this.sessionsFile)) {
        const data = await fs.readJson(this.sessionsFile);
        this.sessions = new Map(Object.entries(data));
        console.log(`Loaded ${this.sessions.size} sessions from storage`);
        
        // Only clean up very old sessions (older than 30 days)
        let cleanedCount = 0;
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        
        for (const [sessionId, session] of this.sessions.entries()) {
          // Only remove if session is very old AND not authenticated
          if (session.lastUpdated < thirtyDaysAgo && !session.authenticated) {
            this.sessions.delete(sessionId);
            cleanedCount++;
          }
        }
        
        if (cleanedCount > 0) {
          console.log(`Cleaned ${cleanedCount} old sessions`);
          await this.save();
        }
      } else {
        this.sessions = new Map();
        await this.save();
      }
      
      this.initialized = true;
    } catch (error) {
      console.error('Error initializing session store:', error);
      this.sessions = new Map();
      this.initialized = true;
    }
  }
  
  async ensureInitialized() {
    if (!this.initialized) {
      await this.initPromise;
    }
  }

  async save() {
    try {
      const data = Object.fromEntries(this.sessions);
      await fs.writeJson(this.sessionsFile, data, { spaces: 2 });
    } catch (error) {
      console.error('Error saving sessions:', error);
    }
  }

  async set(sessionId, sessionData) {
    await this.ensureInitialized();
    this.sessions.set(sessionId, {
      ...sessionData,
      lastUpdated: Date.now()
    });
    await this.save();
  }

  async get(sessionId) {
    await this.ensureInitialized();
    return this.sessions.get(sessionId);
  }

  async delete(sessionId) {
    await this.ensureInitialized();
    this.sessions.delete(sessionId);
    await this.save();
  }

  async getAll() {
    await this.ensureInitialized();
    return this.sessions;
  }

  // Clean up expired sessions (older than 30 days)
  async cleanup() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let changed = false;
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.lastUpdated < thirtyDaysAgo) {
        this.sessions.delete(sessionId);
        changed = true;
      }
    }
    
    if (changed) {
      await this.save();
    }
  }

  // Get active authenticated sessions
  async getAuthenticatedSessions() {
    await this.ensureInitialized();
    const authenticated = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.authenticated) {
        authenticated.push({ sessionId, ...session });
      }
    }
    return authenticated;
  }
}

module.exports = new SessionStore();