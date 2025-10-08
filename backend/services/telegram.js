const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const QRCode = require('qrcode');
const sessionStore = require('./sessionStore');

// Global promise management for REST API authentication
let globalPromises = new Map();

function generatePromise() {
  let resolve, reject;
  let promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { resolve, reject, promise };
}

class TelegramService {
  constructor() {
    this.apiId = parseInt(process.env.TELEGRAM_API_ID); // Convert to number
    this.apiHash = process.env.TELEGRAM_API_HASH;
    this.sessions = new Map();
    this.initialized = false;
    // Cache: per (sessionId, channelId) -> Map(dayKey -> { id, ts })
    this.dateIdCache = new Map();
    // Delay session restoration to ensure sessionStore is ready
    this.initPromise = this.initialize();
  }

  // Resolve channel entity safely (handles restarts and cache misses)
  async resolveChannelEntity(client, channelId) {
    const idNum = parseInt(channelId);
    const target = idNum > 0 ? -Math.abs(idNum) : idNum;
    try {
      return await client.getEntity(target);
    } catch (e) {
      try {
        await client.getDialogs();
        return await client.getEntity(target);
      } catch (_) {
        throw new Error('CHAT_ID_INVALID');
      }
    }
  }

  async initialize() {
    try {
      // Wait a bit to ensure sessionStore is initialized
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.restoreSessions();
      this.initialized = true;
    } catch (error) {
      console.error('Error initializing TelegramService:', error);
      this.initialized = true; // Mark as initialized even on error to prevent hanging
    }
  }

  async ensureInitialized() {
    if (!this.initialized) {
      await this.initPromise;
    }
  }

  // Restore authenticated sessions from persistent storage
  async restoreSessions() {
    try {
      console.log('Restoring sessions from storage...');
      
      // Ensure sessionStore is initialized before accessing sessions
      await sessionStore.ensureInitialized();
      
      const storedSessions = await sessionStore.getAll();
      let restoredCount = 0;
      
      // Check if storedSessions is a Map or convert it
      const sessionsToRestore = storedSessions instanceof Map 
        ? storedSessions 
        : new Map(Object.entries(storedSessions || {}));
      
      console.log('Sessions to check:', sessionsToRestore.size);
      
      for (const [sessionId, sessionData] of sessionsToRestore.entries()) {
        // Restore any session that has a stringSession (regardless of authenticated flag)
        console.log(`Checking session ${sessionId}: has stringSession=${!!sessionData.stringSession}, has sessionString=${!!sessionData.sessionString}`);
        if (sessionData.stringSession || sessionData.sessionString) {
          try {
            console.log(`Restoring session ${sessionId}...`);
            
            // Initialize client with stored session string
            const sessionString = sessionData.stringSession || sessionData.sessionString;
            const session = new StringSession(sessionString);
            const client = new TelegramClient(session, this.apiId, this.apiHash, {
              connectionRetries: 5,
            });
            
            // Connect to Telegram
            await client.connect();
            
            // Store in memory
            this.sessions.set(sessionId, {
              client,
              session,
              authenticated: true,
              stringSession: sessionString,
              user: sessionData.user
            });
            
            restoredCount++;
            console.log(`Session ${sessionId} restored successfully`);
          } catch (error) {
            console.error(`Failed to restore session ${sessionId}:`, error.message);
            // Don't modify the stored session - it might work on next restart
          }
        }
      }
      
      console.log(`Restored ${restoredCount} authenticated sessions`);
    } catch (error) {
      console.error('Error in restoreSessions:', error);
    }
  }

  // Restore a single session on-demand
  async restoreSession(sessionId) {
    const storedSession = await sessionStore.get(sessionId);
    
    // Check if session has a stringSession (regardless of authenticated flag)
    if (!storedSession || (!storedSession.stringSession && !storedSession.sessionString)) {
      return null;
    }
    
    // Check if already in memory
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    
    try {
      console.log(`Restoring session ${sessionId} on-demand...`);
      
      const sessionString = storedSession.stringSession || storedSession.sessionString;
      const session = new StringSession(sessionString);
      const client = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 5,
      });
      
      await client.connect();
      
      const sessionData = {
        client,
        session,
        authenticated: true,
        stringSession: sessionString,
        user: storedSession.user
      };
      
      this.sessions.set(sessionId, sessionData);
      console.log(`Session ${sessionId} restored on-demand successfully`);
      
      return sessionData;
    } catch (error) {
      console.error(`Failed to restore session ${sessionId} on-demand:`, error.message);
      return null;
    }
  }

  // Initialize Telegram client for a user session
  async initializeClient(sessionId, stringSession = '') {
    try {
      await this.ensureInitialized();
      if (!this.apiId || !this.apiHash) {
        throw new Error('Telegram API credentials not configured');
      }

      const session = new StringSession(stringSession);
      const client = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 5,
      });

      // Connect to Telegram servers
      await client.connect();

      this.sessions.set(sessionId, {
        client,
        session,
        authenticated: false,
        stringSession,
        lastAuthError: null
      });

      return client;
    } catch (error) {
      console.error('Error initializing Telegram client:', error);
      throw error;
    }
  }

  // Generate QR code for authentication
  async generateQRCode(sessionId) {
    try {
      await this.ensureInitialized();
      const sessionData = this.sessions.get(sessionId);
      if (!sessionData) {
        throw new Error('Session not found');
      }

      const { client } = sessionData;
      
      // Export login token for QR code
      const result = await client.invoke(new Api.auth.ExportLoginToken({
        apiId: this.apiId,
        apiHash: this.apiHash,
        exceptIds: []
      }));

      if (result instanceof Api.auth.LoginToken) {
        // Generate QR code from token
        const tokenBase64 = Buffer.from(result.token).toString('base64url');
        const qrData = `tg://login?token=${tokenBase64}`;
        const qrCodeDataUrl = await QRCode.toDataURL(qrData, {
          width: 300,
          margin: 2
        });
        
        sessionData.qrToken = result.token;
        sessionData.qrExpires = result.expires;
        
        // Save token to persistent storage for recovery
        const storedSession = await sessionStore.get(sessionId) || {};
        await sessionStore.set(sessionId, {
          ...storedSession,
          qrToken: Buffer.from(result.token).toString('base64'),
          qrExpires: result.expires,
          lastUpdated: Date.now()
        });
        
        return {
          qrCode: qrCodeDataUrl,
          expires: result.expires,
          token: tokenBase64
        };
      } else if (result instanceof Api.auth.LoginTokenMigrateTo) {
        // Handle DC migration if needed
        await client._switchDC(result.dcId);
        return this.generateQRCode(sessionId);
      } else if (result instanceof Api.auth.LoginTokenSuccess) {
        // Already authenticated
        sessionData.authenticated = true;
        sessionData.user = result.authorization.user;
        return {
          authenticated: true,
          user: result.authorization.user
        };
      }
      
      throw new Error('Unexpected result from exportLoginToken');
    } catch (error) {
      console.error('Error generating QR code:', error);
      throw error;
    }
  }

  // Check QR code authentication status
  async checkQRCodeStatus(sessionId) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      
      // If session not in memory, try to recreate it for QR checking
      if (!sessionData) {
        const storedSession = await sessionStore.get(sessionId);
        if (storedSession && storedSession.authMethod === 'qr' && !storedSession.authenticated) {
          // Recreate the client for QR checking
          await this.initializeClient(sessionId, '');
          sessionData = this.sessions.get(sessionId);
          if (!sessionData) {
            throw new Error('Failed to recreate session');
          }
          // Restore the QR token if it exists
          if (storedSession.qrToken) {
            sessionData.qrToken = Buffer.from(storedSession.qrToken, 'base64');
            sessionData.qrExpires = storedSession.qrExpires;
          }
        } else {
          throw new Error('Session not found');
        }
      }

      const { client } = sessionData;
      
      // Ensure client is connected
      if (!client.connected) {
        await client.connect();
      }
      
      // If we have a stored token, try to import it first
      if (sessionData.qrToken) {
        try {
          const importResult = await client.invoke(new Api.auth.ImportLoginToken({
            token: sessionData.qrToken
          }));
          
          if (importResult instanceof Api.auth.LoginTokenSuccess &&
              importResult.authorization instanceof Api.auth.Authorization) {
            // Authentication successful
            const stringSession = client.session.save();
            sessionData.authenticated = true;
            sessionData.stringSession = stringSession;
            sessionData.user = importResult.authorization.user;
            
            // Save to persistent storage
            await sessionStore.set(sessionId, {
              authenticated: true,
              stringSession: stringSession,
              user: {
                id: importResult.authorization.user.id?.toString(),
                firstName: importResult.authorization.user.firstName,
                lastName: importResult.authorization.user.lastName,
                username: importResult.authorization.user.username,
                phone: importResult.authorization.user.phone
              },
              authMethod: 'qr',
              lastUpdated: Date.now()
            });
            
            return {
              authenticated: true,
              user: importResult.authorization.user,
              sessionString: stringSession
            };
          }
        } catch (importError) {
          // If import fails, continue to check with ExportLoginToken
          console.log('Import token failed, checking with export:', importError.message);
        }
      }
      
      // Check the status of QR code authentication
      const result = await client.invoke(new Api.auth.ExportLoginToken({
        apiId: this.apiId,
        apiHash: this.apiHash,
        exceptIds: []
      }));

      if (result instanceof Api.auth.LoginTokenSuccess && 
          result.authorization instanceof Api.auth.Authorization) {
        // Authentication successful
        const stringSession = client.session.save();
        sessionData.authenticated = true;
        sessionData.stringSession = stringSession;
        sessionData.user = result.authorization.user;
        
        // Save to persistent storage
        await sessionStore.set(sessionId, {
          authenticated: true,
          stringSession: stringSession,
          user: {
            id: result.authorization.user.id?.toString(),
            firstName: result.authorization.user.firstName,
            lastName: result.authorization.user.lastName,
            username: result.authorization.user.username,
            phone: result.authorization.user.phone
          },
          authMethod: 'qr',
          lastUpdated: Date.now()
        });
        
        return {
          authenticated: true,
          user: result.authorization.user,
          sessionString: stringSession
        };
      } else if (result instanceof Api.auth.LoginToken) {
        // Check if token has expired
        const now = Math.floor(Date.now() / 1000);
        if (result.expires < now) {
          // Token expired, generate new one
          return {
            authenticated: false,
            status: 'expired',
            needsRefresh: true
          };
        }
        
        // Still waiting for scan
        return {
          authenticated: false,
          status: 'waiting',
          expires: result.expires
        };
      } else if (result instanceof Api.auth.LoginTokenMigrateTo) {
        // Handle DC migration
        await client._switchDC(result.dcId);
        const migratedResult = await client.invoke(new Api.auth.ImportLoginToken({
          token: result.token
        }));
        
        if (migratedResult instanceof Api.auth.LoginTokenSuccess &&
            migratedResult.authorization instanceof Api.auth.Authorization) {
          const stringSession = client.session.save();
          sessionData.authenticated = true;
          sessionData.stringSession = stringSession;
          sessionData.user = migratedResult.authorization.user;
          
          // Save to persistent storage
          await sessionStore.set(sessionId, {
            authenticated: true,
            stringSession: stringSession,
            user: {
              id: migratedResult.authorization.user.id?.toString(),
              firstName: migratedResult.authorization.user.firstName,
              lastName: migratedResult.authorization.user.lastName,
              username: migratedResult.authorization.user.username,
              phone: migratedResult.authorization.user.phone
            },
            authMethod: 'qr',
            lastUpdated: Date.now()
          });
          
          return {
            authenticated: true,
            user: migratedResult.authorization.user,
            sessionString: stringSession
          };
        }
      }
      
      return {
        authenticated: false,
        status: 'unknown'
      };
    } catch (error) {
      console.error('Error checking QR code status:', error);
      throw error;
    }
  }

  // Send authentication code to phone
  async sendCode(sessionId, phoneNumber) {
    try {
      await this.ensureInitialized();
      const sessionData = this.sessions.get(sessionId);
      if (!sessionData) {
        throw new Error('Session not found');
      }

      const { client } = sessionData;

      // Use the correct GramJS API for sendCode
      const result = await client.sendCode(
        {
          apiId: this.apiId,
          apiHash: this.apiHash
        },
        phoneNumber
      );

      sessionData.phoneCodeHash = result.phoneCodeHash;
      sessionData.phone = phoneNumber;

      // Set up promise-based authentication for REST API
      const phoneCodePromise = generatePromise();
      const passwordPromise = generatePromise();
      
      globalPromises.set(sessionId, {
        phoneCode: phoneCodePromise,
        password: passwordPromise
      });

      // Start the authentication process asynchronously
      this.startAsyncAuth(sessionId, phoneNumber).catch(error => {
        console.error('Async auth error:', error);
      });

      return {
        phoneCodeHash: result.phoneCodeHash,
        isCodeViaApp: result.isCodeViaApp,
        message: 'Code sent successfully'
      };
    } catch (error) {
      console.error('Error sending code:', error);
      throw error;
    }
  }

  // Start asynchronous authentication process
  async startAsyncAuth(sessionId, phoneNumber) {
    const sessionData = this.sessions.get(sessionId);
    const promises = globalPromises.get(sessionId);
    
    if (!sessionData || !promises) {
      throw new Error('Session or promises not found');
    }

    const { client } = sessionData;

    try {
      // Use client.start with promise-based callbacks
      await client.start({
        phoneNumber: async () => phoneNumber,
        phoneCode: async () => {
          const code = await promises.phoneCode.promise;
          // Generate new promise for potential next use
          promises.phoneCode = generatePromise();
          return code;
        },
        password: async () => {
          const password = await promises.password.promise;
          // Generate new promise for potential next use  
          promises.password = generatePromise();
          return password;
        },
        onError: (err) => {
try {            const parsed = this.parseTelegramError(err);            sessionData.lastAuthError = parsed;          } catch (_) {}
          console.error('Auth error:', err);
          throw err;
        },
      });

      // Authentication successful
      sessionData.authenticated = true;
      sessionData.stringSession = client.session.save();
      sessionData.user = await client.getMe();
sessionData.lastAuthError = null;
      
      // Save to persistent storage
      await sessionStore.set(sessionId, {
        authenticated: true,
        stringSession: sessionData.stringSession,
        user: {
          id: sessionData.user.id?.toString(),
          firstName: sessionData.user.firstName,
          lastName: sessionData.user.lastName,
          username: sessionData.user.username,
          phone: sessionData.user.phone
        },
        authMethod: 'phone',
        lastUpdated: Date.now()
      });

    } catch (error) {
try {
        const parsed = this.parseTelegramError(error);
        if (sessionData) sessionData.lastAuthError = parsed;
      } catch (_) {}
      console.error('Start auth error:', error);
      throw error;
    }
  }

  // Sign in with phone code
  async signIn(sessionId, phoneNumber, code, password = '') {
    try {
      const promises = globalPromises.get(sessionId);
      if (!promises) {
        throw new Error('Authentication not initialized');
      }

      // Resolve the phone code promise
      promises.phoneCode.resolve(code);

      // If password is provided, resolve password promise too
      if (password) {
        promises.password.resolve(password);
      }

      // Fast-path: try direct RPC sign in to avoid client.start timeouts
      try {
        const sessionData = this.sessions.get(sessionId);
        const client = sessionData?.client;
        if (!client) throw new Error('Client not initialized');
        if (!sessionData.phoneCodeHash) throw new Error('Code not requested or expired');

        const auth = await client.invoke(new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash: sessionData.phoneCodeHash,
          phoneCode: code,
        }));

        // If no exception, sign-in succeeded
        sessionData.authenticated = true;
        sessionData.stringSession = client.session.save();
        sessionData.user = await client.getMe();
        sessionData.lastAuthError = null;

        await sessionStore.set(sessionId, {
          authenticated: true,
          stringSession: sessionData.stringSession,
          user: {
            id: sessionData.user.id?.toString(),
            firstName: sessionData.user.firstName,
            lastName: sessionData.user.lastName,
            username: sessionData.user.username,
            phone: sessionData.user.phone
          },
          authMethod: 'phone',
          lastUpdated: Date.now()
        });

        return {
          success: true,
          user: sessionData.user,
          sessionString: sessionData.stringSession
        };
      } catch (e) {
        const parsed = this.parseTelegramError(e);
        if (parsed.code == 'SESSION_PASSWORD_NEEDED') {
          const err = new Error('Two-factor authentication password required');
          err.code = 'SESSION_PASSWORD_NEEDED';
          throw err;
        }
        const err = new Error(parsed.message || 'Authentication failed');
        err.code = parsed.code;
        if (parsed.retryAfter) err.retryAfter = parsed.retryAfter;
        throw err;
      }

      // If direct RPC path above did not return (should have thrown), fallback to client.start-based wait
      // Wait a moment for authentication to complete
      let attempts = 0;
      const maxAttempts = 30; // 15 seconds max wait
      
      while (attempts < maxAttempts) {
        const sessionData = this.sessions.get(sessionId);
        if (sessionData && sessionData.authenticated) {
          return {
            success: true,
            user: sessionData.user,
            sessionString: sessionData.stringSession
          };
        }
        
if (sessionData && sessionData.lastAuthError) { const e = new Error(sessionData.lastAuthError.message || 'Authentication failed'); e.code = sessionData.lastAuthError.code; if (sessionData.lastAuthError.retryAfter) e.retryAfter = sessionData.lastAuthError.retryAfter; throw e; }
        await new Promise(resolve => setTimeout(resolve, 500));
        attempts++;
      }

      throw new Error('Authentication timeout');

    } catch (error) {
      console.error('Error signing in:', error);
      // Check if it's a 2FA password required error
      if (error.message && (error.message.includes('SESSION_PASSWORD_NEEDED') || error.message.includes('password'))) {
        throw new Error('Two-factor authentication password required');
      }
      throw error;
    }
  }

  // Sign in with 2FA password
  async signInWithPassword(sessionId, password) {
    try {
      const promises = globalPromises.get(sessionId);
      if (!promises) {
        throw new Error('Authentication not initialized');
      }

      // Resolve the password promise
      promises.password.resolve(password);

      // Wait for authentication to complete
      let attempts = 0;
      const maxAttempts = 30;
      
      while (attempts < maxAttempts) {
        const sessionData = this.sessions.get(sessionId);
        if (sessionData && sessionData.authenticated) {
          return {
            success: true,
            user: sessionData.user,
            sessionString: sessionData.stringSession
          };
        }
        
if (sessionData && sessionData.lastAuthError) { const e = new Error(sessionData.lastAuthError.message || 'Authentication failed'); e.code = sessionData.lastAuthError.code; if (sessionData.lastAuthError.retryAfter) e.retryAfter = sessionData.lastAuthError.retryAfter; throw e; }
        await new Promise(resolve => setTimeout(resolve, 500));
        attempts++;
      }

      throw new Error('Authentication timeout');

    } catch (error) {
      console.error('Error signing in with password:', error);
      throw error;
    }
  }

  // Get user's channels/chats
  async getChannels(sessionId) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      
      // Try to restore session if not in memory
      if (!sessionData) {
        sessionData = await this.restoreSession(sessionId);
      }
      
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      const dialogs = await client.getDialogs();
      
      // Filter for channels and supergroups
      const channels = dialogs
        .filter(dialog => 
          dialog.entity.className === 'Channel' || 
          dialog.entity.className === 'Chat'
        )
        .map(dialog => ({
          id: dialog.entity.id.toString(),
          title: dialog.entity.title,
          username: dialog.entity.username || null,
          participantsCount: dialog.entity.participantsCount || 0,
          type: dialog.entity.className.toLowerCase()
        }));

      return channels;
    } catch (error) {
      console.error('Error getting channels:', error);
      throw error;
    }
  }

  // Get messages from a channel
  async getChannelMessages(sessionId, channelId, limit = 20, offsetId = 0, minId = null) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      
      // Try to restore session if not in memory
      if (!sessionData) {
        sessionData = await this.restoreSession(sessionId);
      }
      
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      const entity = await this.resolveChannelEntity(client, channelId);
      
      // Build options for getMessages following Telegram docs
      // Prefer minId/maxId with reverse for deterministic paging
      let messages;
      if (minId) {
        // Newer than a known id
        messages = await client.getMessages(entity, { limit, minId, reverse: true });
      } else if (offsetId > 0) {
        // Older than a known id
        messages = await client.getMessages(entity, { limit, maxId: offsetId, reverse: true });
      } else {
        // Latest page, then normalize to ascending
        messages = await client.getMessages(entity, { limit });
      }

      // Normalize to ascending order (old->new) for stability
      const ordered = [...messages].sort((a, b) => a.id - b.id);

      // Process all messages (not just media messages)
      const mediaMessages = ordered
        .map(message => {
          let mediaInfo = null;
          let title = message.text || message.message || '';
          let mediaType = 'text'; // Default to text message

          if (!message.media) {
            // Pure text message
            mediaType = 'text';
          } else if (message.media.className === 'MessageMediaDocument' && message.media.document) {
            const doc = message.media.document;
            const videoAttr = doc.attributes?.find(attr => attr.className === 'DocumentAttributeVideo');
            const fileAttr = doc.attributes?.find(attr => attr.className === 'DocumentAttributeFilename');
            const audioAttr = doc.attributes?.find(attr => attr.className === 'DocumentAttributeAudio');
            
            if (doc.mimeType?.startsWith('video/')) {
              mediaType = 'video';
              title = title || fileAttr?.fileName || `Video ${message.id}`;
            } else if (doc.mimeType?.startsWith('audio/')) {
              mediaType = 'audio';
              title = title || fileAttr?.fileName || `Audio ${message.id}`;
            } else {
              mediaType = 'document';
              title = title || fileAttr?.fileName || `Document ${message.id}`;
            }

            mediaInfo = {
              duration: videoAttr?.duration || audioAttr?.duration || 0,
              size: doc.size || 0,
              mimeType: doc.mimeType,
              fileName: fileAttr?.fileName || `${mediaType}_${message.id}`,
              width: videoAttr?.w || 0,
              height: videoAttr?.h || 0
            };
          } else if (message.media.className === 'MessageMediaPhoto' && message.media.photo) {
            mediaType = 'photo';
            title = title || `Photo ${message.id}`;
            const photo = message.media.photo;
            
            // Note: Telegram's PhotoStrippedSize (thumbSize.bytes) is not a valid JPEG
            // It's a compressed format that needs special decoding
            // For now, we'll skip the thumbnail and let frontend load full images on demand
            
            mediaInfo = {
              size: photo.sizes ? photo.sizes[photo.sizes.length - 1]?.size || 0 : 0,
              mimeType: 'image/jpeg',
              fileName: `photo_${message.id}.jpg`,
              width: photo.sizes ? photo.sizes[photo.sizes.length - 1]?.w || 0 : 0,
              height: photo.sizes ? photo.sizes[photo.sizes.length - 1]?.h || 0 : 0,
              hasPhoto: true,
              photoId: photo.id?.toString() || message.id.toString()
            };
          }
          
          return {
            id: message.id,
            title: title,
            text: message.text || message.message || '',
            date: message.date,
            mediaType: mediaType,
            media: mediaInfo,
            views: message.views || 0,
            forwards: message.forwards || 0
          };
        }); // Return all messages

      return mediaMessages;
    } catch (error) {
      console.error('Error getting channel messages:', error);
      throw error;
    }
  }

  // Get photo from a message
  async getMessagePhoto(sessionId, channelId, messageId) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      
      // Try to restore session if not in memory
      if (!sessionData) {
        sessionData = await this.restoreSession(sessionId);
      }
      
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      const entity = await this.resolveChannelEntity(client, channelId);
      const messages = await client.getMessages(entity, { 
        ids: [parseInt(messageId)] 
      });
      const message = messages[0];
      
      if (!message || !message.media || message.media.className !== 'MessageMediaPhoto') {
        return null;
      }
      
      // Download the photo
      const buffer = await client.downloadMedia(message.media);
      return buffer;
    } catch (error) {
      console.error('Error getting photo:', error);
      throw error;
    }
  }

  // Search messages in a channel
  async searchChannelMessages(sessionId, channelId, query, limit = 50) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      
      // Try to restore session if not in memory
      if (!sessionData) {
        sessionData = await this.restoreSession(sessionId);
      }
      
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      const entity = await this.resolveChannelEntity(client, channelId);
      
      // Search messages using Telegram's search API
      const result = await client.invoke(
        new Api.messages.Search({
          peer: entity,
          q: query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: limit,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        })
      );
      
      // Process search results
      const searchResults = result.messages.map(message => {
        let mediaInfo = null;
        let title = message.text || message.message || '';
        let mediaType = 'text';
        
        if (message.media) {
          if (message.media.className === 'MessageMediaPhoto') {
            mediaType = 'photo';
            mediaInfo = { type: 'photo' };
          } else if (message.media.className === 'MessageMediaDocument') {
            const doc = message.media.document;
            if (doc && doc.attributes) {
              const videoAttr = doc.attributes.find(attr => 
                attr.className === 'DocumentAttributeVideo'
              );
              const audioAttr = doc.attributes.find(attr => 
                attr.className === 'DocumentAttributeAudio'
              );
              
              if (videoAttr) {
                mediaType = 'video';
                mediaInfo = {
                  type: 'video',
                  duration: videoAttr.duration,
                  size: typeof doc.size?.toNumber === 'function' ? doc.size.toNumber() : (doc.size || 0)
                };
              } else if (audioAttr) {
                mediaType = 'audio';
                mediaInfo = {
                  type: 'audio',
                  duration: audioAttr.duration
                };
              } else {
                mediaType = 'document';
                mediaInfo = {
                  type: 'document',
                  fileName: doc.attributes.find(attr => 
                    attr.className === 'DocumentAttributeFilename'
                  )?.fileName
                };
              }
            }
          }
        }
        
        return {
          id: message.id,
          text: message.message || message.text || '',
          title: title,
          date: message.date,
          mediaType,
          media: mediaInfo,
          views: message.views || 0,
          channelId: parseInt(channelId)
        };
      });
      
      return searchResults;
    } catch (error) {
      console.error('Error searching messages:', error);
      throw error;
    }
  }

  // Find the earliest message ID within a date range [startSec, endSec)
  async getFirstMessageIdByDateRange(sessionId, channelId, startSec, endSec) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      if (!sessionData) sessionData = await this.restoreSession(sessionId);
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      const entity = await this.resolveChannelEntity(client, channelId);

      // 1) Cache check (only when range is exactly one local day)
      const toDayKey = (sec) => {
        const d = new Date(sec * 1000);
        const y = d.getFullYear();
        const m = (d.getMonth() + 1).toString().padStart(2, '0');
        const dd = d.getDate().toString().padStart(2, '0');
        return `${y}-${m}-${dd}`;
      };
      const isFullDay = (endSec - startSec) >= 86400 && (endSec - startSec) <= 90000; // allow small drift
      const dayKey = isFullDay ? toDayKey(startSec) : null;
      const chanKey = `${sessionId}:${channelId}`;
      if (dayKey) {
        const channelCache = this.dateIdCache.get(chanKey);
        const entry = channelCache?.get(dayKey);
        if (entry && entry.id !== undefined) {
          return entry.id || null; // 0 treated as null
        }
      }

      // Helper to fetch the newest message (latest id)
      const getLatest = async () => {
        const arr = await client.getMessages(entity, { limit: 1 });
        return arr && arr[0] ? arr[0] : null;
      };

      // 2) Fast-path with binary search on message id to approximate boundary
      const latest = await getLatest();
      if (!latest) return null;
      if (latest.date < startSec) {
        // All messages are earlier than target day
        if (dayKey) {
          let m = this.dateIdCache.get(chanKey); if (!m) { m = new Map(); this.dateIdCache.set(chanKey, m); }
          m.set(dayKey, { id: 0, ts: Date.now() });
        }
        return null;
      }

      let low = 0;                  // date(low) < start
      let high = latest.id + 1;     // sentinel: date(high) >= start (virtual)
      let candidateId = null;
      for (let i = 0; i < 25 && high - low > 1; i++) {
        const mid = Math.floor((low + high) / 2);
        const page = await client.getMessages(entity, { limit: 1, maxId: mid });
        const msg = page && page[0] ? page[0] : null;
        if (!msg) {
          // No message at or before mid, move high down
          high = mid;
          continue;
        }
        if (msg.date >= startSec) {
          candidateId = msg.id;
          high = msg.id; // search earlier ids
        } else {
          low = msg.id; // need later ids
        }
      }

      // If we still don't have a candidate, fallback to search
      let foundId = candidateId;

      // 3) Refine to the earliest message within the day by scanning backward in small batches
      if (foundId) {
        let curMax = foundId;
        const batch = 100;
        for (let step = 0; step < 30; step++) { // up to 3000 msgs
          const msgs = await client.getMessages(entity, { limit: batch, maxId: curMax });
          if (!msgs || msgs.length === 0) break;
          // Iterate from oldest to newest within this batch
          let oldest = msgs[msgs.length - 1];
          // If even the oldest is within day, keep going further back
          if (oldest && oldest.date >= startSec) {
            curMax = oldest.id;
            foundId = oldest.id;
            continue;
          }
          // Otherwise, find first that is within the day
          for (let k = msgs.length - 1; k >= 0; k--) {
            const m = msgs[k];
            if (m.date >= startSec) foundId = m.id; else break;
          }
          break;
        }
      }

      // 4) Validate within [startSec, endSec)
      if (foundId) {
        const check = await client.getMessages(entity, { ids: [foundId] });
        const mm = check && check[0];
        if (!mm || !(mm.date >= startSec && mm.date < endSec)) {
          foundId = null;
        }
      }

      // 5) Fallback: limited search within day if binary search failed
      if (!foundId) {
        let earliest = null;
        let offsetId = 0;
        for (let pages = 0; pages < 8; pages++) { // smaller cap due to preceding steps
          const result = await client.invoke(new Api.messages.Search({
            peer: entity,
            q: '',
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: startSec,
            maxDate: endSec,
            offsetId,
            addOffset: 0,
            limit: 100,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          }));
          const msgs = result.messages || [];
          if (!msgs.length) break;
          for (const m of msgs) {
            if (typeof m.date === 'number' && m.date >= startSec && m.date < endSec) {
              if (!earliest || m.date < earliest.date) earliest = m;
            }
          }
          const oldest = msgs[msgs.length - 1];
          if (!oldest) break;
          offsetId = oldest.id;
          if (oldest.date && oldest.date < startSec) break;
        }
        foundId = earliest ? earliest.id : null;
      }

      // 6) Cache result for whole day queries
      if (dayKey) {
        let m = this.dateIdCache.get(chanKey);
        if (!m) { m = new Map(); this.dateIdCache.set(chanKey, m); }
        m.set(dayKey, { id: foundId || 0, ts: Date.now() });
      }

      return foundId;
    } catch (error) {
      console.error('Error searching earliest message by date:', error);
      throw error;
    }
  }

  // Get messages strictly within a date range [startSec, endSec)
  // Supports pagination via minId: only return messages with id > minId
  async getMessagesByDateRange(sessionId, channelId, startSec, endSec, limit = 50, minId = 0) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      if (!sessionData) sessionData = await this.restoreSession(sessionId);
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      const entity = await this.resolveChannelEntity(client, channelId);

      const result = await client.invoke(new Api.messages.Search({
        peer: entity,
        q: '',
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: startSec,
        maxDate: endSec,
        offsetId: 0,
        addOffset: 0,
        limit: limit,
        maxId: 0,
        minId: minId || 0,
        hash: BigInt(0),
      }));

      const list = (result.messages || []).map((message) => {
        let mediaInfo = null;
        let title = message.text || message.message || '';
        let mediaType = 'text';

        if (message.media) {
          if (message.media.className === 'MessageMediaPhoto') {
            mediaType = 'photo';
            mediaInfo = { type: 'photo' };
          } else if (message.media.className === 'MessageMediaDocument') {
            const doc = message.media.document;
            if (doc && doc.attributes) {
              const videoAttr = doc.attributes.find(a => a.className === 'DocumentAttributeVideo');
              const audioAttr = doc.attributes.find(a => a.className === 'DocumentAttributeAudio');
              const filenameAttr = doc.attributes.find(a => a.className === 'DocumentAttributeFilename');
              if (videoAttr) {
                mediaType = 'video';
                title = filenameAttr?.fileName || title || 'Video';
                mediaInfo = {
                  type: 'video',
                  duration: videoAttr.duration,
                  width: videoAttr.w,
                  height: videoAttr.h,
                  fileName: filenameAttr?.fileName,
                  size: typeof doc.size?.toNumber === 'function' ? doc.size.toNumber() : (doc.size || 0)
                };
              } else if (audioAttr) {
                mediaType = 'audio';
                title = filenameAttr?.fileName || audioAttr.title || 'Audio';
                mediaInfo = {
                  type: 'audio',
                  duration: audioAttr.duration,
                  title: audioAttr.title,
                  performer: audioAttr.performer,
                  fileName: filenameAttr?.fileName
                };
              } else {
                mediaType = 'document';
                title = filenameAttr?.fileName || 'Document';
                mediaInfo = {
                  type: 'document',
                  fileName: filenameAttr?.fileName,
                  size: typeof doc.size?.toNumber === 'function' ? doc.size.toNumber() : (doc.size || 0)
                };
              }
            }
          }
        }

        return {
          id: message.id,
          text: message.message || message.text || '',
          title: title,
          date: message.date,
          mediaType: mediaType,
          media: mediaInfo,
          views: message.views || 0,
          channelId: parseInt(channelId)
        };
      });

      // Ascending: old -> new for consistent merging on frontend
      const videos = list.sort((a, b) => a.id - b.id);
      const nextCursorId = videos.length ? videos[videos.length - 1].id : (minId || 0);
      return { videos, nextCursorId };
    } catch (error) {
      console.error('Error getting messages by date range:', error);
      throw error;
    }
  }

  // Get messages around a specific message ID
  async getMessagesAround(sessionId, channelId, messageId, limit = 20) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      
      // Try to restore session if not in memory
      if (!sessionData) {
        sessionData = await this.restoreSession(sessionId);
      }
      
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      const entity = await this.resolveChannelEntity(client, channelId);
      
      // Get messages around the target ID using minId/maxId per Telegram docs
      const halfLimit = Math.floor(limit / 2);
      const before = await client.getMessages(entity, { limit: halfLimit, maxId: messageId, reverse: true });
      const after = await client.getMessages(entity, { limit: halfLimit + 1, minId: messageId, reverse: true });
      // Combine, dedupe, and normalize to ascending
      const map = new Map();
      [...before, ...after].forEach(m => { if (m) map.set(m.id, m); });
      const uniqueMessages = Array.from(map.values()).sort((a, b) => a.id - b.id);
      
      // Process messages similar to getChannelMessages
      const processedMessages = uniqueMessages.map(message => {
        let mediaInfo = null;
        let title = message.text || message.message || '';
        let mediaType = 'text';
        
        if (message.media) {
          if (message.media.className === 'MessageMediaPhoto') {
            mediaType = 'photo';
            mediaInfo = { type: 'photo' };
          } else if (message.media.className === 'MessageMediaDocument') {
            const doc = message.media.document;
            if (doc && doc.attributes) {
              const videoAttr = doc.attributes.find(attr => 
                attr.className === 'DocumentAttributeVideo'
              );
              const audioAttr = doc.attributes.find(attr => 
                attr.className === 'DocumentAttributeAudio'
              );
              const filenameAttr = doc.attributes.find(attr => 
                attr.className === 'DocumentAttributeFilename'
              );
              
              if (videoAttr) {
                mediaType = 'video';
                title = filenameAttr?.fileName || title || 'Video';
                mediaInfo = {
                  type: 'video',
                  duration: videoAttr.duration,
                  width: videoAttr.w,
                  height: videoAttr.h,
                  fileName: filenameAttr?.fileName,
                  size: typeof doc.size?.toNumber === 'function' ? doc.size.toNumber() : (doc.size || 0)
                };
              } else if (audioAttr) {
                mediaType = 'audio';
                title = filenameAttr?.fileName || audioAttr.title || 'Audio';
                mediaInfo = {
                  type: 'audio',
                  duration: audioAttr.duration,
                  title: audioAttr.title,
                  performer: audioAttr.performer,
                  fileName: filenameAttr?.fileName
                };
              } else {
                mediaType = 'document';
                title = filenameAttr?.fileName || 'Document';
                mediaInfo = {
                  type: 'document',
                  fileName: filenameAttr?.fileName,
                  size: typeof doc.size?.toNumber === 'function' ? doc.size.toNumber() : (doc.size || 0)
                };
              }
            }
          }
        }
        
        return {
          id: message.id,
          text: message.message || message.text || '',
          title: title,
          date: message.date,
          views: message.views || 0,
          mediaType: mediaType,
          media: mediaInfo,
          channelId: parseInt(channelId)
        };
      }).filter(Boolean).sort((a, b) => a.id - b.id);
      
      return processedMessages;
    } catch (error) {
      console.error('Error getting messages around ID:', error);
      throw error;
    }
  }

  // Download media file with retry mechanism for expired file references
  async downloadMedia(sessionId, channelId, messageId, progressCallback) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.ensureInitialized();
        let sessionData = this.sessions.get(sessionId);
        
        // Try to restore session if not in memory
        if (!sessionData) {
          sessionData = await this.restoreSession(sessionId);
        }
        
        if (!sessionData || !sessionData.authenticated) {
          throw new Error('User not authenticated');
        }

        const { client } = sessionData;
        const entity = await this.resolveChannelEntity(client, channelId);
        // Always fetch fresh message data to get updated file reference
        const messages = await client.getMessages(entity, { 
          ids: [parseInt(messageId)] 
        });
        const message = messages[0];
        
        if (!message || !message.media) {
          throw new Error('Message or media not found');
        }

        const fileAttr = message.media.document.attributes
          .find(attr => attr.className === 'DocumentAttributeFilename');
        const fileName = fileAttr?.fileName || `video_${messageId}.mp4`;
        
        // Ensure downloads directory exists
        const downloadsDir = process.env.DOWNLOAD_PATH || path.join(process.cwd(), 'downloads');
        await fsExtra.ensureDir(downloadsDir);
        
        const filePath = path.join(downloadsDir, fileName);
        
        console.log(`Download attempt ${attempt + 1}/${maxRetries} for ${fileName}`);
        
        const workers = parseInt(process.env.TG_DL_WORKERS || process.env.DOWNLOAD_WORKERS || '4', 10);
        const partSizeKB = parseInt(process.env.TG_DL_PART_SIZE_KB || process.env.DOWNLOAD_PART_SIZE_KB || '512', 10);
        const buffer = await client.downloadMedia(message.media, {
          progressCallback: (received, total) => {
            const progress = (received / total) * 100;
            if (progressCallback) {
              const shouldContinue = progressCallback(progress, received, total);
              // If progressCallback returns false, abort the download
              if (shouldContinue === false) {
                throw new Error('Download cancelled by user');
              }
            }
          },
          workers,
          partSizeKB
        });

        await fsExtra.writeFile(filePath, buffer);
        
        console.log(`Download successful for ${fileName} on attempt ${attempt + 1}`);
        
        return {
          fileName,
          filePath,
          size: buffer.length,
          success: true
        };
        
      } catch (error) {
        lastError = error;
        console.error(`Download attempt ${attempt + 1}/${maxRetries} failed:`, error.message);
        
        // Check if this is a FILE_REFERENCE_EXPIRED error or similar
        const isRetriableError = error.message && (
          error.message.includes('FILE_REFERENCE_EXPIRED') ||
          error.message.includes('FILE_REFERENCE_INVALID') ||
          error.message.includes('FILE_ID_INVALID')
        );
        
        if (!isRetriableError || attempt === maxRetries - 1) {
          // If it's not a retriable error or we've exhausted all retries, throw the error
          break;
        }
        
        // Wait a bit before retrying (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // If we get here, all retries failed
    console.error(`All ${maxRetries} download attempts failed for message ${messageId}`);
    throw lastError;
  }

  // Download media into memory and return a Buffer (no disk write)
  async downloadMediaBuffer(sessionId, channelId, messageId, progressCallback) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.ensureInitialized();
        let sessionData = this.sessions.get(sessionId);

        if (!sessionData) {
          sessionData = await this.restoreSession(sessionId);
        }

        if (!sessionData || !sessionData.authenticated) {
          throw new Error('User not authenticated');
        }

        const { client } = sessionData;
        const entity = await this.resolveChannelEntity(client, channelId);
        // Fetch latest message to ensure valid file reference
        const messages = await client.getMessages(entity, { ids: [parseInt(messageId)] });
        const message = messages[0];
        if (!message || !message.media) {
          throw new Error('Message or media not found');
        }

        const doc = message.media.document;
        const fileAttr = doc?.attributes?.find(a => a.className === 'DocumentAttributeFilename');
        const videoAttr = doc?.attributes?.find(a => a.className === 'DocumentAttributeVideo');
        const fileName = fileAttr?.fileName || `video_${messageId}.mp4`;
        const mimeType = doc?.mimeType || 'application/octet-stream';

        const buffer = await client.downloadMedia(message.media, {
          progressCallback: (received, total) => {
            const progress = total ? (received / total) * 100 : 0;
            if (progressCallback) progressCallback(progress, received, total);
          }
        });

        return { buffer, fileName, mimeType, size: buffer.length, duration: videoAttr?.duration };
      } catch (error) {
        lastError = error;
        const isRetriableError = error.message && (
          error.message.includes('FILE_REFERENCE_EXPIRED') ||
          error.message.includes('FILE_REFERENCE_INVALID') ||
          error.message.includes('FILE_ID_INVALID')
        );
        if (!isRetriableError || attempt === maxRetries - 1) break;
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  
  // Download media pointed by a Telegram message link to a local path
  // Supports links: https://t.me/c/<internal>/<msgId> and https://t.me/<username>/<msgId>
  // This implementation streams directly to disk and retries on transient errors
  // to avoid hanging mid-download (e.g., FILE_REFERENCE_EXPIRED / network hiccups).
  async downloadFromMessageLinkToPath(sessionId, link, targetPath, progressCallback) {
    await this.ensureInitialized();
    let sessionData = this.sessions.get(sessionId);
    if (!sessionData) sessionData = await this.restoreSession(sessionId);
    if (!sessionData || !sessionData.authenticated) {
      throw new Error('User not authenticated');
    }

    const { client } = sessionData;
    // Parse link (allow trailing query params like ?single)
    const m1 = link.match(/https?:\/\/t\.me\/c\/(\d+)\/(\d+)/i);
    const m2 = link.match(/https?:\/\/t\.me\/([A-Za-z0-9_]{4,})\/(\d+)/i);
    let entity;
    let msgId;
    if (m1) {
      const internal = m1[1];
      msgId = parseInt(m1[2], 10);
      // Full channel id is -100 + internal
      const fullId = BigInt(`-100${internal}`);
      try {
        entity = await client.getEntity(fullId);
      } catch (e) {
        // Refresh dialogs to populate entity cache (fix PeerChannel not found)
        try { await client.getDialogs(); entity = await client.getEntity(fullId); } catch (ee) {
          throw new Error('Could not find the input entity for channel; please ensure the account has joined this chat');
        }
      }
    } else if (m2) {
      const username = m2[1];
      msgId = parseInt(m2[2], 10);
      try {
        entity = await client.getEntity(username);
      } catch (e) {
        try { await client.getDialogs(); entity = await client.getEntity(username); } catch (ee) {
          throw new Error('Could not resolve username entity; please ensure the account can access this channel');
        }
      }
    } else {
      throw new Error('Unsupported link format');
    }

    // Helper to fetch latest Message (refreshes fileReference if needed)
    const fetchMessage = async () => {
      const messages = await client.getMessages(entity, { ids: [msgId] });
      const message = messages?.[0];
      if (!message || !message.media) throw new Error('Message or media not found');
      return message;
    };

    // Compute a stable, safe final filepath
    const pathMod = require('path');
    const dir = pathMod.dirname(targetPath);
    await fsExtra.ensureDir(dir);

    // Inspect original filename if available
    const initial = await fetchMessage();
    const doc0 = initial.media.document;
    const fileAttr0 = doc0?.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    const videoAttr0 = doc0?.attributes?.find(a => a.className === 'DocumentAttributeVideo');
    let inferredName = (fileAttr0?.fileName || `video_${msgId}.mp4`).toString();
    if (!/\.[A-Za-z0-9]{2,5}$/.test(inferredName)) inferredName += '.mp4';
    // Keep unicode characters (e.g., Chinese), only strip path separators and illegal characters
    const safeName = inferredName
      .replace(/[\\/\0]/g, '_')
      .replace(/[<>:"|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();

    let finalPath = pathMod.join(dir, safeName);
    try {
      if (await fsExtra.pathExists(finalPath)) {
        const base = safeName.replace(/\.[^/.]+$/, '');
        const extMatch = safeName.match(/\.[^/.]+$/);
        const ext = extMatch ? extMatch[0] : '.mp4';
        finalPath = pathMod.join(dir, `${base}_${Date.now()}${ext}`);
      }
    } catch (_) {}

    // Stream to disk with retries
    const maxRetries = 4;
    let attempt = 0;
    let lastError;
    for (; attempt < maxRetries; attempt++) {
      try {
        const message = attempt === 0 ? initial : await fetchMessage();
        // Prefer passing the concrete media object to improve progress callback reliability
        const media = message.media || message;
        // Use TelegramClient.downloadMedia with outputFile to stream directly to file
        const workers = parseInt(process.env.TG_DL_WORKERS || process.env.DOWNLOAD_WORKERS || '4', 10);
        const partSizeKB = parseInt(process.env.TG_DL_PART_SIZE_KB || process.env.DOWNLOAD_PART_SIZE_KB || '512', 10);
        const resultPath = await client.downloadMedia(media, {
          outputFile: finalPath,
          progressCallback: (received, total) => {
            if (progressCallback) {
              const cont = progressCallback(received, total);
              if (cont === false) {
                throw new Error('Download cancelled by user');
              }
            }
          },
          workers,
          partSizeKB
        });

        // downloadMedia with outputFile returns the path string
        const stat = await fsExtra.stat(resultPath);
        return {
          fileName: pathMod.basename(resultPath),
          displayName: inferredName, // original for captions
          filePath: resultPath,
          size: stat.size,
          duration: (videoAttr0 && typeof videoAttr0.duration === 'number') ? videoAttr0.duration : undefined,
          width: (videoAttr0 && typeof videoAttr0.w === 'number') ? videoAttr0.w : undefined,
          height: (videoAttr0 && typeof videoAttr0.h === 'number') ? videoAttr0.h : undefined,
          mimeType: doc0?.mimeType || undefined
        };
      } catch (error) {
        lastError = error;
        const msg = (error && error.message) ? error.message : String(error);
        const retriable = /FILE_REFERENCE_EXPIRED|FILE_REFERENCE_INVALID|FILE_ID_INVALID|TIMEOUT|NET|FLOOD_WAIT|RPC_CALL_FAIL/i.test(msg);
        // Clean up partial file between attempts
        try { if (await fsExtra.pathExists(finalPath)) await fsExtra.unlink(finalPath); } catch (_) {}
        if (!retriable || attempt === maxRetries - 1) break;
        const delay = Math.min(30000, (2 ** attempt) * 1000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError || new Error('Unknown download error');
  }

  /**
   * Peek meta information from a t.me link without downloading.
   * Returns { displayName, size, duration, width, height, mimeType }
   */
  async getMessageMetaFromLink(sessionId, link) {
    await this.ensureInitialized();
    let sessionData = this.sessions.get(sessionId);
    if (!sessionData) sessionData = await this.restoreSession(sessionId);
    if (!sessionData || !sessionData.authenticated) {
      throw new Error('User not authenticated');
    }

    const { client } = sessionData;
    const m1 = link.match(/https?:\/\/t\.me\/c\/(\d+)\/(\d+)/i);
    const m2 = link.match(/https?:\/\/t\.me\/([A-Za-z0-9_]{4,})\/(\d+)/i);
    let entity;
    let msgId;
    if (m1) {
      const internal = m1[1];
      msgId = parseInt(m1[2], 10);
      const fullId = BigInt(`-100${internal}`);
      try {
        entity = await client.getEntity(fullId);
      } catch (_) {
        // 冷启动时 entity 缓存可能为空，先拉取 dialogs 再重试
        try { await client.getDialogs(); entity = await client.getEntity(fullId); } catch (ee) {
          throw new Error('Could not find the input entity for channel; please ensure the account has joined this chat');
        }
      }
    } else if (m2) {
      const username = m2[1];
      msgId = parseInt(m2[2], 10);
      try {
        entity = await client.getEntity(username);
      } catch (_) {
        try { await client.getDialogs(); entity = await client.getEntity(username); } catch (ee) {
          throw new Error('Could not resolve username entity; please ensure the account can access this channel');
        }
      }
    } else {
      throw new Error('Unsupported link format');
    }
    const messages = await client.getMessages(entity, { ids: [msgId] });
    const message = messages?.[0];
    if (!message || !message.media || message.media.className !== 'MessageMediaDocument') return null;
    const doc = message.media.document;
    const fileAttr = doc?.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    const videoAttr = doc?.attributes?.find(a => a.className === 'DocumentAttributeVideo');
    let inferredName = (fileAttr?.fileName || `video_${msgId}.mp4`).toString();
    if (!/\.[A-Za-z0-9]{2,5}$/.test(inferredName)) inferredName += '.mp4';
    const displayName = inferredName.replace(/[\\/\0]/g, '_').replace(/[<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
    // Robust size extraction across GramJS versions
    const sizeBI = doc?.size;
    let size;
    if (sizeBI != null) {
      if (typeof sizeBI === 'number') size = sizeBI;
      else if (typeof sizeBI.toJSNumber === 'function') size = sizeBI.toJSNumber();
      else if (typeof sizeBI.toNumber === 'function') size = sizeBI.toNumber();
      else {
        const n = Number(sizeBI);
        size = Number.isFinite(n) ? n : undefined;
      }
    }
    return {
      displayName,
      size,
      duration: (videoAttr && typeof videoAttr.duration === 'number') ? videoAttr.duration : undefined,
      width: (videoAttr && typeof videoAttr.w === 'number') ? videoAttr.w : undefined,
      height: (videoAttr && typeof videoAttr.h === 'number') ? videoAttr.h : undefined,
      mimeType: doc?.mimeType || undefined,
    };
  }

  // Fetch thumbnail image (JPEG) for a message link.
  // Returns Buffer or null if not available.
  async getThumbnailFromMessageLink(sessionId, link, size = 'm') {
    await this.ensureInitialized();
    let sessionData = this.sessions.get(sessionId);
    if (!sessionData) sessionData = await this.restoreSession(sessionId);
    if (!sessionData || !sessionData.authenticated) {
      throw new Error('User not authenticated');
    }

    const { client } = sessionData;
    const m1 = link.match(/https?:\/\/t\.me\/c\/(\d+)\/(\d+)/i);
    const m2 = link.match(/https?:\/\/t\.me\/([A-Za-z0-9_]{4,})\/(\d+)/i);
    let entity;
    let msgId;
    if (m1) {
      const internal = m1[1];
      msgId = parseInt(m1[2], 10);
      entity = await client.getEntity(BigInt(`-100${internal}`));
    } else if (m2) {
      const username = m2[1];
      msgId = parseInt(m2[2], 10);
      entity = await client.getEntity(username);
    } else {
      throw new Error('Unsupported link format');
    }

    const messages = await client.getMessages(entity, { ids: [msgId] });
    const message = messages?.[0];
    if (!message || !message.media || message.media.className !== 'MessageMediaDocument') return null;
    const doc = message.media.document;

    // Try GramJS convenience method
    try {
      const buffer = await client.downloadMedia(message.media, { thumb: size });
      if (buffer && buffer.length > 0) return buffer;
    } catch (_) { /* fallthrough */ }

    // Fallback via file location specifying thumbSize
    try {
      const fileLocation = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: size
      });
      const buffer = await client.downloadFile({ file: fileLocation, dcId: doc.dcId });
      if (buffer && buffer.length > 0) return buffer;
    } catch (_) { /* ignore */ }
    return null;
  }

  // Stream media directly to an HTTP response without buffering whole file
  // options: { disposition: 'inline' | 'attachment' }
  async streamMediaToResponse(sessionId, channelId, messageId, res, options = {}, progressCallback) {
    await this.ensureInitialized();
    let sessionData = this.sessions.get(sessionId);
    if (!sessionData) {
      sessionData = await this.restoreSession(sessionId);
    }
    if (!sessionData || !sessionData.authenticated) {
      throw new Error('User not authenticated');
    }

    const { client } = sessionData;
    const entity = await this.resolveChannelEntity(client, channelId);

    // Fetch message to build input location
    const messages = await client.getMessages(entity, { ids: [parseInt(messageId)] });
    const message = messages[0];
    if (!message || !message.media || message.media.className !== 'MessageMediaDocument') {
      throw new Error('Message not found or is not a document');
    }

    const doc = message.media.document;
    const fileAttr = doc?.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    const fileName = fileAttr?.fileName || `video_${messageId}.mp4`;
    const mimeType = doc?.mimeType || 'application/octet-stream';
    const totalSize = typeof doc.size?.toNumber === 'function' ? doc.size.toNumber() : (doc.size || undefined);

    // RFC5987-compliant filename header for non-ASCII names
    const fallback = fileName
      .replace(/[\r\n]/g, ' ')
      .replace(/"/g, '')
      .replace(/[^\x20-\x7E]/g, '_');
    const encodeRFC5987 = (str) => encodeURIComponent(str)
      .replace(/\*/g, '%2A')
      .replace(/%(7C|60|5E)/g, '%25$1');

    res.setHeader('Content-Type', mimeType);
    const disposition = (options && options.disposition) === 'inline' ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(fileName)}`);
    // Prefer chunked transfer to avoid waiting for full size
    if (totalSize && Number.isFinite(totalSize)) {
      res.setHeader('Content-Length', totalSize);
    } else {
      res.setHeader('Transfer-Encoding', 'chunked');
    }
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Stream chunks
    const fileLocation = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: ''
    });

    let aborted = false;
    res.on('close', () => { aborted = true; });

    const requestSize = 512 * 1024; // 512KB per request
    const iter = client.iterDownload({
      file: fileLocation,
      requestSize,
      dcId: doc.dcId,
      fileSize: doc.size
    });

    for await (const chunk of iter) {
      if (aborted) break;
      if (progressCallback) {
        // We don't have running totals here; optional progressCB can be called with chunk length
        progressCallback(undefined, undefined, undefined);
      }
      const canContinue = res.write(chunk);
      if (!canContinue) {
        await new Promise(resolve => res.once('drain', resolve));
      }
    }
    if (!aborted) res.end();
  }

  // Download a video's thumbnail image (JPEG) for preview
  async getMessageVideoThumbnail(sessionId, channelId, messageId, size = 'm') {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      if (!sessionData) {
        sessionData = await this.restoreSession(sessionId);
      }
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      const entity = await this.resolveChannelEntity(client, channelId);
      const messages = await client.getMessages(entity, { ids: [parseInt(messageId)] });
      const message = messages[0];
      if (!message || !message.media || message.media.className !== 'MessageMediaDocument') {
        return null; // Not a document/video
      }

      const doc = message.media.document;

      // First try GramJS convenience method to fetch a thumbnail
      try {
        const buffer = await client.downloadMedia(message.media, { thumb: size });
        if (buffer && buffer.length > 0) {
          return { buffer, contentType: 'image/jpeg' };
        }
      } catch (_) { /* fallthrough to direct file location */ }

      // Fallback: download via file location specifying thumbSize
      try {
        const fileLocation = new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: size
        });
        const buffer = await client.downloadFile({ file: fileLocation, dcId: doc.dcId });
        if (buffer && buffer.length > 0) {
          return { buffer, contentType: 'image/jpeg' };
        }
      } catch (e) {
        console.error('Thumbnail download fallback failed:', e.message);
      }

      return null;
    } catch (error) {
      console.error('Error getting video thumbnail:', error);
      throw error;
    }
  }

  // Find related videos for batch download
  async findRelatedVideos(sessionId, channelId, videoId) {
    try {
      await this.ensureInitialized();
      let sessionData = this.sessions.get(sessionId);
      
      // Try to restore session if not in memory
      if (!sessionData) {
        sessionData = await this.restoreSession(sessionId);
      }
      
      if (!sessionData || !sessionData.authenticated) {
        throw new Error('User not authenticated');
      }

      const { client } = sessionData;
      // Resolve entity to avoid CHAT_ID_INVALID after restart
      const entity = await this.resolveChannelEntity(client, channelId);
      
      // Get the target video message
      const targetMessages = await client.getMessages(entity, { 
        ids: [parseInt(videoId)] 
      });
      const targetMessage = targetMessages[0];
      
      if (!targetMessage) {
        throw new Error('Target message not found');
      }
      
      let folderName = '';
      let textMessageId = null;
      let startId = targetMessage.id;
      
      // Check if the video message itself contains text
      console.log(`Target message ${targetMessage.id} has text: "${targetMessage.message?.substring(0, 100)}"`);
      
      if (targetMessage.message && targetMessage.message.trim()) {
        folderName = targetMessage.message;
        textMessageId = targetMessage.id;
        // Start from this message
        startId = targetMessage.id;
        console.log(`Using target message text as folder name`);
      } else {
        // Search backwards (older messages) for a text message
        // Get messages before the target video (older messages have smaller IDs)
      console.log(`Searching backwards for text message before ${targetMessage.id}`);
        
      const olderMessages = await client.getMessages(await this.resolveChannelEntity(client, channelId), {
          limit: 50,
          offsetId: targetMessage.id,
          addOffset: 0  // Get messages before this ID
        });
        
        console.log(`Got ${olderMessages.length} older messages to search`);
        
        // Find the first text message going backwards
        for (const msg of olderMessages) {
          console.log(`Checking message ${msg.id}: hasText=${!!msg.message?.trim()}, text="${msg.message?.substring(0, 50)}"`);
          if (msg.message && msg.message.trim() && msg.id < targetMessage.id) {
            folderName = msg.message;
            textMessageId = msg.id;
            startId = msg.id;
            console.log(`Found text message at ${msg.id}: "${msg.message.substring(0, 100)}"`);
            break;
          }
        }
      }
      
      // If no text message found, use a default name
      if (!folderName) {
        folderName = `Videos_${new Date().toISOString().split('T')[0]}`;
        startId = targetMessage.id;
      }
      
      // Step 1: First find the next text message ID to establish the end boundary
      let nextTextMessageId = null;
      console.log(`Finding next text message after ${startId}`);
      
      // Use offsetId with negative addOffset to get messages right after startId
      // This ensures we get messages immediately following startId, not the latest messages
      let searchOffset = 0;
      let foundTextMessage = false;
      
      while (!foundTextMessage && searchOffset < 500) {
        const forwardMessages = await client.getMessages(entity, {
          limit: 20,  // Smaller batch to get nearby messages
          offsetId: startId,
          addOffset: -searchOffset  // Negative offset to get messages after offsetId
        });
        
        console.log(`Searching batch with offset ${searchOffset}, got ${forwardMessages.length} messages`);
        
        // Reverse to process in chronological order (oldest to newest)
        // This ensures we find the closest next text message
        for (const msg of forwardMessages.reverse()) {
          if (msg.id > startId && msg.message && msg.message.trim()) {
            // Skip messages that have both text and media (like photos with captions)
           // if (!msg.media || msg.media.className !== 'MessageMediaDocument') {
              nextTextMessageId = msg.id;
              console.log(`Found next text message boundary at ${msg.id}: "${msg.message.substring(0, 50)}..."`);
              foundTextMessage = true;
              break;
            //}
          }
        }
        
        if (!foundTextMessage && forwardMessages.length > 0) {
          // Move to next batch
          searchOffset += 20;
        } else if (forwardMessages.length === 0) {
          break;  // No more messages
        }
      }
      
      if (!nextTextMessageId) {
        console.log('No next text message found, will collect all videos from start point');
      }
      
      // Step 2: Now collect all videos between startId and nextTextMessageId
      const allVideos = [];
      console.log(`Collecting videos between ${startId} and ${nextTextMessageId || 'end'}`);
      
      // Get all messages in the range
      const rangeMessages = await client.getMessages(await this.resolveChannelEntity(client, channelId), {
        limit: 500,
        minId: startId,
        maxId: nextTextMessageId || undefined  // If nextTextMessageId is null, get all messages after startId
      });
      
      console.log(`Got ${rangeMessages.length} messages in range`);
      
      for (const msg of rangeMessages) {
        // Skip the start text message itself
        if (msg.id <= startId) {
          console.log(`Skipping start point message ${msg.id}`);
          continue;
        }
        
        // Skip the end text message
        if (nextTextMessageId && msg.id >= nextTextMessageId) {
          console.log(`Skipping end boundary message ${msg.id}`);
          continue;
        }
        
        console.log(`Processing message ${msg.id}: hasMedia=${!!msg.media}, mediaType=${msg.media?.className}`);
        
        // Collect video messages only
        if (msg.media && msg.media.className === 'MessageMediaDocument') {
          const doc = msg.media.document;
          if (doc && doc.attributes) {
            const videoAttr = doc.attributes.find(attr => 
              attr.className === 'DocumentAttributeVideo'
            );
            
            if (videoAttr) {
              const filenameAttr = doc.attributes.find(attr => 
                attr.className === 'DocumentAttributeFilename'
              );
              
              const filename = filenameAttr?.fileName || `video_${msg.id}.mp4`;
              console.log(`Found video at message ${msg.id}: ${filename}`);
              
              allVideos.push({
                id: msg.id,
                title: filename.replace(/\.[^/.]+$/, ""), // Remove extension for title
                filename: filename,
                size: typeof doc.size?.toNumber === 'function' ? doc.size.toNumber() : (doc.size || 0),
                duration: videoAttr.duration || 0,
                date: msg.date
              });
            }
          }
        }
      }
      
      // Sort videos by ID (chronological order)
      allVideos.sort((a, b) => a.id - b.id);
      
      return {
        folderName: folderName.substring(0, 200), // Limit folder name length
        videos: allVideos,
        textMessage: folderName,
        totalVideos: allVideos.length
      };
      
    } catch (error) {
      console.error('Error finding related videos:', error);
      throw error;
    }
  }

  // Download media file to specific path with retry mechanism
  async downloadMediaToPath(sessionId, channelId, messageId, targetPath, progressCallback) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.ensureInitialized();
        let sessionData = this.sessions.get(sessionId);
        
        // Try to restore session if not in memory
        if (!sessionData) {
          sessionData = await this.restoreSession(sessionId);
        }
        
        if (!sessionData || !sessionData.authenticated) {
          throw new Error('User not authenticated');
        }

        const { client } = sessionData;
        const entity = await this.resolveChannelEntity(client, channelId);
        
        // Always fetch fresh message data to get updated file reference
        const messages = await client.getMessages(entity, { 
          ids: [parseInt(messageId)] 
        });
        const message = messages[0];
        
        if (!message || !message.media) {
          throw new Error('Message or media not found');
        }

        const fileAttr = message.media.document?.attributes?.find(
          attr => attr.className === 'DocumentAttributeFilename'
        );
        const fileName = path.basename(targetPath);
        
        // Ensure target directory exists
        const targetDir = path.dirname(targetPath);
        await fsExtra.ensureDir(targetDir);
        
        console.log(`Download to path attempt ${attempt + 1}/${maxRetries} for ${fileName}`);
        
        const workers = parseInt(process.env.TG_DL_WORKERS || process.env.DOWNLOAD_WORKERS || '4', 10);
        const partSizeKB = parseInt(process.env.TG_DL_PART_SIZE_KB || process.env.DOWNLOAD_PART_SIZE_KB || '512', 10);
        const buffer = await client.downloadMedia(message.media, {
          progressCallback: (received, total) => {
            const progress = (received / total) * 100;
            if (progressCallback) {
              const shouldContinue = progressCallback(progress, received, total);
              // If progressCallback returns false, abort the download
              if (shouldContinue === false) {
                throw new Error('Download cancelled by user');
              }
            }
          },
          workers,
          partSizeKB
        });

        await fsExtra.writeFile(targetPath, buffer);
        
        console.log(`Download to path successful for ${fileName} on attempt ${attempt + 1}`);
        
        return {
          fileName,
          filePath: targetPath,
          size: buffer.length,
          success: true
        };
        
      } catch (error) {
        lastError = error;
        console.error(`Download to path attempt ${attempt + 1}/${maxRetries} failed:`, error.message);
        
        // Check if this is a FILE_REFERENCE_EXPIRED error or similar
        const isRetriableError = error.message && (
          error.message.includes('FILE_REFERENCE_EXPIRED') ||
          error.message.includes('FILE_REFERENCE_INVALID') ||
          error.message.includes('FILE_ID_INVALID')
        );
        
        if (!isRetriableError || attempt === maxRetries - 1) {
          // If it's not a retriable error or we've exhausted all retries, throw the error
          break;
        }
        
        // Wait a bit before retrying (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // If we get here, all retries failed
    console.error(`All ${maxRetries} download to path attempts failed for message ${messageId}`);
    throw lastError;
  }

  // Parse Telegram RPC error into structured info
  parseTelegramError(err) {
    const raw = (err && (err.errorMessage || err.message || '')).toString();
    const msg = raw.toUpperCase();
    let code = "UNKNOWN";
    let retryAfter;

    if (msg.includes('SESSION_PASSWORD_NEEDED') || msg.includes('PASSWORD')) code = 'SESSION_PASSWORD_NEEDED';
    else if (msg.includes('PHONE_CODE_INVALID')) code = 'PHONE_CODE_INVALID';
    else if (msg.includes('PHONE_CODE_EXPIRED')) code = 'PHONE_CODE_EXPIRED';
    else if (msg.includes('PHONE_CODE_HASH_INVALID')) code = 'PHONE_CODE_HASH_INVALID';
    else if (msg.includes('PHONE_NUMBER_UNOCCUPIED')) code = 'PHONE_NUMBER_UNOCCUPIED';
    else if (msg.includes('PHONE_NUMBER_INVALID')) code = 'PHONE_NUMBER_INVALID';
    else if (msg.includes('PHONE_NUMBER_FLOOD')) code = 'PHONE_NUMBER_FLOOD';
    else if (msg.includes('FLOOD_WAIT_')) { code = 'FLOOD_WAIT'; const m = msg.match(/FLOOD_WAIT_(\d+)/); if (m) retryAfter = parseInt(m[1], 10); }

    return { code, message: raw || 'Telegram authentication error', retryAfter };
  }

  // Clean up session
  cleanupSession(sessionId) {
    const sessionData = this.sessions.get(sessionId);
    if (sessionData) {
      try {
        sessionData.client.disconnect();
      } catch (error) {
        console.error('Error disconnecting client:', error);
      }
      this.sessions.delete(sessionId);
    }
    
    // Clean up promises
    globalPromises.delete(sessionId);
  }
}

module.exports = new TelegramService();
