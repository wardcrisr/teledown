import React from 'react';
import './PhotoGrid.css';

function PhotoGrid({ photos, channelId, sessionId, onImageClick }) {
  const getGridClass = (count) => {
    if (count === 1) return 'grid-single';
    if (count === 2) return 'grid-two';
    if (count === 3) return 'grid-three';
    if (count === 4) return 'grid-four';
    if (count <= 6) return 'grid-six';
    if (count <= 9) return 'grid-nine';
    return 'grid-many';
  };

  return (
    <div className={`photo-grid ${getGridClass(photos.length)}`}>
      {photos.map((photo, index) => (
        <div 
          key={photo.id} 
          className="photo-grid-item"
          onClick={() => onImageClick({
            url: `/api/channels/${channelId}/photo/${photo.id}?session=${sessionId}`,
            caption: photo.text,
            messageId: photo.id,
            photos: photos,
            currentIndex: index
          })}
        >
          <img 
            src={`/api/channels/${channelId}/photo/${photo.id}?session=${sessionId}`}
            alt={`Photo ${index + 1}`}
            loading="lazy"
            onError={(e) => {
              // Replace broken image with placeholder
              e.target.style.display = 'none';
              if (!e.target.nextElementSibling || !e.target.nextElementSibling.classList.contains('photo-error')) {
                const placeholder = document.createElement('div');
                placeholder.className = 'photo-error';
                placeholder.innerHTML = '📷<br><small>Unable to load</small>';
                e.target.parentElement.appendChild(placeholder);
              }
            }}
          />
          {photos.length > 9 && index === 8 && (
            <div className="photo-overlay">+{photos.length - 9}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export default PhotoGrid;