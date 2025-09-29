import React, { useState, useEffect, useRef, useMemo } from 'react';
import PhotoGrid from './PhotoGrid';
import './MessageList.css';

function MessageList({ sessionId, channel, onDownload }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [downloadingIds, setDownloadingIds] = useState(new Set());
  const [hasMore, setHasMore] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [processedMessages, setProcessedMessages] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  const messageRefs = useRef({});

  useEffect(() => {
    if (channel) {
      fetchMessages();
    }
  }, [channel]);

  // Process messages to group consecutive photos
  useEffect(() => {
    const processed = [];
    let photoGroup = [];
    
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      
      if (message.mediaType === 'photo') {
        photoGroup.push(message);
        
        // Check if next message is also a photo and within 2 minutes
        const nextMessage = messages[i + 1];
        const shouldEndGroup = !nextMessage || 
                              nextMessage.mediaType !== 'photo' || 
                              Math.abs(message.date - nextMessage.date) > 120;
        
        if (shouldEndGroup) {
          // End current group
          processed.push({
            type: 'photoGroup',
            id: `group-${photoGroup[0].id}`,
            photos: photoGroup,
            date: photoGroup[0].date,
            caption: photoGroup.find(p => p.text)?.text || ''
          });
          photoGroup = [];
        }
      } else {
        // Add non-photo message
        processed.push({
          type: 'single',
          ...message
        });
      }
    }
    
    setProcessedMessages(processed);
  }, [messages]);

  const fetchMessages = async (offsetId = 0, loadNewer = false) => {
    if (offsetId === 0) {
      setLoading(true);
    } else if (loadNewer) {
      setLoadingNewer(true);
    } else {
      setLoadingMore(true);
    }
    setError('');

    try {
      let url;
      if (loadNewer && offsetId > 0) {
        // Load newer messages (messages with ID > offsetId)
        url = `/api/channels/${channel.id}/videos?minId=${offsetId}&limit=20`;
      } else if (offsetId > 0) {
        // Load older messages (messages with ID < offsetId)
        url = `/api/channels/${channel.id}/videos?offsetId=${offsetId}&limit=20`;
      } else {
        // Initial load
        url = `/api/channels/${channel.id}/videos?limit=20`;
      }
      
      const response = await fetch(url, {
        headers: {
          'x-session-id': sessionId
        }
      });

      if (response.ok) {
        const data = await response.json();
        const newMessages = data.videos || [];
        
        if (offsetId === 0) {
          setMessages(newMessages);
          // Don't auto-scroll on initial load
          setHasNewer(false); // Reset hasNewer on fresh load
        } else {
          // Append messages (merge and sort)
          setMessages(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const uniqueNewMessages = newMessages.filter(m => !existingIds.has(m.id));
            // Sort all messages by ID (descending - newest first)
            const allMessages = [...prev, ...uniqueNewMessages];
            return allMessages.sort((a, b) => b.id - a.id);
          });
        }
        
        // Check if there are more messages to load
        if (loadNewer) {
          setHasNewer(newMessages.length >= 20);
        } else {
          setHasMore(newMessages.length >= 20);
        }
      } else {
        setError('Failed to load messages');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setLoadingNewer(false);
    }
  };

  const handleScroll = () => {
    if (!containerRef.current || loadingMore || !hasMore || messages.length === 0) return;
    
    const container = containerRef.current;
    const scrollHeight = container.scrollHeight;
    const scrollTop = container.scrollTop;
    const clientHeight = container.clientHeight;
    
    // Check if scrolled near bottom (for loading older messages)
    // In Telegram, older messages are loaded when scrolling down
    if (scrollHeight - scrollTop - clientHeight < 200) {
      // Find the oldest message (smallest ID)
      const oldestMessage = messages.reduce((oldest, current) => 
        !oldest || current.id < oldest.id ? current : oldest, null);
      
      if (oldestMessage && !loadingMore) {
        console.log('Loading more messages from ID:', oldestMessage.id);
        fetchMessages(oldestMessage.id);
      }
    }
  };
  
  const handleLoadMore = () => {
    if (loadingMore || messages.length === 0) return;
    // Find the oldest message (smallest ID) to load older messages
    const oldestMessage = messages.reduce((oldest, current) => 
      !oldest || current.id < oldest.id ? current : oldest, null);
    
    if (oldestMessage) {
      console.log('Load more button: loading older messages before ID:', oldestMessage.id);
      fetchMessages(oldestMessage.id, false); // false indicates loading older messages
    }
  };

  const handleLoadNewer = () => {
    if (loadingNewer || messages.length === 0) return;
    // Find the newest message (largest ID) to load newer messages
    const newestMessage = messages.reduce((newest, current) => 
      !newest || current.id > newest.id ? current : newest, null);
    
    if (newestMessage) {
      console.log('Load newer button: loading newer messages after ID:', newestMessage.id);
      fetchMessages(newestMessage.id, true); // true indicates loading newer messages
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Search messages
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    
    setSearchLoading(true);
    try {
      const response = await fetch(
        `/api/channels/${channel.id}/search?query=${encodeURIComponent(searchQuery)}`,
        {
          headers: {
            'x-session-id': sessionId
          }
        }
      );
      
      if (response.ok) {
        const data = await response.json();
        setSearchResults(data.results || []);
        if (data.results && data.results.length > 0) {
          setCurrentSearchIndex(0);
          jumpToMessage(data.results[0].id);
        }
      }
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setSearchLoading(false);
    }
  };

  // Jump to a specific message
  const jumpToMessage = async (messageId) => {
    // First check if message is already loaded
    const existingMessage = messages.find(m => m.id === messageId);
    
    if (existingMessage) {
      // Message is already loaded, just scroll to it
      setHighlightedMessageId(messageId);
      setTimeout(() => {
        if (messageRefs.current[messageId]) {
          messageRefs.current[messageId].scrollIntoView({ 
            behavior: 'smooth', 
            block: 'center' 
          });
        }
      }, 100);
    } else {
      // Need to load messages around this message ID
      setLoading(true);
      try {
        const response = await fetch(
          `/api/channels/${channel.id}/messages-around/${messageId}?limit=20`,
          {
            headers: {
              'x-session-id': sessionId
            }
          }
        );
        
        if (response.ok) {
          const data = await response.json();
          setMessages(data.videos || []);
          setHighlightedMessageId(messageId);
          setHasNewer(true); // Assume there might be newer messages when jumping to a specific message
          
          setTimeout(() => {
            if (messageRefs.current[messageId]) {
              messageRefs.current[messageId].scrollIntoView({ 
                behavior: 'smooth', 
                block: 'center' 
              });
            }
          }, 100);
        }
      } catch (err) {
        console.error('Error loading message context:', err);
      } finally {
        setLoading(false);
      }
    }
  };

  // Navigate through search results
  const navigateSearchResults = (direction) => {
    if (!searchResults.length) return;
    
    let newIndex = currentSearchIndex;
    if (direction === 'next') {
      newIndex = (currentSearchIndex + 1) % searchResults.length;
    } else {
      newIndex = currentSearchIndex === 0 ? searchResults.length - 1 : currentSearchIndex - 1;
    }
    
    setCurrentSearchIndex(newIndex);
    jumpToMessage(searchResults[newIndex].id);
  };

  const handleDownload = async (message, isBatchMode = true) => {
    if (message.mediaType !== 'video') return;

    // If batch mode is enabled (default), ask backend to find related videos
    if (isBatchMode) {
      try {
        // First, ask backend to find related videos
        const findResponse = await fetch('/api/download/find-related', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-session-id': sessionId
          },
          body: JSON.stringify({
            channelId: channel.id,
            videoId: message.id
          })
        });

        if (!findResponse.ok) {
          const errorText = await findResponse.text();
          throw new Error(`Failed to find related videos: ${errorText}`);
        }

        const relatedData = await findResponse.json();
        const { folderName, videos, textMessage, totalVideos } = relatedData;

        if (videos.length === 0) {
          // No videos found, fall back to single download
          return handleDownload(message, false);
        }

        // Show detailed confirmation dialog with the original text message
        let confirmMessage = `Found ${totalVideos} video(s) in this group.\n\n`;
        confirmMessage += `Based on text message: "${textMessage.substring(0, 150)}${textMessage.length > 150 ? '...' : ''}"\n\n`;
        confirmMessage += `Folder: "${folderName.substring(0, 100)}${folderName.length > 100 ? '...' : ''}"\n\n`;
        
        if (videos.length > 5) {
          // Show first 5 videos if there are many
          confirmMessage += 'Videos to download:\n';
          videos.slice(0, 5).forEach(v => {
            confirmMessage += `  • ${v.title || `Video ${v.id}`}\n`;
          });
          confirmMessage += `  ... and ${videos.length - 5} more\n\n`;
        } else {
          confirmMessage += 'Videos to download:\n';
          videos.forEach(v => {
            confirmMessage += `  • ${v.title || `Video ${v.id}`}\n`;
          });
          confirmMessage += '\n';
        }
        
        confirmMessage += 'Do you want to download all these videos to this folder?';

        const confirmed = window.confirm(confirmMessage);
        if (!confirmed) return;

        // Mark all videos as downloading
        const videoIds = videos.map(v => v.id);
        setDownloadingIds(prev => new Set([...prev, ...videoIds]));

        // Start batch download
        const response = await fetch('/api/download/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-session-id': sessionId
          },
          body: JSON.stringify({
            channelId: channel.id,
            folderName: folderName,
            videos: videos
          })
        });

        if (response.ok) {
          const data = await response.json();
          console.log('Batch download started:', data);
          
          // Create download items for each video
          videos.forEach((video, index) => {
            const downloadId = data.downloadIds[index];
            if (downloadId) {
              onDownload({ 
                downloadId: downloadId,
                title: video.title || video.filename || `Video ${video.id}`,
                video: video,
                channel: channel,
                progress: 0,
                status: 'starting',
                folderName: data.folderName
              });
            }
          });
        } else {
          console.error('Failed to start batch download');
          alert('Failed to start batch download. Please try again.');
        }
      } catch (err) {
        console.error('Batch download error:', err);
        alert('Error finding related videos. Falling back to single download.');
        // Fall back to single download
        return handleDownload(message, false);
      } finally {
        // Clean up downloading state in case of error
        setDownloadingIds(prev => {
          const newSet = new Set(prev);
          if (prev.has(message.id)) {
            newSet.delete(message.id);
          }
          return newSet;
        });
      }
    } else {
      // Single download mode (old behavior)
      if (downloadingIds.has(message.id)) return;
      
      setDownloadingIds(prev => new Set([...prev, message.id]));

      try {
        const response = await fetch('/api/download/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-session-id': sessionId
          },
          body: JSON.stringify({
            videoId: message.id,
            channelId: channel.id,
            title: message.title || message.media?.fileName || `Video_${message.id}`
          })
        });

        if (response.ok) {
          const data = await response.json();
          onDownload({ ...message, downloadId: data.downloadId });
        } else {
          console.error('Failed to start download');
        }
      } catch (err) {
        console.error('Download error:', err);
      } finally {
        setDownloadingIds(prev => {
          const newSet = new Set(prev);
          newSet.delete(message.id);
          return newSet;
        });
      }
    }
  };

  // Direct download to user's computer (stream from server)
  // Use native browser download manager (shows progress when server sends Content-Length)
  const handleDirectDownload = (message) => {
    if (message.mediaType !== 'video') return;
    const url = `/api/download/stream/${channel.id}/${message.id}?session=${encodeURIComponent(sessionId)}`;
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    // Hint filename; server also sets Content-Disposition
    const defaultName = message.media?.fileName || `${message.title || 'video'}_${message.id}.mp4`;
    a.setAttribute('download', defaultName);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  };

  const formatDate = (timestamp) => {
    const date = new Date(timestamp * 1000);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
      });
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const renderMessage = (item, index) => {
    // Handle photo groups
    if (item.type === 'photoGroup') {
      return (
        <div key={item.id} className="message-wrapper">
          <div className="message">
            <PhotoGrid 
              photos={item.photos}
              channelId={channel.id}
              sessionId={sessionId}
              onImageClick={setSelectedImage}
            />
            {item.caption && <p className="message-caption">{item.caption}</p>}
            <div className="message-footer">
              <span className="message-time">{formatTime(item.date)}</span>
            </div>
          </div>
        </div>
      );
    }
    
    // Regular message handling
    const message = item;
    const prevMessage = index > 0 ? messages[index - 1] : null;
    const showDate = !prevMessage || 
      formatDate(message.date) !== formatDate(prevMessage.date);

    return (
      <React.Fragment key={message.id}>
        {showDate && (
          <div className="message-date-divider">
            <span>{formatDate(message.date)}</span>
          </div>
        )}
        <div 
          className={`message-item ${message.mediaType} ${highlightedMessageId === message.id ? 'highlighted' : ''}`}
          ref={el => messageRefs.current[message.id] = el}>
          <div className="message-content">
            {message.mediaType === 'text' && (
              <div className="text-message">
                <p>{message.text || message.title}</p>
              </div>
            )}
            
            {/* Photo messages are handled in groups now */}
            
            {message.mediaType === 'video' && (
              <div className="video-message">
                <div className="video-preview">
                  <span className="media-icon">🎬</span>
                  <div className="video-info">
                    <span className="video-title">{message.title || message.media?.fileName || 'Video'}</span>
                    <div className="video-meta">
                      {message.media?.duration && (
                        <span className="duration">{formatDuration(message.media.duration)}</span>
                      )}
                      {message.media?.size && (
                        <span className="size">{formatSize(message.media.size)}</span>
                      )}
                    </div>
                  </div>
                  <div className="download-buttons">
                    <button
                      className="btn-download-single"
                      onClick={() => handleDownload(message, false)}
                      disabled={downloadingIds.has(message.id)}
                      title="Download this video only"
                    >
                      {downloadingIds.has(message.id) ? '⏳' : '⬇️'}
                    </button>
                    <button
                      className="btn-download-batch"
                      onClick={() => handleDownload(message, true)}
                      disabled={downloadingIds.has(message.id)}
                      title="Download all related videos"
                    >
                      {downloadingIds.has(message.id) ? '⏳' : '📦'}
                    </button>
                    <button
                      className="btn-download-local"
                      onClick={() => handleDirectDownload(message)}
                      title="Save to this device (no server storage)"
                    >
                      💾
                    </button>
                  </div>
                </div>
                {message.text && <p className="message-caption">{message.text}</p>}
              </div>
            )}
            
            {message.mediaType === 'audio' && (
              <div className="audio-message">
                <div className="audio-preview">
                  <span className="media-icon">🎵</span>
                  <div className="audio-info">
                    <span className="audio-title">{message.media?.fileName || 'Audio'}</span>
                    {message.media?.duration && (
                      <span className="duration">{formatDuration(message.media.duration)}</span>
                    )}
                  </div>
                </div>
                {message.text && <p className="message-caption">{message.text}</p>}
              </div>
            )}
            
            {message.mediaType === 'document' && (
              <div className="document-message">
                <div className="document-preview">
                  <span className="media-icon">📄</span>
                  <span className="document-name">{message.media?.fileName || 'Document'}</span>
                </div>
                {message.text && <p className="message-caption">{message.text}</p>}
              </div>
            )}
            
            <div className="message-footer">
              <span className="message-time">{formatTime(message.date)}</span>
              {message.views > 0 && (
                <span className="message-views">👁 {message.views.toLocaleString()}</span>
              )}
            </div>
          </div>
        </div>
      </React.Fragment>
    );
  };

  if (loading && messages.length === 0) {
    return (
      <div className="message-list loading">
        <div className="loading-spinner">Loading messages...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="message-list error">
        <div className="error-message">{error}</div>
      </div>
    );
  }

  return (
    <>
      {/* Search Bar */}
      <div className="search-bar-container">
        <button 
          className="search-toggle-btn"
          onClick={() => setShowSearch(!showSearch)}
          title="Search messages"
        >
          🔍
        </button>
        
        {showSearch && (
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              className="search-input"
            />
            <button 
              onClick={handleSearch}
              disabled={searchLoading || !searchQuery.trim()}
              className="search-button"
            >
              {searchLoading ? '⏳' : 'Search'}
            </button>
            
            {searchResults.length > 0 && (
              <div className="search-results-nav">
                <span className="search-results-count">
                  {currentSearchIndex + 1} / {searchResults.length}
                </span>
                <button 
                  onClick={() => navigateSearchResults('prev')}
                  className="search-nav-btn"
                  title="Previous result"
                >
                  ↑
                </button>
                <button 
                  onClick={() => navigateSearchResults('next')}
                  className="search-nav-btn"
                  title="Next result"
                >
                  ↓
                </button>
                <button 
                  onClick={() => {
                    setSearchResults([]);
                    setSearchQuery('');
                    setHighlightedMessageId(null);
                  }}
                  className="search-clear-btn"
                  title="Clear search"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      
      <div 
        className="message-list" 
        ref={containerRef}
        onScroll={handleScroll}
      >
        {/* Load Later Messages at top */}
        {!loading && hasNewer && (
          <div className="load-newer-container">
            {loadingNewer ? (
              <div className="loading-newer">
                <span>Loading newer messages...</span>
              </div>
            ) : (
              <button className="load-newer-button" onClick={handleLoadNewer}>
                Load Later Messages
              </button>
            )}
          </div>
        )}
        
        <div className="messages-container">
          {messages.length === 0 ? (
            <div className="no-messages">
              <p>No messages in this channel</p>
            </div>
          ) : (
            processedMessages.map((item, index) => renderMessage(item, index))
          )}
          <div ref={messagesEndRef} />
        </div>
        
        {!loading && (
          <div className="load-more-container">
            {loadingMore ? (
              <div className="loading-more">
                <span>Loading older messages...</span>
              </div>
            ) : (
              <button className="load-more-button" onClick={handleLoadMore}>
                Load More Messages
              </button>
            )}
          </div>
        )}
      </div>
      
      {/* Image Modal with navigation */}
      {selectedImage && (
        <div className="image-modal" onClick={() => setSelectedImage(null)}>
          <div className="image-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedImage(null)}>×</button>
            
            {selectedImage.photos && selectedImage.photos.length > 1 && (
              <>
                <button 
                  className="modal-nav modal-prev" 
                  onClick={() => {
                    const prevIndex = selectedImage.currentIndex > 0 
                      ? selectedImage.currentIndex - 1 
                      : selectedImage.photos.length - 1;
                    setSelectedImage({
                      ...selectedImage,
                      currentIndex: prevIndex,
                      url: `/api/channels/${channel.id}/photo/${selectedImage.photos[prevIndex].id}?session=${sessionId}`,
                      caption: selectedImage.photos[prevIndex].text
                    });
                  }}
                >
                  ‹
                </button>
                <button 
                  className="modal-nav modal-next" 
                  onClick={() => {
                    const nextIndex = (selectedImage.currentIndex + 1) % selectedImage.photos.length;
                    setSelectedImage({
                      ...selectedImage,
                      currentIndex: nextIndex,
                      url: `/api/channels/${channel.id}/photo/${selectedImage.photos[nextIndex].id}?session=${sessionId}`,
                      caption: selectedImage.photos[nextIndex].text
                    });
                  }}
                >
                  ›
                </button>
                <div className="modal-counter">
                  {selectedImage.currentIndex + 1} / {selectedImage.photos.length}
                </div>
              </>
            )}
            
            <img src={selectedImage.url} alt="Full size" />
            {selectedImage.caption && (
              <div className="modal-caption">{selectedImage.caption}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default MessageList;
