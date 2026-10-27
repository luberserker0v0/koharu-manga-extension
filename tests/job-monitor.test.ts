import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { BackendApiError } from '../lib/api/errors';
import { consumeMessageEventStream, JobMonitor } from '../lib/api/job-monitor';
import type { BackendClient } from '../lib/api/backend-client';

describe('message-envelope SSE parsing', () => {
  it('parses split chunks and ignores heartbeat comments', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': heartbeat\n\ndata: {"type":"job.stage","createdAt":"2026-01-01T00:00:00Z","pay'));
        controller.enqueue(encoder.encode('load":{"stage":"translate"}}\n\n'));
        controller.close();
      },
    });
    const response = new Response(body, { status: 200 });
    const events: unknown[] = [];

    await consumeMessageEventStream(response, (event) => events.push(event));
    expect(events).toEqual([{
      type: 'job.stage',
      createdAt: '2026-01-01T00:00:00Z',
      payload: { stage: 'translate' },
    }]);
  });

  it('stops reconnecting when initial authoritative reconciliation returns a fatal error', async () => {
    const error = new BackendApiError({
      message: 'Not found', status: 404, method: 'GET', path: '/jobs/missing-job',
    });
    const client = { getJob: vi.fn().mockRejectedValue(error) } as unknown as BackendClient;
    const onError = vi.fn();
    const onTransport = vi.fn();
    const monitor = new JobMonitor(client, 'missing-job', {
      onJob: vi.fn(), onEvent: vi.fn(), onError, onTransport,
    });

    await monitor.start();

    expect(onError).toHaveBeenCalledWith(error);
    expect(onTransport).toHaveBeenLastCalledWith('stopped');
  });
});
