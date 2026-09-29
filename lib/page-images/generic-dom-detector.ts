import type { DetectionOptions, DetectionResult, ImageDetector, PageImageCandidate } from './types';

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

const domIds = new WeakMap<HTMLImageElement, string>();
let nextDomId = 1;

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

export function normalizedImageUrl(image: HTMLImageElement): string {
  const raw = image.currentSrc || image.src || image.dataset.src || image.dataset.lazySrc || '';
  try {
    const url = new URL(raw, document.baseURI);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

function domId(image: HTMLImageElement): string {
  const existing = domIds.get(image);
  if (existing) return existing;
  const value = `dom-${nextDomId++}`;
  domIds.set(image, value);
  return value;
}

function locator(image: HTMLImageElement): string {
  const escape = (value: string) => globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
  if (image.id) return `#${escape(image.id)}`;
  const source = normalizedImageUrl(image);
  if (source) return `img[src="${escape(image.getAttribute('src') ?? source)}"]`;
  return 'img';
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

function isPlausible(image: HTMLImageElement): boolean {
  const rect = image.getBoundingClientRect();
  const width = image.naturalWidth || rect.width;
  const height = image.naturalHeight || rect.height;
  if (width < 240 || height < 240) return false;
  const style = getComputedStyle(image);
  if (style.display === 'none' || style.visibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0)) return false;
  if (rect.width === 0 && rect.height === 0) return false;
  const area = width * height;
  const tallPage = height / Math.max(width, 1) >= 1.1;
  return area >= 180_000 || tallPage;
}

function fileNameFor(url: string, order: number): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (/\.(?:avif|bmp|gif|hei[cf]|jpe?g|png|tiff?|webp)$/i.test(name)) return name;
  } catch { /* synthesize below */ }
  return `page-${String(order + 1).padStart(3, '0')}.jpg`;
}

function collect(maxCandidates: number): PageImageCandidate[] {
  const candidates: PageImageCandidate[] = [];
  const byUrl = new Map<string, PageImageCandidate>();
  for (const image of Array.from(document.images)) {
    if (candidates.length >= maxCandidates || !isPlausible(image)) continue;
    const sourceUrl = normalizedImageUrl(image);
    if (!sourceUrl || sourceUrl.startsWith('data:') || sourceUrl.startsWith('blob:')) continue;
    const candidate: PageImageCandidate = {
      id: domId(image),
      order: candidates.length,
      sourceUrl,
      fileName: fileNameFor(sourceUrl, candidates.length),
      width: image.naturalWidth || Math.round(image.getBoundingClientRect().width) || null,
      height: image.naturalHeight || Math.round(image.getBoundingClientRect().height) || null,
      origin: 'dom',
      loadStatus: image.complete && image.naturalWidth > 0 ? 'loaded' : 'pending',
      domLocator: locator(image),
      selected: true,
    };
    const previous = byUrl.get(sourceUrl);
    if (previous) {
      if ((candidate.width ?? 0) * (candidate.height ?? 0) > (previous.width ?? 0) * (previous.height ?? 0)) {
        Object.assign(previous, candidate, { id: previous.id, order: previous.order });
      }
      continue;
    }
    byUrl.set(sourceUrl, candidate);
    candidates.push(candidate);
  }
  return candidates.map((candidate, order) => ({ ...candidate, order }));
}

export class GenericDomImageDetector implements ImageDetector {
  constructor(private readonly limits: GenericDetectorLimits = DEFAULT_DETECTOR_LIMITS) {}

  async detect(_url: string, options: DetectionOptions = {}): Promise<DetectionResult> {
    const startedAt = Date.now();
    const originalX = window.scrollX;
    const originalY = window.scrollY;
    let images: PageImageCandidate[] = [];
    try {
      const iterations = options.deep ? this.limits.maxViewportAdvances : 1;
      for (let index = 0; index < iterations; index += 1) {
        if (options.signal?.aborted) throw abortError();
        images = collect(this.limits.maxCandidates);
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
      images = collect(this.limits.maxCandidates).map((candidate, order) => ({
        ...candidate,
        order,
        loadStatus: status.get(candidate.sourceUrl) === false ? 'failed' : 'loaded',
      }));
      return { images, detector: 'dom', warnings: [], discoveryAvailable: false };
    } finally {
      if (options.deep) window.scrollTo({ left: originalX, top: originalY, behavior: 'auto' });
    }
  }
}

export function findCandidateElement(candidate: PageImageCandidate): HTMLImageElement | null {
  for (const image of Array.from(document.images)) if (domIds.get(image) === candidate.id) return image;
  for (const image of Array.from(document.images)) if (normalizedImageUrl(image) === candidate.sourceUrl) return image;
  if (!candidate.domLocator) return null;
  try { return document.querySelector<HTMLImageElement>(candidate.domLocator); } catch { return null; }
}
