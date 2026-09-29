import { describe, expect, it } from 'vitest';
import { consumeMessageEventStream } from '../lib/api/job-monitor';

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
});
