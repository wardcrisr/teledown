import React, { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import PhotoGrid from './PhotoGrid';
import VideoGrid from './VideoGrid';
import VirtualList from './VirtualList';
import { SkeletonList } from './Skeletons';
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
  const [selectedVideo, setSelectedVideo] = useState(null);
  // processedMessages 改为 useMemo，避免额外一次 setState 触发的重渲染
  // const [processedMessages, setProcessedMessages] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const [playingVideoId, setPlayingVideoId] = useState(null);
  const [compactVideos, setCompactVideos] = useState(() => {
    const saved = localStorage.getItem('compactVideos');
    return saved === null ? true : saved === 'true';
  });
  const [shouldAutoScrollBottom, setShouldAutoScrollBottom] = useState(false);
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  const messageRefs = useRef({});
  // Refs mirroring state for use in async flows
  const messagesRef = useRef(messages);
  const hasMoreRef = useRef(hasMore);
  const hasNewerRef = useRef(hasNewer);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
  useEffect(() => { hasNewerRef.current = hasNewer; }, [hasNewer]);

  // Date picker state
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pickerMonth, setPickerMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [preselectDate, setPreselectDate] = useState(null);
  // 在按日期跳转的场景下，优先在该日期窗口内分页
  const dateWindowRef = useRef(null); // { startSec, endSec, cursorId }

  useEffect(() => {
    if (channel) {
      // reset and mark that we should auto scroll to newest after first load
      setShouldAutoScrollBottom(true);
      fetchMessages();
    }
  }, [channel]);

  // Process messages to group consecutive photos and videos (memoized)
  const processedMessages = useMemo(() => {
    const processed = [];
    let photoGroup = [];
    let videoGroup = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.mediaType === 'photo') {
        photoGroup.push(message);
        const nextMessage = messages[i + 1];
        const shouldEndGroup = !nextMessage || nextMessage.mediaType !== 'photo' || Math.abs(message.date - nextMessage.date) > 120;
        if (shouldEndGroup) {
          processed.push({ type: 'photoGroup', id: `group-${photoGroup[0].id}`, photos: photoGroup, date: photoGroup[0].date, caption: photoGroup.find(p => p.text)?.text || '' });
          photoGroup = [];
        }
      } else if (message.mediaType === 'video') {
        videoGroup.push(message);
        const nextMessage = messages[i + 1];
        const shouldEndVGroup = !nextMessage || nextMessage.mediaType !== 'video' || Math.abs(message.date - nextMessage.date) > 120;
        if (shouldEndVGroup) {
          processed.push({ type: 'videoGroup', id: `vgroup-${videoGroup[0].id}`, videos: videoGroup, date: videoGroup[0].date, caption: videoGroup.find(v => v.text)?.text || '' });
          videoGroup = [];
        }
      } else {
        if (photoGroup.length) {
          processed.push({ type: 'photoGroup', id: `group-${photoGroup[0].id}`, photos: photoGroup, date: photoGroup[0].date, caption: photoGroup.find(p => p.text)?.text || '' });
          photoGroup = [];
        }
        if (videoGroup.length) {
          processed.push({ type: 'videoGroup', id: `vgroup-${videoGroup[0].id}`, videos: videoGroup, date: videoGroup[0].date, caption: videoGroup.find(v => v.text)?.text || '' });
          videoGroup = [];
        }
        processed.push({ type: 'single', ...message });
      }
    }
    return processed;
  }, [messages]);

  const pendingRestoreRef = useRef(null);
  const fetchingOlderRef = useRef(false);
  const fetchMessages = async (offsetId = 0, loadNewer = false, preservePosition = false) => {
    if (offsetId === 0) {
      setLoading(true);
    } else if (loadNewer) {
      setLoadingNewer(true);
    } else {
      setLoadingMore(true);
    }
    setError('');

    try {
      // Save scroll position if we are going to prepend older messages
      let prevBottomGap = 0;
      if (!loadNewer && offsetId > 0 && preservePosition && containerRef.current) {
        const el = containerRef.current;
        prevBottomGap = el.scrollHeight - el.scrollTop; // distance from bottom
        pendingRestoreRef.current = { prevBottomGap };
      }
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
          // Always keep ascending (older -> newer)
          setMessages([...newMessages].sort((a, b) => a.id - b.id));
          // Don't auto-scroll on initial load
          setHasNewer(false); // Reset hasNewer on fresh load
        } else {
          // Append messages (merge and sort)
          setMessages(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const uniqueNewMessages = newMessages.filter(m => !existingIds.has(m.id));
            // Sort all messages by ID (descending - newest first)
            const allMessages = [...prev, ...uniqueNewMessages];
            const sorted = allMessages.sort((a, b) => a.id - b.id); // ascending
            return sorted;
          });

          // scroll 位置恢复在 useLayoutEffect 中统一处理，以减少闪烁
        }
        
        // Check if there are more messages to load
        if (loadNewer) {
          // 使用“新增的唯一条目数”判断是否还有更多，避免因边界重复导致过早置 false
          const prevIds = new Set(messagesRef.current.map(m => m.id));
          const uniqueCount = (newMessages || []).reduce((acc, m) => acc + (prevIds.has(m.id) ? 0 : 1), 0);
          setHasNewer(uniqueCount > 0);
        } else {
          const prevIds = new Set(messagesRef.current.map(m => m.id));
          const uniqueCount = (newMessages || []).reduce((acc, m) => acc + (prevIds.has(m.id) ? 0 : 1), 0);
          setHasMore(uniqueCount > 0);
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

  // 统一在 rAF 中节流 scroll 回调，避免频繁触发导致卡顿
  const rafIdRef = useRef(0);
  const handleScroll = () => {
    if (rafIdRef.current) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = 0;
      if (!containerRef.current || messages.length === 0) return;
      const container = containerRef.current;
      const { scrollTop } = container;
      if (scrollTop < 200 && !loadingMore && hasMore && !fetchingOlderRef.current) {
        const oldestMessage = messages.reduce((oldest, current) => (!oldest || current.id < oldest.id ? current : oldest), null);
        if (oldestMessage) {
          fetchingOlderRef.current = true;
          fetchMessages(oldestMessage.id, false, true).finally(() => {
            fetchingOlderRef.current = false;
          });
        }
      }
    });
  };

  // Also capture wheel up even when scrollTop不能继续减少（保持在0）
  const handleWheel = (e) => {
    if (!containerRef.current || messages.length === 0) return;
    const container = containerRef.current;
    const atTop = container.scrollTop <= 0;
    if (e.deltaY < 0 && atTop && !loadingMore && hasMore && !fetchingOlderRef.current) {
      const oldestMessage = messages.reduce((oldest, current) => (!oldest || current.id < oldest.id ? current : oldest), null);
      if (oldestMessage) {
        fetchingOlderRef.current = true;
        fetchMessages(oldestMessage.id, false, true).finally(() => {
          fetchingOlderRef.current = false;
        });
      }
    }
  };

  // 在 DOM 更新前恢复滚动，减少闪烁
  useLayoutEffect(() => {
    const pending = pendingRestoreRef.current;
    if (pending && containerRef.current) {
      const el = containerRef.current;
      const newScrollTop = el.scrollHeight - pending.prevBottomGap;
      el.scrollTop = newScrollTop;
      pendingRestoreRef.current = null;
    }
  }, [messages]);
  
  const handleLoadMore = () => {
    if (loadingMore || messages.length === 0) return;
    // Find the oldest message (smallest ID) to load older messages
    const oldestMessage = messages.reduce((oldest, current) =>
      !oldest || current.id < oldest.id ? current : oldest, null);
    if (oldestMessage) {
      console.log('Top button: loading earlier messages before ID:', oldestMessage.id);
      fetchMessages(oldestMessage.id, false, true); // load older and preserve position
    }
  };

  const handleLoadNewer = () => {
    if (loadingNewer || messages.length === 0) return;
    // Find the newest message (largest ID) to load newer messages
    const newestMessage = messages.reduce((newest, current) => 
      !newest || current.id > newest.id ? current : newest, null);
    
    if (newestMessage) {
      console.log('Load newer button: loading newer messages after ID:', newestMessage.id);
      // 若在“日期窗口”内，优先把当天剩余内容拉完
      const dw = dateWindowRef.current;
      if (dw && dw.startSec && dw.endSec) {
        setLoadingNewer(true);
        fetch(`/api/channels/${channel.id}/videosByDate?start=${dw.startSec}&end=${dw.endSec}&limit=80&minId=${dw.cursorId || 0}`,
          { headers: { 'x-session-id': sessionId } })
          .then(r => r.ok ? r.json() : Promise.reject(new Error('bad status')))
          .then(data => {
            const list = (data.videos || []).sort((a,b) => a.id - b.id);
            if (list.length) {
              setMessages(prev => {
                const ids = new Set(prev.map(m => m.id));
                return [...prev, ...list.filter(m => !ids.has(m.id))].sort((a,b) => a.id - b.id);
              });
              dateWindowRef.current = { ...dw, cursorId: data.nextCursorId || list[list.length - 1].id };
              setHasNewer(true);
            } else {
              // 当天没有更多了，清空日期窗口，接下来走 minId 方式加载“更晚”
              dateWindowRef.current = null;
            }
          })
          .catch(() => { dateWindowRef.current = null; })
          .finally(() => setLoadingNewer(false));
        return;
      }

      // Preserve distance to bottom to avoid visual jump when new items append
      if (containerRef.current) {
        const el = containerRef.current;
        pendingRestoreRef.current = { prevBottomGap: el.scrollHeight - el.scrollTop };
      }
      fetchMessages(newestMessage.id, true); // true indicates loading newer messages
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // After the first page for a channel loads, jump to bottom (newest)
  useEffect(() => {
    if (!loading && shouldAutoScrollBottom && messages.length > 0) {
      // wait next frame to ensure DOM rendered
      setTimeout(() => {
        scrollToBottom();
        setShouldAutoScrollBottom(false);
      }, 50);
    }
  }, [loading, shouldAutoScrollBottom, messages]);

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
          const sorted = (data.videos || []).sort((a, b) => a.id - b.id);
          setMessages(sorted);
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

  // Helpers for date operations and jumping
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

  const findFirstMessageIdForDate = (dateObj) => {
    const startSec = Math.floor(startOfDay(dateObj).getTime() / 1000);
    const endSec = Math.floor(endOfDay(dateObj).getTime() / 1000);
    const arr = messagesRef.current;
    let found = null;
    for (const m of arr) {
      if (m.date >= startSec && m.date < endSec) {
        if (!found || m.date < found.date) found = m;
      }
    }
    return found?.id || null;
  };

  const openDatePicker = (anchorDateSec) => {
    const init = anchorDateSec ? new Date(anchorDateSec * 1000) : new Date();
    setPickerMonth(new Date(init.getFullYear(), init.getMonth(), 1));
    setPreselectDate(init);
    setShowDatePicker(true);
  };

  const jumpToDate = async (dateObj) => {
    setShowDatePicker(false);
    const targetStart = Math.floor(startOfDay(dateObj).getTime() / 1000);
    const targetEnd = Math.floor(endOfDay(dateObj).getTime() / 1000);

    // A) 直接请求按日期的首批数据，尽量一次把当天列表呈现出来
    try {
      const respRange = await fetch(`/api/channels/${channel.id}/videosByDate?start=${targetStart}&end=${targetEnd}&limit=60`, {
        headers: { 'x-session-id': sessionId }
      });
      if (respRange.ok) {
        const data = await respRange.json();
        const arr = (data.videos || []).sort((a,b) => a.id - b.id);
        if (arr.length) {
          setMessages(arr);
          setHasNewer(true);
          dateWindowRef.current = {
            startSec: targetStart,
            endSec: targetEnd,
            cursorId: data.nextCursorId || arr[arr.length - 1].id
          };
          // 居中到当天首条附近
          setTimeout(() => {
            const firstId = arr[0]?.id;
            if (firstId && messageRefs.current[firstId]) {
              messageRefs.current[firstId].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }, 50);
          return;
        }
      }
    } catch (e) {
      console.warn('videosByDate failed, fallback to id search', e);
    }

    // B) 退化：若按日期接口不可用，则用 old flow
    let targetId = findFirstMessageIdForDate(dateObj);
    if (targetId) return jumpToMessage(targetId);

    try {
      const resp = await fetch(`/api/channels/${channel.id}/firstByDate?start=${targetStart}&end=${targetEnd}`, {
        headers: { 'x-session-id': sessionId }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.messageId) return jumpToMessage(data.messageId);
      }
    } catch (e) {}

    // C) 最后回退：分页查找直到命中
    let guard = 0;
    const maxPages = 100;
    const hasDateInLoaded = () => !!findFirstMessageIdForDate(dateObj);
    const getOldest = () => {
      let min = null; for (const m of messagesRef.current) { if (!min || m.id < min.id) min = m; } return min;
    };
    const getNewest = () => {
      let max = null; for (const m of messagesRef.current) { if (!max || m.id > max.id) max = m; } return max;
    };
    const oldest = getOldest();
    const newest = getNewest();
    if (!oldest || !newest) return;
    if (targetEnd <= oldest.date && hasMoreRef.current) {
      while (!hasDateInLoaded() && hasMoreRef.current && guard < maxPages) {
        guard += 1; const o = getOldest(); if (!o) break; await fetchMessages(o.id, false, true);
      }
    } else if (targetStart >= newest.date && hasNewerRef.current) {
      while (!hasDateInLoaded() && hasNewerRef.current && guard < maxPages) {
        guard += 1; const n = getNewest(); if (!n) break; await fetchMessages(n.id, true);
      }
    }
    targetId = findFirstMessageIdForDate(dateObj);
    if (targetId) return jumpToMessage(targetId);
    alert('No messages on the selected date.');
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const formatDuration = (seconds) => {
    const total = Math.floor(Number(seconds) || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h.toString().padStart(2, '0')}:${m
      .toString()
      .padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const renderMessage = (item, index) => {
    // Handle photo groups
    if (item.type === 'photoGroup') {
      const firstId = item.photos[0]?.id;
      return (
        <div key={item.id} className="message-wrapper" ref={el => { if (firstId) messageRefs.current[firstId] = el; }}>
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

    // Handle video groups
    if (item.type === 'videoGroup') {
      const firstId = item.videos[0]?.id;
      return (
        <div key={item.id} className="message-wrapper" ref={el => { if (firstId) messageRefs.current[firstId] = el; }}>
          <div className="message">
            <VideoGrid 
              videos={item.videos}
              channelId={channel.id}
              sessionId={sessionId}
              onPlay={(index) => {
                setSelectedVideo({
                  videos: item.videos,
                  currentIndex: index
                });
              }}
              onDownload={(video) => handleDirectDownload(video)}
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
    const prevItem = index > 0 ? processedMessages[index - 1] : null;
    const prevMessage = prevItem && prevItem.date ? prevItem : null;
    const showDate = !prevMessage || 
      formatDate(message.date) !== formatDate(prevMessage.date);

    return (
      <React.Fragment key={message.id}>
        {showDate && (
          <div className="message-date-divider" onClick={() => openDatePicker(message.date)}>
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
                {/* Preview card or inline player */}
                {playingVideoId === message.id ? (
                  <div className="video-player">
                    <video
                      controls
                      autoPlay
                      playsInline
                      poster={`/api/channels/${channel.id}/video-thumb/${message.id}?session=${sessionId}`}
                      src={`/api/channels/${channel.id}/video/${message.id}?session=${sessionId}`}
                      onPause={(e) => {
                        // keep state
                      }}
                      onEnded={() => setPlayingVideoId(null)}
                    />
                  </div>
                ) : (
                  <div
                    className="video-thumb"
                    role="button"
                    onClick={() => setPlayingVideoId(message.id)}
                  >
                    <img
                      src={`/api/channels/${channel.id}/video-thumb/${message.id}?session=${sessionId}`}
                      alt="Video preview"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                    <button className="play-button" aria-label="Play preview">▶</button>
                    <div className="video-badges">
                      {message.media?.duration && (
                        <span className="badge duration-badge">{formatDuration(message.media.duration)}</span>
                      )}
                      {message.media?.size && (
                        <span className="badge size-badge">{formatSize(message.media.size)}</span>
                      )}
                    </div>
                    <div className="video-title-overlay" title={message.title || message.media?.fileName || 'Video'}>
                      {message.title || message.media?.fileName || 'Video'}
                    </div>
                    <div className="video-actions">
                      <button
                        className="btn-download-single"
                        onClick={(e) => { e.stopPropagation(); handleDownload(message, false); }}
                        disabled={downloadingIds.has(message.id)}
                        title="仅下载该视频"
                      >
                        {downloadingIds.has(message.id) ? '⏳' : '⬇️'}
                      </button>
                      <button
                        className="btn-download-batch"
                        onClick={(e) => { e.stopPropagation(); handleDownload(message, true); }}
                        disabled={downloadingIds.has(message.id)}
                        title="批量下载相关视频"
                      >
                        {downloadingIds.has(message.id) ? '⏳' : '📦'}
                      </button>
                      <button
                        className="btn-download-local"
                        onClick={(e) => { e.stopPropagation(); handleDirectDownload(message); }}
                        title="保存到本机"
                      >
                        💾
                      </button>
                    </div>
                  </div>
                )}
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
        <div className="messages-container" style={{ width: '100%' }}>
          <SkeletonList count={6} variant="mixed" />
        </div>
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
        <button
          className="search-toggle-btn"
          onClick={() => {
            const next = !compactVideos;
            setCompactVideos(next);
            localStorage.setItem('compactVideos', String(next));
          }}
          title={compactVideos ? '切换到大图' : '切换到缩略图'}
        >
          {compactVideos ? '🗂️' : '🖼️'}
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
        className={`message-list ${compactVideos ? 'compact-videos' : ''}`} 
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        {loadingMore && (
          <div className="top-skeleton-overlay">
            <SkeletonList count={2} variant="text" compact />
          </div>
        )}
        
        <div className="messages-container">
          {messages.length === 0 ? (
            <div className="no-messages">
              <p>No messages in this channel</p>
            </div>
          ) : (
            <VirtualList
              containerRef={containerRef}
              items={processedMessages}
              estimateItemHeight={220}
              overscan={6}
              keyExtractor={(item) => item.id}
              renderItem={({ item, index }) => renderMessage(item, index)}
            />
          )}
          <div ref={messagesEndRef} />
        </div>
        
        {!loading && (
          <div className="load-more-container">
            {loadingNewer ? (
              <div className="loading-more">
                <span>Loading later messages...</span>
              </div>
            ) : (
              hasNewer && (
                <button className="load-more-button" onClick={handleLoadNewer}>
                  Load Later Messages
                </button>
              )
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

      {/* Video Modal with navigation */}
      {selectedVideo && (
        <div className="image-modal" onClick={() => setSelectedVideo(null)}>
          <div className="image-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedVideo(null)}>×</button>

            {selectedVideo.videos && selectedVideo.videos.length > 1 && (
              <>
                <button
                  className="modal-nav modal-prev"
                  onClick={() => {
                    const prevIndex = selectedVideo.currentIndex > 0
                      ? selectedVideo.currentIndex - 1
                      : selectedVideo.videos.length - 1;
                    setSelectedVideo({
                      ...selectedVideo,
                      currentIndex: prevIndex
                    });
                  }}
                >
                  ‹
                </button>
                <button
                  className="modal-nav modal-next"
                  onClick={() => {
                    const nextIndex = (selectedVideo.currentIndex + 1) % selectedVideo.videos.length;
                    setSelectedVideo({
                      ...selectedVideo,
                      currentIndex: nextIndex
                    });
                  }}
                >
                  ›
                </button>
                <div className="modal-counter">
                  {selectedVideo.currentIndex + 1} / {selectedVideo.videos.length}
                </div>
              </>
            )}

            {/* Actual video */}
            <video
              key={selectedVideo.videos[selectedVideo.currentIndex].id}
              controls
              autoPlay
              playsInline
              style={{ maxWidth: '100%', maxHeight: '85vh', borderRadius: 4 }}
              poster={`/api/channels/${channel.id}/video-thumb/${selectedVideo.videos[selectedVideo.currentIndex].id}?session=${sessionId}`}
            >
              <source src={`/api/channels/${channel.id}/video/${selectedVideo.videos[selectedVideo.currentIndex].id}?session=${sessionId}`} />
            </video>
            {selectedVideo.videos[selectedVideo.currentIndex].text && (
              <div className="modal-caption">
                {selectedVideo.videos[selectedVideo.currentIndex].text}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Date Picker Modal */}
      {showDatePicker && (
        <div className="date-picker-overlay" onClick={() => setShowDatePicker(false)}>
          <div className="date-picker" onClick={(e) => e.stopPropagation()}>
            <div className="date-picker-header">
              <div className="month-label">
                {pickerMonth.getFullYear()}年{pickerMonth.getMonth() + 1}月
              </div>
              <div className="month-arrows">
                <button
                  className="arrow-btn up"
                  title="上个月"
                  onClick={() => setPickerMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))}
                >
                  ∧
                </button>
                <button
                  className="arrow-btn down"
                  title="下个月"
                  onClick={() => setPickerMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))}
                >
                  ∨
                </button>
              </div>
            </div>
            <div className="date-picker-grid">
              {['周一','周二','周三','周四','周五','周六','周日'].map(d => (
                <div key={d} className="dow">{d}</div>
              ))}
              {(() => {
                const firstDay = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth(), 1);
                let weekday = firstDay.getDay(); // 0=Sunday
                weekday = (weekday + 6) % 7; // Monday-first
                const daysInMonth = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth() + 1, 0).getDate();
                const prevMonthDays = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth(), 0).getDate();
                const cells = [];
                // Leading days
                for (let i = weekday - 1; i >= 0; i--) {
                  const dayNum = prevMonthDays - i;
                  const d = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth() - 1, dayNum);
                  cells.push(
                    <button key={`p-${dayNum}`} className="day other-month" onClick={() => jumpToDate(d)}>{dayNum}</button>
                  );
                }
                // Current month
                const today = new Date();
                const isSameDay = (a,b) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
                for (let i = 1; i <= daysInMonth; i++) {
                  const d = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth(), i);
                  const classes = ['day'];
                  if (isSameDay(d, today)) classes.push('today');
                  if (preselectDate && isSameDay(d, preselectDate)) classes.push('selected');
                  cells.push(
                    <button key={`c-${i}`} className={classes.join(' ')} onClick={() => jumpToDate(d)}>{i}</button>
                  );
                }
                // Trailing to 6 rows
                const totalSoFar = cells.length;
                const remain = 42 - totalSoFar;
                for (let i = 1; i <= remain; i++) {
                  const d = new Date(pickerMonth.getFullYear(), pickerMonth.getMonth() + 1, i);
                  cells.push(
                    <button key={`n-${i}`} className="day other-month" onClick={() => jumpToDate(d)}>{i}</button>
                  );
                }
                return cells;
              })()}
            </div>
            <div className="date-picker-footer">
              <button className="close-btn" onClick={() => setShowDatePicker(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default MessageList;
