import React, { useState, useEffect } from 'react';
import './ChannelList.css';

function ChannelList({ sessionId, onSelectChannel, selectedChannel }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    fetchChannels();
  }, [sessionId]);

  const fetchChannels = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/channels', {
        headers: {
          'x-session-id': sessionId
        }
      });

      if (response.ok) {
        const data = await response.json();
        setChannels(data.channels || []);
      } else {
        setError('Failed to load channels');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const filteredChannels = channels.filter(channel =>
    channel.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (channel.username && channel.username.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="channel-list">
      <div className="channel-list-header">
        <h3>Your Channels</h3>
        <button onClick={fetchChannels} className="btn-refresh" title="Refresh">
          ↻
        </button>
      </div>

      <div className="channel-search">
        <input
          type="text"
          className="input"
          placeholder="Search channels..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="channel-list-content">
        {loading && (
          <div className="channel-list-loading">
            <span className="loading"></span>
            <p>Loading channels...</p>
          </div>
        )}

        {error && (
          <div className="channel-list-error">
            <p>{error}</p>
            <button onClick={fetchChannels} className="btn btn-secondary">
              Retry
            </button>
          </div>
        )}

        {!loading && !error && filteredChannels.length === 0 && (
          <div className="channel-list-empty">
            <p>No channels found</p>
          </div>
        )}

        {!loading && !error && filteredChannels.map((channel) => (
          <div
            key={channel.id}
            className={`channel-item ${selectedChannel?.id === channel.id ? 'active' : ''}`}
            onClick={() => onSelectChannel(channel)}
          >
            <div className="channel-avatar">
              {channel.title[0].toUpperCase()}
            </div>
            <div className="channel-info">
              <h4>{channel.title}</h4>
              {channel.username && (
                <span className="channel-username">@{channel.username}</span>
              )}
              {channel.subscriberCount && (
                <span className="channel-subscribers">
                  {channel.subscriberCount.toLocaleString()} subscribers
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ChannelList;