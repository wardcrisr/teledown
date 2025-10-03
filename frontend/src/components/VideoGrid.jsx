import React from 'react';
import './VideoGrid.css';

function VideoGrid({ videos, channelId, sessionId, onPlay, onDownload }) {
  const getGridClass = (count) => {
    if (count === 1) return 'vgrid-single';
    if (count === 2) return 'vgrid-two';
    if (count === 3) return 'vgrid-three';
    if (count === 4) return 'vgrid-four';
    if (count <= 6) return 'vgrid-six';
    if (count <= 9) return 'vgrid-nine';
    return 'vgrid-many';
  };

  return (
    <div className={`video-grid ${getGridClass(videos.length)}`}>
      {videos.map((video, index) => (
        <div 
          key={video.id}
          className="video-grid-item"
          role="button"
          onClick={() => onPlay(index)}
        >
          {/* Download to local (top-left) */}
          {onDownload && (
            <button
              className="v-download"
              title="下载到本机"
              onClick={(e) => { e.stopPropagation(); onDownload(video); }}
            >
              ⬇
            </button>
          )}
          <img
            src={`/api/channels/${channelId}/video-thumb/${video.id}?session=${sessionId}`}
            alt={`Video ${index + 1}`}
            loading="lazy"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
          <div className="v-overlay">
            <span className="v-play">▶</span>
            {video.media?.duration && (
              <span className="v-badge v-duration">{formatDuration(video.media.duration)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDuration(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h.toString().padStart(2, '0')}:${m
    .toString()
    .padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default VideoGrid;
