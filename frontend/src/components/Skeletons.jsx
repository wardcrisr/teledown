import React from 'react';
import './Skeletons.css';

export function MessageSkeleton({ variant = 'video', compact = false }) {
  return (
    <div className={`skeleton-card ${compact ? 'compact' : ''}`}>
      <div className="skeleton-line w-40" />
      {variant === 'video' && (
        <div className="skeleton-rect video" />
      )}
      <div className="skeleton-line w-90" />
      <div className="skeleton-line w-70" />
    </div>
  );
}

export function SkeletonList({ count = 6, variant = 'mixed', compact = false }) {
  const pick = (i) => (variant === 'mixed' ? (i % 2 ? 'video' : 'text') : variant);
  return (
    <div className="skeleton-list">
      {Array.from({ length: count }).map((_, i) => (
        <MessageSkeleton key={i} variant={pick(i)} compact={compact} />
      ))}
    </div>
  );
}

