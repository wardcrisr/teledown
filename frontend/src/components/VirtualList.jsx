import React, { useEffect, useMemo, useRef, useState } from 'react';
import './VirtualList.css';

function sumAdjustBefore(index, measuredMap, measuredIndices, estimate) {
  let adj = 0;
  const arr = measuredIndices.current;
  for (let i = 0; i < arr.length && arr[i] < index; i++) {
    const idx = arr[i];
    const h = measuredMap.current.get(idx);
    if (typeof h === 'number') adj += h - estimate;
  }
  return adj;
}

export default function VirtualList({
  containerRef,
  items,
  estimateItemHeight = 180,
  overscan = 8,
  keyExtractor,
  renderItem,
}) {
  const count = items.length;
  const measuredMap = useRef(new Map()); // index -> height
  const measuredIndices = useRef([]); // sorted indices with measurements
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 20) });
  const rafId = useRef(0);

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  // recompute visible range based on scrollTop and viewport height
  const recomputeRange = () => {
    const el = containerRef.current;
    if (!el) return;
    const { scrollTop, clientHeight } = el;
    const approxStart = clamp(Math.floor(scrollTop / estimateItemHeight) - overscan, 0, count);
    let approxEnd = clamp(
      Math.ceil((scrollTop + clientHeight) / estimateItemHeight) + overscan,
      0,
      count
    );
    // Guard against empty range due to rounding when list updates
    if (approxEnd <= approxStart && count > 0) {
      approxEnd = Math.min(approxStart + 1, count);
    }
    if (approxStart !== range.start || approxEnd !== range.end) {
      setRange({ start: approxStart, end: approxEnd });
    }
  };

  useEffect(() => {
    recomputeRange();
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (rafId.current) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0;
        recomputeRange();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const onResize = () => recomputeRange();
    window.addEventListener('resize', onResize);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, count, estimateItemHeight, overscan]);

  useEffect(() => {
    // when items length changes, ensure range is valid and non-empty
    setRange((r) => {
      const start = Math.min(r.start, Math.max(count - 1, 0));
      const end = Math.max(Math.min(r.end, count), Math.min(start + 1, count));
      return { start, end };
    });
  }, [count]);

  // Reset measurements when dataset identity changes significantly
  const identity = useMemo(() => {
    if (!Array.isArray(items) || items.length === 0) return '0:0:0';
    const first = items[0]?.id ?? 'f0';
    const last = items[items.length - 1]?.id ?? 'l0';
    return `${first}:${last}:${items.length}`;
  }, [items]);

  useEffect(() => {
    measuredMap.current.clear();
    measuredIndices.current = [];
    // Recompute next frame to avoid thrash
    if (rafId.current) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0;
      recomputeRange();
    });
  }, [identity]);

  // Top spacer height = start * estimate + adjustments of measured items before start
  const topSpacer = useMemo(() => {
    const base = range.start * estimateItemHeight;
    const adj = sumAdjustBefore(range.start, measuredMap, measuredIndices, estimateItemHeight);
    return Math.max(0, base + adj);
  }, [range.start, estimateItemHeight]);

  // Sum visible heights (measured or estimate)
  const visibleHeights = useMemo(() => {
    let sum = 0;
    for (let i = range.start; i < range.end; i++) {
      sum += measuredMap.current.get(i) ?? estimateItemHeight;
    }
    return sum;
  }, [range.start, range.end, estimateItemHeight]);

  // Total height approximation
  const totalHeight = useMemo(() => {
    const base = count * estimateItemHeight;
    const adj = sumAdjustBefore(count, measuredMap, measuredIndices, estimateItemHeight);
    return Math.max(base + adj, topSpacer + visibleHeights);
  }, [count, estimateItemHeight, topSpacer, visibleHeights]);

  // Helper to register measure
  const registerMeasureRef = (index) => (el) => {
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      const prev = measuredMap.current.get(index);
      if (Math.abs((prev ?? 0) - h) > 0.5) {
        measuredMap.current.set(index, h);
        if (!measuredIndices.current.includes(index)) {
          measuredIndices.current.push(index);
          measuredIndices.current.sort((a, b) => a - b);
        }
        // After measurement, update range/spacers
        recomputeRange();
      }
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => measure());
      ro.observe(el);
      // Store on element for cleanup
      el.__ro = ro;
    }
  };

  useEffect(() => {
    return () => {
      // cleanup observers
      const arr = measuredIndices.current;
      arr.forEach((i) => {
        // no direct elements retained, skip
      });
    };
  }, []);

  const slice = items.slice(range.start, range.end);

  return (
    <div className="virtual-wrapper" style={{ height: totalHeight }}>
      <div style={{ height: topSpacer }} />
      {slice.map((item, i) => {
        const index = i + range.start;
        const key = keyExtractor ? keyExtractor(item, index) : item?.id ?? index;
        return (
          <div key={key} ref={registerMeasureRef(index)} className="virtual-item">
            {renderItem({ item, index })}
          </div>
        );
      })}
      <div style={{ height: Math.max(totalHeight - topSpacer - visibleHeights, 0) }} />
    </div>
  );
}
