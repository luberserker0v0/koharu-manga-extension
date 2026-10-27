import { BackendApiError, BackendNetworkError, isAbortError } from './errors';
import { healthUrlFromApiBase, normalizeApiBaseUrl } from './url';
import type {
  ApiSettings,
  ArtifactsEnvelope,
  EventsEnvelope,
  HealthResponse,
  JobArtifact,
  JobResource,
  PageRevision,
  PageRevisionManifest,
  PageRevisionSelection,
  ReadinessResponse,
  RuntimeStatus,
  SelectiveRetranslationRequest,
  SourcePreflight,
  TextRegionCorrectionRequest,
  TextRegionSnapshot,
  TranslationJobRequest,
  TranslatedImage,
  TranslatedImagesEnvelope,
  TranslationProviderCatalog,
  UploadProgress,
  UploadSession,
} from './types';

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | object | null;
}

interface BackendClientOptions {
  useBackgroundProxy?: boolean;
}

interface ProxyResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  encoding?: 'text' | 'base64';
}

export interface DownloadedArtifact {
  blob: Blob;
  fileName: string;
}

function artifactFileName(disposition: string, artifact: JobArtifact): string {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  let name = encoded ? decodeURIComponent(encoded) : plain;
  if (!name) name = `${artifact.kind || 'artifact'}-${artifact.id}`;
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_');
}

async function parseErrorResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function detailMessage(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object' && 'error' in detail) {
    const value = (detail as { error?: unknown }).error;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

export class BackendClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly useBackgroundProxy: boolean;

  constructor(settings: Pick<ApiSettings, 'baseUrl' | 'token'>, options: BackendClientOptions = {}) {
    this.baseUrl = normalizeApiBaseUrl(settings.baseUrl);
    this.token = settings.token.trim();
    this.useBackgroundProxy = options.useBackgroundProxy === true;
  }

  private async proxyRequest(path: string, options: RequestOptions = {}, health = false): Promise<Response> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const headers = new Headers(options.headers);
    // Authentication is added by the trusted background worker from extension
    // storage; never forward a credential supplied by a content-script client.
    headers.delete('Authorization');
    const body = typeof options.body === 'string' ? options.body : options.body == null ? null : JSON.stringify(options.body);
    const pending = browser.runtime.sendMessage({
      type: 'BACKEND_REQUEST',
      path,
      health,
      method: options.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body,
    }) as Promise<ProxyResponse | undefined>;
    const result = options.signal
      ? await Promise.race([
          pending,
          new Promise<never>((_, reject) => options.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )),
        ])
      : await pending;
    if (!result || typeof result.status !== 'number') throw new BackendNetworkError('Background backend proxy did not respond.', null);
    let responseBody: BodyInit | null = result.body ? result.body : null;
    if (result.encoding === 'base64' && result.body) {
      const binary = atob(result.body);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      responseBody = bytes;
    }
    return new Response(responseBody, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }

  private headers(extra?: HeadersInit, authenticate = true): Headers {
    const headers = new Headers(extra);
    if (authenticate && this.token) headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    const isBodyObject = options.body !== undefined
      && options.body !== null
      && typeof options.body === 'object'
      && !(options.body instanceof Blob)
      && !(options.body instanceof ArrayBuffer)
      && !(options.body instanceof FormData)
      && !(options.body instanceof URLSearchParams)
      && !ArrayBuffer.isView(options.body);
    const headers = this.headers(options.headers);
    if (isBodyObject && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const body = isBodyObject ? JSON.stringify(options.body) : options.body as BodyInit | null | undefined;

    let response: Response;
    try {
      response = this.useBackgroundProxy
        ? await this.proxyRequest(path, { ...options, method, headers, body })
        : await fetch(`${this.baseUrl}${path}`, { ...options, method, headers, body });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new BackendNetworkError(`${method} ${path} could not reach the backend.`, error);
    }
    if (!response.ok) {
      const detail = await parseErrorResponse(response);
      throw new BackendApiError({
        message: detailMessage(detail, `${method} ${path} failed with HTTP ${response.status}.`),
        status: response.status,
        method,
        path,
        requestId: response.headers.get('x-request-id'),
        detail,
      });
    }
    return response;
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, options);
    return response.json() as Promise<T>;
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    let response: Response;
    try {
      response = this.useBackgroundProxy
        ? await this.proxyRequest('/health', { signal }, true)
        : await fetch(healthUrlFromApiBase(this.baseUrl), { signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new BackendNetworkError('GET /health could not reach the backend.', error);
    }
    if (!response.ok) {
      const detail = await parseErrorResponse(response);
      throw new BackendApiError({
        message: detailMessage(detail, `GET /health failed with HTTP ${response.status}.`),
        status: response.status,
        method: 'GET',
        path: '/health',
        requestId: response.headers.get('x-request-id'),
        detail,
      });
    }
    return response.json() as Promise<HealthResponse>;
  }

  runtimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
    return this.json('/runtime/status', { signal });
  }

  async readiness(signal?: AbortSignal): Promise<ReadinessResponse> {
    try {
      return await this.json('/ready', { signal });
    } catch (error) {
      if (error instanceof BackendApiError && error.status === 503 && error.detail
        && typeof error.detail === 'object' && 'ok' in error.detail) {
        return error.detail as ReadinessResponse;
      }
      throw error;
    }
  }

  getTranslationProviders(signal?: AbortSignal): Promise<TranslationProviderCatalog> {
    return this.json('/runtime/koharu/translation-providers', { signal });
  }

  createUpload(signal?: AbortSignal): Promise<UploadSession> {
    return this.json('/uploads', { method: 'POST', body: { kind: 'source' }, signal });
  }

  getUpload(uploadId: string, signal?: AbortSignal): Promise<UploadSession> {
    return this.json(`/uploads/${encodeURIComponent(uploadId)}`, { signal });
  }

  async uploadFiles(
    uploadId: string,
    files: File[],
    onProgress: (progress: UploadProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    let completedBytes = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      await this.uploadFile(uploadId, file, (loaded) => {
        const totalLoaded = completedBytes + loaded;
        onProgress({
          fileIndex: index,
          fileCount: files.length,
          fileName: file.name,
          fileLoaded: loaded,
          fileTotal: file.size,
          totalLoaded,
          totalBytes,
          percent: totalBytes === 0 ? 0 : Math.round((totalLoaded / totalBytes) * 100),
        });
      }, signal);
      completedBytes += file.size;
    }
  }

  private uploadFile(
    uploadId: string,
    file: File,
    onProgress: (loaded: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.useBackgroundProxy) return this.uploadFileThroughBackground(uploadId, file, onProgress, signal);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const path = `/uploads/${encodeURIComponent(uploadId)}/files/${encodeURIComponent(file.name)}`;
      xhr.open('PUT', `${this.baseUrl}${path}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.upload.addEventListener('progress', (event) => onProgress(event.loaded));
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(file.size);
          resolve();
          return;
        }
        let detail: unknown = xhr.responseText;
        try { detail = JSON.parse(xhr.responseText) as unknown; } catch { /* text is useful */ }
        reject(new BackendApiError({
          message: detailMessage(detail, `PUT ${path} failed with HTTP ${xhr.status}.`),
          status: xhr.status,
          method: 'PUT',
          path,
          requestId: xhr.getResponseHeader('x-request-id'),
          detail,
        }));
      });
      xhr.addEventListener('error', () => reject(new BackendNetworkError(`PUT ${path} could not reach the backend.`, null)));
      xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      const abort = () => xhr.abort();
      signal?.addEventListener('abort', abort, { once: true });
      xhr.addEventListener('loadend', () => signal?.removeEventListener('abort', abort));
      xhr.send(file);
    });
  }

  private uploadFileThroughBackground(
    uploadId: string,
    file: File,
    onProgress: (loaded: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const port = browser.runtime.connect({ name: 'KOHARU_BACKEND_UPLOAD' });
      let offset = 0;
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        try { port.disconnect(); } catch { /* already disconnected */ }
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new DOMException('Aborted', 'AbortError'));
      const sendNext = async () => {
        try {
          if (offset >= file.size) { port.postMessage({ type: 'finish' }); return; }
          const end = Math.min(file.size, offset + 256 * 1024);
          const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
          let binary = '';
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          offset = end;
          port.postMessage({ type: 'chunk', data: btoa(binary) });
          onProgress(offset);
        } catch (error) { finish(error); }
      };
      port.onMessage.addListener((message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'ready' || message.type === 'chunk-accepted') void sendNext();
        if (message.type === 'done') { onProgress(file.size); finish(); }
        if (message.type === 'error') {
          const value = message as { status?: number; message?: string; requestId?: string | null; detail?: unknown };
          finish(value.status
            ? new BackendApiError({ message: value.message ?? 'Upload failed.', status: value.status, method: 'PUT', path: '/uploads', requestId: value.requestId, detail: value.detail })
            : new BackendNetworkError(value.message ?? 'Upload could not reach the backend.', null));
        }
      });
      port.onDisconnect.addListener(() => {
        if (!settled) finish(new BackendNetworkError('Background upload proxy disconnected.', null));
      });
      signal?.addEventListener('abort', abort, { once: true });
      port.postMessage({ type: 'init', uploadId, fileName: file.name, contentType: file.type || 'application/octet-stream', size: file.size });
    });
  }

  completeUpload(uploadId: string, signal?: AbortSignal): Promise<UploadSession> {
    return this.json(`/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', signal });
  }

  async deleteUpload(uploadId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', signal });
  }

  createPreflight(uploadId: string, signal?: AbortSignal): Promise<SourcePreflight> {
    return this.json('/source-preflight', { method: 'POST', body: { uploadId }, signal });
  }

  getPreflight(preflightId: string, signal?: AbortSignal): Promise<SourcePreflight> {
    return this.json(`/source-preflight/${encodeURIComponent(preflightId)}`, { signal });
  }

  reorderPreflight(preflightId: string, orderedImageIds: string[], signal?: AbortSignal): Promise<SourcePreflight> {
    return this.json(`/source-preflight/${encodeURIComponent(preflightId)}/reorder`, {
      method: 'POST',
      body: { orderedImageIds },
      signal,
    });
  }

  createTranslationJob(payload: TranslationJobRequest, signal?: AbortSignal): Promise<JobResource> {
    return this.json('/jobs/translation', { method: 'POST', body: payload, signal });
  }

  createRetranslation(parentJobId: string, payload: SelectiveRetranslationRequest, signal?: AbortSignal): Promise<JobResource> {
    return this.json(`/jobs/${encodeURIComponent(parentJobId)}/retranslations`, {
      method: 'POST',
      body: payload,
      signal,
    });
  }

  getTextRegions(jobId: string, sourceImageId?: string, signal?: AbortSignal): Promise<TextRegionSnapshot> {
    const query = sourceImageId ? `?sourceImageId=${encodeURIComponent(sourceImageId)}` : '';
    return this.json(`/jobs/${encodeURIComponent(jobId)}/text-regions${query}`, { signal });
  }

  createTextRegionCorrection(
    parentJobId: string,
    payload: TextRegionCorrectionRequest,
    signal?: AbortSignal,
  ): Promise<JobResource> {
    return this.json(`/jobs/${encodeURIComponent(parentJobId)}/text-region-corrections`, {
      method: 'POST',
      body: payload,
      signal,
    });
  }

  getJob(jobId: string, signal?: AbortSignal): Promise<JobResource> {
    return this.json(`/jobs/${encodeURIComponent(jobId)}`, { signal });
  }

  cancelJob(jobId: string, signal?: AbortSignal): Promise<JobResource> {
    return this.json(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', signal });
  }

  retryJob(jobId: string, signal?: AbortSignal): Promise<JobResource> {
    return this.json(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', signal });
  }

  resumeJob(jobId: string, signal?: AbortSignal): Promise<JobResource> {
    return this.json(`/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST', signal });
  }

  getEvents(jobId: string, signal?: AbortSignal): Promise<EventsEnvelope> {
    return this.json(`/jobs/${encodeURIComponent(jobId)}/events`, { signal });
  }

  getArtifacts(jobId: string, signal?: AbortSignal): Promise<ArtifactsEnvelope> {
    return this.json(`/jobs/${encodeURIComponent(jobId)}/artifacts`, { signal });
  }

  getTranslatedImages(jobId: string, signal?: AbortSignal): Promise<TranslatedImagesEnvelope> {
    return this.json(`/jobs/${encodeURIComponent(jobId)}/translated-images`, { signal });
  }

  getPageRevisions(rootJobId: string, signal?: AbortSignal): Promise<PageRevisionManifest> {
    return this.json(`/jobs/${encodeURIComponent(rootJobId)}/page-revisions`, { signal });
  }

  activatePageRevisions(
    rootJobId: string,
    selections: PageRevisionSelection[],
    signal?: AbortSignal,
  ): Promise<PageRevisionManifest> {
    return this.json(`/jobs/${encodeURIComponent(rootJobId)}/page-revisions/activate`, {
      method: 'POST',
      body: { selections },
      signal,
    });
  }

  async downloadTranslatedImage(jobId: string, image: TranslatedImage, signal?: AbortSignal): Promise<Blob> {
    const path = `/jobs/${encodeURIComponent(jobId)}/translated-images/${encodeURIComponent(image.id)}/content`;
    const response = await this.request(path, { signal });
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('translated_image_content_invalid');
    return blob;
  }

  async downloadPageRevisionImage(revision: PageRevision, signal?: AbortSignal): Promise<Blob> {
    const path = `/jobs/${encodeURIComponent(revision.jobId)}/translated-images/${encodeURIComponent(revision.image.id)}/content`;
    const response = await this.request(path, { signal });
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('translated_image_content_invalid');
    return blob;
  }

  stream(jobId: string, signal?: AbortSignal): Promise<Response> {
    if (this.useBackgroundProxy) return this.streamThroughBackground(jobId, signal);
    return this.request(`/jobs/${encodeURIComponent(jobId)}/stream?eventMode=message`, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
  }

  private streamThroughBackground(jobId: string, signal?: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const port = browser.runtime.connect({ name: 'KOHARU_BACKEND_SSE' });
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let opened = false;
      let ended = false;
      const body = new ReadableStream<Uint8Array>({
        start(nextController) { controller = nextController; },
        cancel() { ended = true; port.disconnect(); },
      });
      const abort = () => {
        ended = true;
        try { controller?.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ }
        port.disconnect();
        if (!opened) reject(new DOMException('Aborted', 'AbortError'));
      };
      port.onMessage.addListener((message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'open') {
          const value = message as unknown as { status: number; headers?: Record<string, string> };
          opened = true;
          resolve(new Response(body, { status: value.status, headers: value.headers }));
        } else if (message.type === 'chunk' && 'data' in message && typeof message.data === 'string') {
          const binary = atob(message.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          controller?.enqueue(bytes);
        } else if (message.type === 'done') {
          ended = true;
          controller?.close();
          port.disconnect();
        } else if (message.type === 'error') {
          const error = new BackendNetworkError('Backend event stream failed.', null);
          ended = true;
          if (opened) controller?.error(error); else reject(error);
          port.disconnect();
        }
      });
      port.onDisconnect.addListener(() => {
        signal?.removeEventListener('abort', abort);
        if (ended) return;
        const error = new BackendNetworkError('Background event-stream proxy disconnected.', null);
        if (opened) controller?.error(error); else reject(error);
      });
      signal?.addEventListener('abort', abort, { once: true });
      port.postMessage({ type: 'init', jobId });
    });
  }

  async downloadArtifact(jobId: string, artifact: JobArtifact, signal?: AbortSignal): Promise<DownloadedArtifact> {
    const path = `/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
    try {
      const response = await this.request(path, { signal });
      return {
        blob: await response.blob(),
        fileName: artifactFileName(response.headers.get('content-disposition') ?? '', artifact),
      };
    } catch (error) {
      if (!(error instanceof BackendNetworkError) || signal?.aborted) throw error;
      return this.downloadArtifactWithXhr(path, artifact, signal);
    }
  }

  private downloadArtifactWithXhr(path: string, artifact: JobArtifact, signal?: AbortSignal): Promise<DownloadedArtifact> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${this.baseUrl}${path}`);
      xhr.responseType = 'blob';
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response instanceof Blob) {
          resolve({
            blob: xhr.response,
            fileName: artifactFileName(xhr.getResponseHeader('content-disposition') ?? '', artifact),
          });
          return;
        }
        reject(new BackendApiError({
          message: `GET ${path} failed with HTTP ${xhr.status}.`,
          status: xhr.status,
          method: 'GET',
          path,
          requestId: xhr.getResponseHeader('x-request-id'),
        }));
      });
      xhr.addEventListener('error', () => reject(new BackendNetworkError(`GET ${path} could not reach the backend.`, null)));
      xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      const abort = () => xhr.abort();
      signal?.addEventListener('abort', abort, { once: true });
      xhr.addEventListener('loadend', () => signal?.removeEventListener('abort', abort));
      xhr.send();
    });
  }
}
