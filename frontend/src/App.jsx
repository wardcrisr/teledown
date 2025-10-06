import React, { useState, useEffect } from 'react';
import LoginForm from './components/LoginForm';
import ChannelList from './components/ChannelList';
import MessageList from './components/MessageList';
import DownloadManager from './components/DownloadManager';
import BindSuccess from './components/BindSuccess';
import AdminDashboard from './components/AdminDashboard';
import './App.css';

function App() {
  // Parse botChatId from URL to support bot binding mode
  const params = new URLSearchParams(window.location.search || '');
  const botChatId = params.get('botChatId');
  const bindSecret = params.get('secret');
  const inDashboard = window.location.pathname.startsWith('/dashboard');

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [bindSuccess, setBindSuccess] = useState(false);
  const [sessionId, setSessionId] = useState(() => {
    // In binding mode, ignore existing local session to force fresh login
    if (botChatId) return null;
    const stored = localStorage.getItem('sessionId');
    console.log('Loaded sessionId from localStorage:', stored);
    return stored;
  });
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [downloads, setDownloads] = useState([]);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    if (sessionId) {
      checkAuthStatus();
    } else {
      // In binding mode, do not auto-restore any previous session
      if (!botChatId) {
        checkForRestoredSession();
      } else {
        setIsCheckingAuth(false);
      }
    }
  }, []);

  const checkForRestoredSession = async () => {
    console.log('Checking for restored sessions...');
    setIsCheckingAuth(true);
    
    try {
      const response = await fetch('/api/auth/available-session');
      const data = await response.json();
      console.log('Available session response:', data);
      
      if (data.hasSession && data.sessionId) {
        console.log('Found restored session:', data.sessionId);
        // Save the restored session
        setSessionId(data.sessionId);
        localStorage.setItem('sessionId', data.sessionId);
        setIsAuthenticated(true);
        // 重要：结束检查状态，否则界面会一直停留在“Checking authentication...”
        setIsCheckingAuth(false);
      } else {
        console.log('No restored sessions available');
        setIsCheckingAuth(false);
      }
    } catch (error) {
      console.error('Failed to check for restored session:', error);
      setIsCheckingAuth(false);
    }
  };

  const checkAuthStatus = async () => {
    if (!sessionId) {
      setIsAuthenticated(false);
      setIsCheckingAuth(false);
      return;
    }

    console.log('Checking auth status for session:', sessionId);
    setIsCheckingAuth(true);

    try {
      const response = await fetch('/api/auth/status', {
        headers: {
          'x-session-id': sessionId
        }
      });
      const data = await response.json();
      console.log('Auth status response:', data);
      
      if (data.authenticated) {
        setIsAuthenticated(true);
        console.log('User is authenticated');
      } else {
        // Session exists but not authenticated, clear it
        localStorage.removeItem('sessionId');
        setSessionId(null);
        setIsAuthenticated(false);
        console.log('Session invalid, cleared');
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      setIsAuthenticated(false);
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const handleLogin = async (newSessionId) => {
    console.log('Login successful, saving session:', newSessionId);
    setSessionId(newSessionId);
    localStorage.setItem('sessionId', newSessionId);
    setIsAuthenticated(true);

    // If opened from bot with botChatId, bind this session to that chat
    if (botChatId) {
      try {
        const url = bindSecret ? `/api/bot/bindChat?secret=${encodeURIComponent(bindSecret)}` : '/api/bot/bindChat';
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(bindSecret ? { 'x-bot-bind-secret': bindSecret } : {}) },
          body: JSON.stringify({ chatId: botChatId, sessionId: newSessionId })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || 'Bind failed');
        try { localStorage.removeItem('sessionId'); } catch (_) {}
        setIsAuthenticated(false);
        setBindSuccess(true);
      } catch (e) {
        console.error('Bind chat failed:', e);
        alert('绑定到机器人聊天失败，请稍后重试或联系管理员。');
      }
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'x-session-id': sessionId
        }
      });
    } catch (error) {
      console.error('Logout failed:', error);
    }
    
    localStorage.removeItem('sessionId');
    setSessionId(null);
    setIsAuthenticated(false);
    setSelectedChannel(null);
  };

  const handleDownload = (downloadData) => {
    const newDownload = {
      downloadId: downloadData.downloadId,
      title: downloadData.title || downloadData.media?.fileName || 'Unknown Video',
      video: downloadData.video || downloadData,
      channel: downloadData.channel || selectedChannel,
      progress: downloadData.progress || 0,
      status: downloadData.status || 'downloading',
      received: downloadData.received || 0,
      total: downloadData.total || 0,
      folderName: downloadData.folderName
    };
    console.log('Adding new download:', newDownload);
    setDownloads(prev => [...prev, newDownload]);
  };

  // Show loading while checking auth
  if (isCheckingAuth) {
    return (
      <div className="app">
        <div style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          alignItems: 'center', 
          height: '100vh',
          fontSize: '18px',
          color: '#666'
        }}>
          Checking authentication...
        </div>
      </div>
    );
  }

  if (inDashboard) {
    return (
      <div className="app">
        <main className="app-main">
          <div className="container">
            <AdminDashboard />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="container">
          <h1>Telegram Video Downloader</h1>
          {isAuthenticated && (
            <button onClick={handleLogout} className="btn btn-secondary">
              Logout
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        <div className="container">
          {!isAuthenticated ? (
            (bindSuccess && botChatId) ? (
              <BindSuccess chatId={botChatId} />
            ) : (
              <LoginForm onLogin={handleLogin} />
            )
          ) : (
            <div className="app-content">
              <div className="sidebar">
                <ChannelList 
                  sessionId={sessionId}
                  onSelectChannel={setSelectedChannel}
                  selectedChannel={selectedChannel}
                />
              </div>
              
              <div className="main-content">
                {selectedChannel ? (
                  <MessageList 
                    sessionId={sessionId}
                    channel={selectedChannel}
                    onDownload={handleDownload}
                  />
                ) : (
                  <div className="placeholder">
                    <h2>Select a channel to view messages</h2>
                    <p>Choose a channel from the list on the left to browse messages</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      {isAuthenticated && downloads.length > 0 && (
        <DownloadManager 
          downloads={downloads}
          setDownloads={setDownloads}
          sessionId={sessionId}
        />
      )}
    </div>
  );
}

export default App;
