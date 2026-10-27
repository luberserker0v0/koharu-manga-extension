import { useEffect, useMemo, useState } from 'react';
import type { BackendClient } from '../lib/api/backend-client';
import { JobMonitor, type MonitorTransport } from '../lib/api/job-monitor';
import { BackendApiError } from '../lib/api/errors';
import type { JobArtifact, JobEvent, JobResource } from '../lib/api/types';
import { isTerminalJobStatus } from '../lib/domain/job-state';

export function useJobMonitor(
  client: BackendClient | null,
  jobId: string | null,
  onMissingJob?: () => void | Promise<void>,
) {
  const [job, setJob] = useState<JobResource | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [artifacts, setArtifacts] = useState<JobArtifact[]>([]);
  const [transport, setTransport] = useState<MonitorTransport>('stopped');
  const [monitorError, setMonitorError] = useState<unknown>(null);

  useEffect(() => {
    setJob(null);
    setEvents([]);
    setArtifacts([]);
    setMonitorError(null);
    if (!client || !jobId) return;

    let disposed = false;
    const loadTerminalDetails = async () => {
      const [eventEnvelope, artifactEnvelope] = await Promise.all([
        client.getEvents(jobId),
        client.getArtifacts(jobId),
      ]);
      if (!disposed) {
        setEvents(eventEnvelope.events);
        setArtifacts(artifactEnvelope.artifacts);
      }
    };
    const monitor = new JobMonitor(client, jobId, {
      onJob: (next) => {
        if (disposed) return;
        setJob(next);
        if (isTerminalJobStatus(next.status)) void loadTerminalDetails().catch(setMonitorError);
      },
      onEvent: (event) => {
        if (disposed) return;
        setEvents((current) => {
          const key = `${event.createdAt}:${event.type}`;
          return current.some((item) => `${item.createdAt}:${item.type}` === key)
            ? current
            : [...current, event];
        });
      },
      onTransport: (next) => { if (!disposed) setTransport(next); },
      onError: (error) => {
        if (disposed) return;
        if (error instanceof BackendApiError && error.status === 404 && onMissingJob) {
          void Promise.resolve(onMissingJob()).catch(() => {
            if (!disposed) setMonitorError(error);
          });
          return;
        }
        setMonitorError(error);
      },
    });
    void monitor.start();
    return () => {
      disposed = true;
      monitor.stop();
    };
  }, [client, jobId, onMissingJob]);

  return useMemo(() => ({ job, events, artifacts, transport, monitorError }), [job, events, artifacts, transport, monitorError]);
}
