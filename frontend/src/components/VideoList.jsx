import React, { useState, useEffect } from 'react';
import './VideoList.css';

function VideoList({ sessionId, channel, onDownload }) {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadingIds, setDownloadingIds] = useState(new Set());

  useEffect(() => {
    if (channel) {
      fetchVideos();
    }
  }, [channel]);

  const fetchVideos = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/channels/${channel.id}/videos`, {
        headers: {
          'x-session-id': sessionId
        }
      });

      if (response.ok) {
        const data = await response.json();
        setVideos(data.videos || []);
      } else {
        setError('Failed to load videos');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (video) => {
    if (downloadingIds.has(video.id)) return;

    setDownloadingIds(prev => new Set([...prev, video.id]));

    try {
      const response = await fetch('/api/download/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': sessionId
        },
        body: JSON.stringify({
          videoId: video.id,
          channelId: channel.id,
          title: video.title || video.media?.fileName || `Video_${video.id}`
        })
      });

      if (response.ok) {
        const data = await response.json();
        onDownload({ ...video, downloadId: data.downloadId });
      } else {
        console.error('Failed to start download');
      }
    } catch (err) {
      console.error('Download error:', err);
    } finally {
      setDownloadingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(video.id);
        return newSet;
      });
    }
  };

  const formatDuration = (seconds) => {
    if (!seconds) return 'N/A';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatSize = (bytes) => {
    if (!bytes) return 'N/A';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString();
  };

  return (
    <div className="video-list">
      <div className="video-list-header">
        <h3>{channel.title}</h3>
        <span className="video-count">{videos.length} videos</span>
      </div>

      <div className="video-list-content">
        {loading && (
          <div className="video-list-loading">
            <span className="loading"></span>
            <p>Loading videos...</p>
          </div>
        )}

        {error && (
          <div className="video-list-error">
            <p>{error}</p>
            <button onClick={fetchVideos} className="btn btn-secondary">
              Retry
            </button>
          </div>
        )}

        {!loading && !error && videos.length === 0 && (
          <div className="video-list-empty">
            <p>No videos found in this channel</p>
          </div>
        )}

        {!loading && !error && (
          <div className="video-grid">
            {videos.map((video) => (
              <div key={video.id} className="video-card">
                <div className="video-thumbnail">
                  <span className="video-duration">
                    {video.duration || formatDuration(video.media?.duration)}
                  </span>
                </div>
                <div className="video-info">
                  <h4 title={video.title}>{video.title}</h4>
                  {video.text && video.text !== video.title && (
                    <p className="video-description">{video.text}</p>
                  )}
                  <div className="video-meta">
                    <span>{formatSize(video.media?.size)}</span>
                    <span>•</span>
                    <span>{formatDate(video.date)}</span>
                    {video.media?.fileName && (
                      <>
                        <span>•</span>
                        <span className="file-name">{video.media.fileName}</span>
                      </>
                    )}
                  </div>
                  <button
                    className="btn btn-primary video-download-btn"
                    onClick={() => handleDownload(video)}
                    disabled={downloadingIds.has(video.id)}
                  >
                    {downloadingIds.has(video.id) ? (
                      <>
                        <span className="loading"></span>
                        Starting...
                      </>
                    ) : (
                      'Download'
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default VideoList;