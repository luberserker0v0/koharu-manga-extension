import type { PageImageCandidate } from './types';

export interface PageNumberOverlayEntry {
  candidate: PageImageCandidate;
  pageNumber: number;
  label: string;
}

interface MountedEntry extends PageNumberOverlayEntry {
  element: Element | null;
  badge: HTMLDivElement;
}

export class PageNumberOverlay {
  private readonly container: HTMLDivElement;
  private entries: MountedEntry[] = [];
  private frame: number | null = null;
  private active = false;
  private needsResolve = false;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly mutationObserver: MutationObserver;

  constructor(private readonly resolveElements: (candidates: readonly PageImageCandidate[]) => Map<string, Element>) {
    this.container = document.createElement('div');
    this.container.dataset.koharuPageNumbers = 'true';
    Object.assign(this.container.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483645',
      pointerEvents: 'none',
      overflow: 'hidden',
    });
    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => this.schedule());
    this.mutationObserver = new MutationObserver(() => {
      this.needsResolve = true;
      this.schedule();
    });
  }

  set(entries: PageNumberOverlayEntry[]): void {
    this.clearEntries();
    if (!entries.length) {
      this.detach();
      return;
    }
    if (!this.container.isConnected) document.documentElement.append(this.container);
    this.entries = entries.map((entry) => {
      const badge = document.createElement('div');
      badge.textContent = entry.label;
      badge.setAttribute('aria-hidden', 'true');
      Object.assign(badge.style, {
        position: 'absolute',
        display: 'none',
        maxWidth: 'calc(100vw - 12px)',
        padding: '3px 7px',
        border: '1px solid rgba(255,255,255,.72)',
        borderRadius: '999px',
        color: '#fff',
        background: 'rgba(35,32,29,.76)',
        boxShadow: '0 2px 8px rgba(0,0,0,.28)',
        font: '700 11px/1.25 system-ui, sans-serif',
        whiteSpace: 'nowrap',
        transform: 'translateZ(0)',
      });
      this.container.append(badge);
      return { ...entry, element: null, badge };
    });
    this.resolveDisconnectedEntries();
    this.attach();
    this.update();
  }

  destroy(): void {
    this.clearEntries();
    this.detach();
    this.mutationObserver.disconnect();
    this.resizeObserver?.disconnect();
    this.container.remove();
  }

  private readonly schedule = () => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.needsResolve) {
        this.needsResolve = false;
        this.resolveDisconnectedEntries();
      }
      this.update();
    });
  };

  private readonly update = () => {
    const fullscreen = Boolean(document.fullscreenElement
      || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);
    this.container.style.display = fullscreen ? 'none' : 'block';
    if (fullscreen) return;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    for (const entry of this.entries) {
      const rect = entry.element?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0
        || rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportHeight || rect.left >= viewportWidth) {
        entry.badge.style.display = 'none';
        continue;
      }
      entry.badge.style.display = 'block';
      const maximumLeft = Math.max(6, viewportWidth - entry.badge.offsetWidth - 6);
      const maximumTop = Math.max(6, viewportHeight - entry.badge.offsetHeight - 6);
      entry.badge.style.left = `${Math.max(6, Math.min(maximumLeft, rect.left + 6))}px`;
      entry.badge.style.top = `${Math.max(6, Math.min(maximumTop, rect.top + 6))}px`;
    }
  };

  private resolveDisconnectedEntries(): void {
    const unresolved = this.entries.filter((entry) => !entry.element?.isConnected);
    if (!unresolved.length) return;
    const resolved = this.resolveElements(unresolved.map((entry) => entry.candidate));
    for (const entry of unresolved) {
      if (entry.element) this.resizeObserver?.unobserve(entry.element);
      entry.element = resolved.get(entry.candidate.id) ?? null;
      if (entry.element) this.resizeObserver?.observe(entry.element);
    }
  }

  private attach(): void {
    if (this.active) return;
    this.active = true;
    window.addEventListener('scroll', this.schedule, true);
    window.addEventListener('resize', this.schedule);
    window.visualViewport?.addEventListener('scroll', this.schedule);
    window.visualViewport?.addEventListener('resize', this.schedule);
    document.addEventListener('fullscreenchange', this.schedule);
    document.addEventListener('webkitfullscreenchange', this.schedule);
    this.mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  private detach(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.active) {
      window.removeEventListener('scroll', this.schedule, true);
      window.removeEventListener('resize', this.schedule);
      window.visualViewport?.removeEventListener('scroll', this.schedule);
      window.visualViewport?.removeEventListener('resize', this.schedule);
      document.removeEventListener('fullscreenchange', this.schedule);
      document.removeEventListener('webkitfullscreenchange', this.schedule);
      this.mutationObserver.disconnect();
    }
    this.active = false;
    this.container.remove();
  }

  private clearEntries(): void {
    this.resizeObserver?.disconnect();
    this.entries = [];
    this.needsResolve = false;
    this.container.replaceChildren();
  }
}
