import type { DetectionOptions, DetectionResult, ImageDetector, PageImageCandidate, PageImageTargetKind } from './types';

export interface GenericDetectorLimits {
  maxViewportAdvances: number;
  maxDurationMs: number;
  maxCandidates: number;
  settleMs: number;
  imageLoadTimeoutMs: number;
}

export const DEFAULT_DETECTOR_LIMITS: GenericDetectorLimits = {
  maxViewportAdvances: 50,
  maxDurationMs: 30_000,
  maxCandidates: 500,
  settleMs: 250,
  imageLoadTimeoutMs: 2_500,
};

const domIds = new WeakMap<Element, string>();
let nextDomId = 1;

/** Upper bound for shadow-DOM / background scans so huge pages stay responsive. */
const MAX_TRAVERSAL_NODES = 2_000;

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

const LAZY_DATASET_KEYS = ['src', 'lazySrc', 'original', 'echo', 'lazy', 'url'] as const;

export function absoluteHttpUrl(raw: string): string {
  if (!raw) return '';
  try {
    const url = new URL(raw, document.baseURI);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.startsWith('http://') || raw.startsWith('https://') ? raw : '';
  }
}

export function normalizedImageUrl(image: HTMLImageElement): string {
  const dataset = image.dataset as Record<string, string | undefined>;
  const raw = image.currentSrc
    || image.src
    || LAZY_DATASET_KEYS.map((key) => dataset[key]).find(Boolean)
    || '';
  return absoluteHttpUrl(raw);
}

/** First URL token of a `srcset`-style list (`url [descriptor], ...`). */
export function srcsetFirstUrl(srcset: string | null | undefined): string {
  if (!srcset) return '';
  const first = srcset.split(',')[0]?.trim() ?? '';
  const token = first.split(/\s+/)[0] ?? '';
  return absoluteHttpUrl(token);
}

const BACKGROUND_URL_PATTERN = /url\(\s*["']?(https?:[^"')]+)["']?\s*\)/i;

export function backgroundImageUrl(element: Element): string {
  let background: string | null = null;
  try {
    background = getComputedStyle(element).backgroundImage;
  } catch {
    return '';
  }
  if (!background || background === 'none') return '';
  const match = BACKGROUND_URL_PATTERN.exec(background);
  return match?.[1] ? absoluteHttpUrl(match[1]) : '';
}

function domId(element: Element): string {
  const existing = domIds.get(element);
  if (existing) return existing;
  const value = `dom-${nextDomId++}`;
  domIds.set(element, value);
  return value;
}

function locator(element: Element, sourceUrl: string): string {
  const escape = (value: string) => globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
  if (element.id) return `#${escape(element.id)}`;
  if (element instanceof HTMLImageElement) {
    if (sourceUrl) return `img[src="${escape(element.getAttribute('src') ?? sourceUrl)}"]`;
    return 'img';
  }
  return element.tagName.toLowerCase();
}

export async function ensureImageLoaded(image: HTMLImageElement, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw abortError();
  if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
    try { await image.decode?.(); } catch { /* decoded pixels may still be usable */ }
    return true;
  }
  return new Promise<boolean>((resolve, reject) => {
    const finish = (loaded: boolean) => {
      clearTimeout(timer);
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      resolve(loaded);
    };
    const onLoad = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
    const onError = () => finish(false);
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => {
      clearTimeout(timer);
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => finish(image.complete && image.naturalWidth > 0), timeoutMs);
    image.addEventListener('load', onLoad, { once: true });
    image.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isVisibleStyle(element: Element): boolean {
  try {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
  } catch {
    return false;
  }
  return true;
}

function isPlausibleSize(width: number, height: number): boolean {
  if (width < 240 || height < 240) return false;
  const area = width * height;
  const tallPage = height / Math.max(width, 1) >= 1.1;
  return area >= 180_000 || tallPage;
}

function rectOf(element: Element): { width: number; height: number } {
  try {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  } catch {
    return { width: 0, height: 0 };
  }
}

function isPlausible(image: HTMLImageElement): boolean {
  const rect = image.getBoundingClientRect();
  const width = image.naturalWidth || rect.width;
  const height = image.naturalHeight || rect.height;
  if (!isPlausibleSize(width, height)) return false;
  if (!isVisibleStyle(image)) return false;
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

function isPlausibleElement(element: Element, width: number, height: number): boolean {
  if (!isPlausibleSize(width, height)) return false;
  if (!isVisibleStyle(element)) return false;
  const rect = rectOf(element);
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

function fileNameFor(url: string, order: number): string {
  if (url.startsWith('canvas:')) return `canvas-${String(order + 1).padStart(3, '0')}.png`;
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (/\.(?:avif|bmp|gif|hei[cf]|jpe?g|png|tiff?|webp)$/i.test(name)) return name;
  } catch { /* synthesize below */ }
  return `page-${String(order + 1).padStart(3, '0')}.jpg`;
}

interface PendingCandidate {
  element: Element;
  sourceUrl: string;
  width: number | null;
  height: number | null;
  targetKind: PageImageTargetKind;
  loadStatus: PageImageCandidate['loadStatus'];
}

function pushCandidate(
  candidates: PageImageCandidate[],
  byUrl: Map<string, PageImageCandidate>,
  maxCandidates: number,
  pending: PendingCandidate,
): void {
  if (candidates.length >= maxCandidates || !pending.sourceUrl) return;
  const id = domId(pending.element);
  const candidate: PageImageCandidate = {
    id,
    order: candidates.length,
    sourceUrl: pending.sourceUrl,
    fileName: fileNameFor(pending.sourceUrl, candidates.length),
    width: pending.width,
    height: pending.height,
    origin: 'dom',
    loadStatus: pending.loadStatus,
    domLocator: locator(pending.element, pending.sourceUrl),
    targetKind: pending.targetKind,
    selected: true,
  };
  const previous = byUrl.get(pending.sourceUrl);
  if (previous) {
    if ((candidate.width ?? 0) * (candidate.height ?? 0) > (previous.width ?? 0) * (previous.height ?? 0)) {
      Object.assign(previous, candidate, { id: previous.id, order: previous.order });
    }
    return;
  }
  byUrl.set(pending.sourceUrl, candidate);
  candidates.push(candidate);
}

/** Breadth-first walk of the light DOM plus open shadow roots, bounded by node count. */
function traverseElements(visit: (element: Element) => void): void {
  let seen = 0;
  const queue: Element[] = [document.documentElement];
  while (queue.length && seen < MAX_TRAVERSAL_NODES) {
    const current = queue.shift()!;
    seen += 1;
    visit(current);
    if (current.shadowRoot) queue.push(...Array.from(current.shadowRoot.children));
    queue.push(...Array.from(current.children));
  }
}

/** Live `<img>` scan: light DOM plus shadow-DOM images missed by `document.images`. */
function collectImages(maxCandidates: number): PageImageCandidate[] {
  const candidates: PageImageCandidate[] = [];
  const byUrl = new Map<string, PageImageCandidate>();
  const consider = (image: HTMLImageElement) => {
    if (candidates.length >= maxCandidates || !isPlausible(image)) return;
    const sourceUrl = normalizedImageUrl(image);
    if (!sourceUrl) return;
    pushCandidate(candidates, byUrl, maxCandidates, {
      element: image,
      sourceUrl,
      width: image.naturalWidth || Math.round(image.getBoundingClientRect().width) || null,
      height: image.naturalHeight || Math.round(image.getBoundingClientRect().height) || null,
      targetKind: 'img',
      loadStatus: image.complete && image.naturalWidth > 0 ? 'loaded' : 'pending',
    });
  };
  for (const image of Array.from(document.images)) consider(image);
  traverseElements((element) => {
    if (element instanceof HTMLImageElement) consider(element);
  });
  return candidates;
}

/**
 * Static extras scanned once per detection (not per scroll step):
 * `<picture>` sources, video posters, CSS background images, canvas snapshots.
 */
function collectStatic(maxCandidates: number): PageImageCandidate[] {
  const candidates: PageImageCandidate[] = [];
  const byUrl = new Map<string, PageImageCandidate>();
  const seen = new Set<string>();
  const claim = (url: string): boolean => {
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  };
  traverseElements((element) => {
    if (candidates.length >= maxCandidates) return;
    if (element instanceof HTMLImageElement) return;
    if (element instanceof HTMLSourceElement) {
      const url = srcsetFirstUrl(element.getAttribute('srcset')) || absoluteHttpUrl(element.getAttribute('src') ?? '');
      if (!claim(url)) return;
      const picture = element.closest('picture');
      const img = picture?.querySelector('img');
      const anchor: Element = img ?? element;
      const rect = rectOf(anchor);
      const width = img?.naturalWidth || Math.round(rect.width) || null;
      const height = img?.naturalHeight || Math.round(rect.height) || null;
      if (!isPlausibleElement(anchor, rect.width || width || 0, rect.height || height || 0)) return;
      pushCandidate(candidates, byUrl, maxCandidates, {
        element: anchor, sourceUrl: url, width, height, targetKind: 'img', loadStatus: 'loaded',
      });
      return;
    }
    if (element instanceof HTMLVideoElement) {
      const poster = absoluteHttpUrl(element.getAttribute('poster') ?? '');
      if (!claim(poster)) return;
      const rect = rectOf(element);
      if (!isPlausibleElement(element, rect.width, rect.height)) return;
      pushCandidate(candidates, byUrl, maxCandidates, {
        element,
        sourceUrl: poster,
        width: Math.round(rect.width) || null,
        height: Math.round(rect.height) || null,
        targetKind: 'video',
        loadStatus: 'loaded',
      });
      return;
    }
    if (element instanceof HTMLCanvasElement) {
      const rect = rectOf(element);
      if (!isPlausibleElement(element, rect.width, rect.height)) return;
      const sourceUrl = `canvas:${domId(element)}`;
      if (!claim(sourceUrl)) return;
      pushCandidate(candidates, byUrl, maxCandidates, {
        element,
        sourceUrl,
        width: Math.round(rect.width) || element.width || null,
        height: Math.round(rect.height) || element.height || null,
        targetKind: 'canvas',
        loadStatus: 'loaded',
      });
      return;
    }
    // CSS background images on visible, page-sized elements.
    const rect = rectOf(element);
    if (rect.width < 240 || rect.height < 240) return;
    const background = backgroundImageUrl(element);
    if (!claim(background)) return;
    if (!isPlausibleElement(element, rect.width, rect.height)) return;
    pushCandidate(candidates, byUrl, maxCandidates, {
      element,
      sourceUrl: background,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      targetKind: 'css-background',
      loadStatus: 'loaded',
    });
  });
  return candidates;
}

function mergeCandidates(lists: PageImageCandidate[][], maxCandidates: number): PageImageCandidate[] {
  const merged: PageImageCandidate[] = [];
  const byUrl = new Map<string, PageImageCandidate>();
  for (const list of lists) {
    for (const candidate of list) {
      if (merged.length >= maxCandidates || byUrl.has(candidate.sourceUrl)) continue;
      byUrl.set(candidate.sourceUrl, candidate);
      merged.push(candidate);
    }
  }
  return merged.map((candidate, order) => ({ ...candidate, order }));
}

export class GenericDomImageDetector implements ImageDetector {
  constructor(private readonly limits: GenericDetectorLimits = DEFAULT_DETECTOR_LIMITS) {}

  async detect(_url: string, options: DetectionOptions = {}): Promise<DetectionResult> {
    const startedAt = Date.now();
    const originalX = window.scrollX;
    const originalY = window.scrollY;
    const statics = collectStatic(this.limits.maxCandidates);
    let images: PageImageCandidate[] = [];
    try {
      const iterations = options.deep ? this.limits.maxViewportAdvances : 1;
      for (let index = 0; index < iterations; index += 1) {
        if (options.signal?.aborted) throw abortError();
        images = mergeCandidates([collectImages(this.limits.maxCandidates), statics], this.limits.maxCandidates);
        options.onProgress?.(images.length);
        if (!options.deep || images.length >= this.limits.maxCandidates || Date.now() - startedAt >= this.limits.maxDurationMs) break;
        const bottom = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) - window.innerHeight;
        if (window.scrollY >= bottom - 2) break;
        window.scrollTo({ top: Math.min(bottom, window.scrollY + Math.max(window.innerHeight * 0.9, 400)), behavior: 'auto' });
        await wait(this.limits.settleMs, options.signal);
      }
      const elements = Array.from(document.images);
      const status = new Map<string, boolean>();
      await Promise.all(elements.map(async (image) => {
        const url = normalizedImageUrl(image);
        if (!images.some((candidate) => candidate.sourceUrl === url)) return;
        status.set(url, await ensureImageLoaded(image, this.limits.imageLoadTimeoutMs, options.signal));
      }));
      const live = collectImages(this.limits.maxCandidates);
      images = mergeCandidates([live, statics], this.limits.maxCandidates).map((candidate, order) => ({
        ...candidate,
        order,
        loadStatus: candidate.targetKind === 'img'
          ? (status.get(candidate.sourceUrl) === false ? 'failed' : 'loaded')
          : 'loaded',
      }));
      const warnings = images.some((candidate) => candidate.targetKind === 'canvas') ? ['canvas_snapshot'] : [];
      return { images, detector: 'dom', warnings, discoveryAvailable: false };
    } finally {
      if (options.deep) window.scrollTo({ left: originalX, top: originalY, behavior: 'auto' });
    }
  }
}

export function findCandidateTarget(candidate: PageImageCandidate): Element | null {
  let found: Element | null = null;
  traverseElements((element) => {
    if (!found && domIds.get(element) === candidate.id) found = element;
  });
  if (found) return found;
  if (candidate.domLocator) {
    try {
      const located = document.querySelector(candidate.domLocator);
      if (located) return located;
    } catch { /* fall through to URL matching */ }
  }
  return null;
}

export function findCandidateElement(candidate: PageImageCandidate): HTMLImageElement | null {
  const target = findCandidateTarget(candidate);
  if (target instanceof HTMLImageElement) return target;
  for (const image of Array.from(document.images)) {
    if (domIds.get(image) === candidate.id) return image;
    if (normalizedImageUrl(image) === candidate.sourceUrl) return image;
  }
  return null;
}
