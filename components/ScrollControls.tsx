import { useCallback, useEffect, useState, type RefObject } from 'react';
import { t } from '../lib/i18n';

interface ScrollControlsProps {
  containerRef: RefObject<HTMLElement | null>;
  className: string;
  label: string;
}

interface ScrollPosition {
  atTop: boolean;
  atBottom: boolean;
}

const EDGE_TOLERANCE = 2;

export function ScrollControls({ containerRef, className, label }: ScrollControlsProps) {
  const [position, setPosition] = useState<ScrollPosition>({ atTop: true, atBottom: true });

  const updatePosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
    setPosition({
      atTop: container.scrollTop <= EDGE_TOLERANCE,
      atBottom: maximum - container.scrollTop <= EDGE_TOLERANCE,
    });
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    };
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate);
    const observeChildren = () => {
      resizeObserver?.disconnect();
      resizeObserver?.observe(container);
      Array.from(container.children).forEach((child) => resizeObserver?.observe(child));
    };
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      observeChildren();
      scheduleUpdate();
    });

    observeChildren();
    mutationObserver?.observe(container, { childList: true, subtree: true });
    container.addEventListener('scroll', updatePosition, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    scheduleUpdate();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      container.removeEventListener('scroll', updatePosition);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [containerRef, updatePosition]);

  const scrollTo = (edge: 'top' | 'bottom') => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTo({
      top: edge === 'top' ? 0 : container.scrollHeight,
      behavior: 'smooth',
    });
  };

  return (
    <nav className={className} aria-label={label}>
      <button
        type="button"
        aria-label={t('scrollToTop')}
        title={t('scrollToTop')}
        disabled={position.atTop}
        onClick={() => scrollTo('top')}
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        aria-label={t('scrollToBottom')}
        title={t('scrollToBottom')}
        disabled={position.atBottom}
        onClick={() => scrollTo('bottom')}
      >
        <span aria-hidden="true">↓</span>
      </button>
    </nav>
  );
}
