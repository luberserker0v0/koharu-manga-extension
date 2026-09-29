import type { PageImageCandidate } from './types';

interface SourceResponse {
  ok: boolean;
  data?: string;
  contentType?: string;
  error?: string;
}

function extensionFor(contentType: string): string {
  const subtype = contentType.split(';')[0]?.split('/')[1]?.toLowerCase();
  if (subtype === 'jpeg') return 'jpg';
  return subtype && /^[a-z0-9.+-]+$/.test(subtype) ? subtype : 'jpg';
}

function safeName(name: string, order: number, contentType: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_');
  if (/\.[a-z0-9]{2,5}$/i.test(cleaned)) return cleaned;
  return `${cleaned || `page-${String(order + 1).padStart(3, '0')}`}.${extensionFor(contentType)}`;
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export async function requiredSourceOrigins(candidates: PageImageCandidate[]): Promise<string[]> {
  const patterns = new Set<string>();
  for (const candidate of candidates) {
    const url = new URL(candidate.sourceUrl);
    if (['http:', 'https:'].includes(url.protocol)) patterns.add(`${url.protocol}//${url.host}/*`);
  }
  return [...patterns];
}

export async function loadCandidateFiles(
  candidates: PageImageCandidate[],
  signal?: AbortSignal,
  onProgress?: (current: number, total: number) => void,
): Promise<File[]> {
  const files: File[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const candidate = candidates[index]!;
    let bytes: Uint8Array;
    let contentType: string;
    let name = candidate.fileName;
    const response = await browser.runtime.sendMessage({ type: 'FETCH_PAGE_IMAGE', url: candidate.sourceUrl }) as SourceResponse;
    if (!response.ok || !response.data) throw new Error(response.error || 'page_image_fetch_failed');
    bytes = decodeBase64(response.data);
    contentType = response.contentType || 'application/octet-stream';
    const fileBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    files.push(new File([fileBuffer], safeName(name, index, contentType), { type: contentType }));
    onProgress?.(index + 1, candidates.length);
  }
  return files;
}
