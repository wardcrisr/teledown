import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './DownloadManager.css';

function DownloadManager({ downloads, setDownloads, sessionId }) {
  const [socket, setSocket] = useState(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    // Connect to WebSocket. Default to same-origin; allow override via VITE_WS_URL
    const socketUrl = import.meta.env.VITE_WS_URL || undefined;
    const newSocket = io(socketUrl);
    setSocket(newSocket);
    
    console.log('WebSocket connected to backend');

    // Listen for download progress updates
    newSocket.on('download-progress', (data) => {
      console.log('Progress update:', data);
      setDownloads(prev => prev.map(download => 
        download.downloadId === data.id 
          ? { 
              ...download, 
              progress: data.progress, 
              status: data.status,
              received: data.received,
              total: data.total
            }
          : download
      ));
    });

    // Listen for download completion
    newSocket.on('download-complete', (data) => {
      console.log('Download complete:', data);
      setDownloads(prev => prev.map(download => 
        download.downloadId === data.id 
          ? { ...download, progress: 100, status: 'completed', completedTime: data.completedTime }
          : download
      ));
    });

    // Listen for download errors
    newSocket.on('download-error', (data) => {
      console.log('Download error:', data);
      setDownloads(prev => prev.map(download => 
        download.downloadId === data.id 
          ? { ...download, status: 'failed', error: data.error }
          : download
      ));
    });

    // Listen for download cancellation
    newSocket.on('download-cancelled', (data) => {
      console.log('Download cancelled event received:', data);
      // Use the id from the event data
      const cancelId = data.id || data.downloadId;
      if (cancelId) {
        setDownloads(prev => prev.filter(d => d.downloadId !== cancelId));
      }
    });
    
    // Connection events for debugging
    newSocket.on('connect', () => {
      console.log('WebSocket connected');
    });
    
    newSocket.on('disconnect', () => {
      console.log('WebSocket disconnected');
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const handleCancel = async (downloadId) => {
    console.log('Cancelling download:', downloadId);
    try {
      const response = await fetch(`/api/download/cancel/${downloadId}`, {
        method: 'POST',
        headers: {
          'x-session-id': sessionId
        }
      });

      if (response.ok) {
        console.log('Download cancelled successfully');
        // Remove from UI immediately
        setDownloads(prev => prev.filter(d => d.downloadId !== downloadId));
      } else {
        console.error('Failed to cancel download, status:', response.status);
      }
    } catch (err) {
      console.error('Failed to cancel download:', err);
    }
  };

  const handleClearCompleted = () => {
    setDownloads(prev => prev.filter(d => d.status !== 'completed'));
  };

  const activeDownloads = downloads.filter(d => d.status !== 'completed');
  const completedDownloads = downloads.filter(d => d.status === 'completed');

  return (
    <div className={`download-manager ${minimized ? 'minimized' : ''}`}>
      <div className="download-manager-header">
        <h3>Downloads ({downloads.length})</h3>
        <div className="download-manager-controls">
          {completedDownloads.length > 0 && (
            <button 
              className="btn-clear"
              onClick={handleClearCompleted}
              title="Clear completed"
            >
              Clear
            </button>
          )}
          <button 
            className="btn-minimize"
            onClick={() => setMinimized(!minimized)}
          >
            {minimized ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {!minimized && (
        <div className="download-manager-content">
          {downloads.length === 0 && (
            <div className="download-empty">
              <p>No downloads yet</p>
            </div>
          )}

          {activeDownloads.map((download) => (
            <div key={download.downloadId} className={`download-item ${download.status}`}>
              <div className="download-info">
                <h4>{download.title || download.video?.title || 'Unknown Video'}</h4>
                <span className="download-channel">
                  {download.channel?.title || 'Unknown Channel'}
                  {download.folderName && ` • 📁 ${download.folderName}`}
                </span>
                {download.received && download.total && (
                  <span className="download-size">
                    {(download.received / 1024 / 1024).toFixed(1)}MB / {(download.total / 1024 / 1024).toFixed(1)}MB
                  </span>
                )}
                {download.status === 'failed' && download.error && (
                  <span className="download-error">Error: {download.error}</span>
                )}
              </div>
              <div className="download-progress-container">
                {download.status !== 'failed' ? (
                  <div className="progress-bar">
                    <div 
                      className="progress-bar-fill"
                      style={{ width: `${download.progress || 0}%` }}
                    >
                      {Math.round(download.progress || 0)}%
                    </div>
                  </div>
                ) : (
                  <div className="download-failed">Failed</div>
                )}
                <button
                  className="btn-cancel"
                  onClick={() => handleCancel(download.downloadId)}
                  title="Cancel download"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}

          {completedDownloads.length > 0 && (
            <div className="download-completed-section">
              <h4>Completed</h4>
              {completedDownloads.map((download) => (
                <div key={download.downloadId} className="download-item completed">
                  <div className="download-info">
                    <h4>{download.title || download.video?.title || 'Unknown Video'}</h4>
                    <span className="download-channel">
                      {download.channel?.title || 'Unknown Channel'}
                      {download.folderName && ` • 📁 ${download.folderName}`}
                    </span>
                  </div>
                  <div className="download-status">
                    <span className="status-complete">✓ Complete</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DownloadManager;
