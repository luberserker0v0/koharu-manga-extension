import { isAbortError } from './errors';
import type { BackendClient } from './backend-client';
import type { JobEvent, JobResource } from './types';
import { isTerminalJobStatus } from '../domain/job-state';

export type MonitorTransport = 'connecting' | 'sse' | 'polling' | 'stopped';

export interface JobMonitorCallbacks {
  onJob: (job: JobResource) => void;
  onEvent: (event: JobEvent) => void;
  onTransport: (transport: MonitorTransport) => void;
  onError: (error: unknown) => void;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export async function consumeMessageEventStream(
  response: Response,
  onEvent: (event: JobEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error('sse_body_unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const blocks = pending.split(/\r?\n\r?\n/);
    pending = blocks.pop() ?? '';
    for (const block of blocks) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as JobEvent);
      } catch {
        // Malformed individual messages do not invalidate the entire stream.
      }
    }
    if (done) return;
  }
}

export class JobMonitor {
  private readonly controller = new AbortController();

  constructor(
    private readonly client: BackendClient,
    private readonly jobId: string,
    private readonly callbacks: JobMonitorCallbacks,
  ) {}

  stop(): void {
    this.controller.abort();
    this.callbacks.onTransport('stopped');
  }

  async start(): Promise<void> {
    const { signal } = this.controller;
    let reconnectAttempt = 0;
    try {
      let job = await this.reconcile();
      while (!signal.aborted && !isTerminalJobStatus(job.status)) {
        this.callbacks.onTransport('connecting');
        try {
          const response = await this.client.stream(this.jobId, signal);
          this.callbacks.onTransport('sse');
          reconnectAttempt = 0;
          await consumeMessageEventStream(response, (event) => {
            this.callbacks.onEvent(event);
            void this.reconcile().catch((error) => {
              if (!isAbortError(error)) this.callbacks.onError(error);
            });
          });
          job = await this.reconcile();
          if (isTerminalJobStatus(job.status)) break;
          throw new Error('sse_disconnected');
        } catch (error) {
          if (isAbortError(error) || signal.aborted) break;
          this.callbacks.onError(error);
          this.callbacks.onTransport('polling');
          reconnectAttempt += 1;
          const delay = Math.min(10_000, 1_000 * (2 ** Math.min(reconnectAttempt - 1, 3)));
          const until = Date.now() + delay;
          while (!signal.aborted && Date.now() < until) {
            job = await this.reconcile();
            if (isTerminalJobStatus(job.status)) break;
            await wait(Math.min(2_000, Math.max(0, until - Date.now())), signal);
          }
        }
      }
      if (!signal.aborted) await this.reconcile();
    } catch (error) {
      if (!isAbortError(error) && !signal.aborted) {
        this.callbacks.onTransport('stopped');
        this.callbacks.onError(error);
      }
    }
  }

  private async reconcile(): Promise<JobResource> {
    const job = await this.client.getJob(this.jobId, this.controller.signal);
    this.callbacks.onJob(job);
    return job;
  }
}
