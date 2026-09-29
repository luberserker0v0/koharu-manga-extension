import type { JobResource } from '../api/types';

export const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'blocked']);
export const WAITING_JOB_STATES = new Set([
  'queued',
  'waiting_dependency',
  'waiting_pipeline',
  'waiting_prerequisite',
  'waiting_koharu_review',
]);

export type NormalizedJobState =
  | 'queued'
  | 'waiting'
  | 'running'
  | 'canceling'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'blocked'
  | 'unavailable';

export interface JobStateView {
  state: NormalizedJobState;
  terminal: boolean;
  successful: boolean;
  waiting: boolean;
  actionableError: string | null;
}

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function normalizeJobState(job: Pick<JobResource, 'status' | 'stage' | 'error' | 'blockedReason'>): JobStateView {
  const effectiveWaiting = WAITING_JOB_STATES.has(job.status) || WAITING_JOB_STATES.has(job.stage);
  if (job.status === 'succeeded') {
    return { state: 'completed', terminal: true, successful: true, waiting: false, actionableError: null };
  }
  if (job.status === 'failed') {
    return { state: 'failed', terminal: true, successful: false, waiting: false, actionableError: job.error };
  }
  if (job.status === 'canceled') {
    return { state: 'canceled', terminal: true, successful: false, waiting: false, actionableError: null };
  }
  if (job.status === 'blocked') {
    return {
      state: 'blocked',
      terminal: true,
      successful: false,
      waiting: false,
      actionableError: job.blockedReason || job.error,
    };
  }
  if (job.status === 'cancel_requested') {
    return { state: 'canceling', terminal: false, successful: false, waiting: true, actionableError: null };
  }
  if (job.status === 'queued') {
    return { state: 'queued', terminal: false, successful: false, waiting: true, actionableError: null };
  }
  if (effectiveWaiting) {
    return { state: 'waiting', terminal: false, successful: false, waiting: true, actionableError: null };
  }
  if (job.status === 'running') {
    return { state: 'running', terminal: false, successful: false, waiting: false, actionableError: null };
  }
  return { state: 'unavailable', terminal: false, successful: false, waiting: false, actionableError: job.error };
}

export function firstFailedChild(job: JobResource): JobResource | null {
  const children = Array.isArray(job.children) ? job.children : [];
  return children.find((child) => child.status === 'failed' || child.status === 'blocked') ?? null;
}
