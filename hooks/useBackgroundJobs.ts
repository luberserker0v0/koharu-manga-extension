import { useEffect, useRef } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import { JobMonitor } from '../lib/api/job-monitor';
import type { JobResource } from '../lib/api/types';
import { isTerminalJobStatus } from '../lib/domain/job-state';
import type { StoredBackgroundTask } from '../lib/text-regions/workspace';

export function useBackgroundJobs(
  client: BackendClient | null,
  tasks: StoredBackgroundTask[] | undefined,
  onJob: (job: JobResource) => void | Promise<void>,
): void {
  const onJobRef = useRef(onJob);
  onJobRef.current = onJob;
  const activeKey = (tasks ?? [])
    .filter((task) => !isTerminalJobStatus(task.status))
    .map((task) => task.jobId)
    .sort()
    .join('|');

  useEffect(() => {
    if (!client || !activeKey) return;
    const monitors = activeKey.split('|').map((jobId) => {
      const monitor = new JobMonitor(client, jobId, {
        onJob: (job) => { void onJobRef.current(job); },
        onEvent: () => {},
        onTransport: () => {},
        onError: () => {},
      });
      void monitor.start();
      return monitor;
    });
    return () => monitors.forEach((monitor) => monitor.stop());
  }, [activeKey, client]);
}
