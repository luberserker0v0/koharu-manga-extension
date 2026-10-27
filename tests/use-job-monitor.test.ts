import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useJobMonitor } from '../hooks/useJobMonitor';
import type { BackendClient } from '../lib/api/backend-client';
import { BackendApiError } from '../lib/api/errors';

afterEach(cleanup);

describe('useJobMonitor missing-job cleanup', () => {
  it('automatically discards a locally restored job when the backend returns 404', async () => {
    const missing = new BackendApiError({
      message: 'Not found', status: 404, method: 'GET', path: '/jobs/job-missing',
    });
    const client = { getJob: vi.fn().mockRejectedValue(missing) } as unknown as BackendClient;
    const discard = vi.fn();

    const { result } = renderHook(() => useJobMonitor(client, 'job-missing', discard));

    await waitFor(() => expect(discard).toHaveBeenCalledOnce());
    expect(result.current.monitorError).toBeNull();
    expect(result.current.transport).toBe('stopped');
  });

  it('keeps non-404 monitoring failures visible instead of deleting local history', async () => {
    const unavailable = new BackendApiError({
      message: 'Unavailable', status: 503, method: 'GET', path: '/jobs/job-1',
    });
    const client = { getJob: vi.fn().mockRejectedValue(unavailable) } as unknown as BackendClient;
    const discard = vi.fn();

    const { result } = renderHook(() => useJobMonitor(client, 'job-1', discard));

    await waitFor(() => expect(result.current.monitorError).toBe(unavailable));
    expect(discard).not.toHaveBeenCalled();
  });
});
