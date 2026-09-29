import { describe, expect, it } from 'vitest';
import { firstFailedChild, isTerminalJobStatus, normalizeJobState } from '../lib/domain/job-state';
import type { JobResource } from '../lib/api/types';

function job(overrides: Partial<JobResource>): JobResource {
  return {
    id: 'job-1',
    type: 'translation',
    status: 'queued',
    stage: 'queued',
    result: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('job state normalization', () => {
  it.each(['succeeded', 'failed', 'canceled', 'blocked'])('recognizes %s as terminal', (status) => {
    expect(isTerminalJobStatus(status)).toBe(true);
  });

  it.each([
    ['waiting_dependency', 'waiting_dependency'],
    ['running', 'waiting_prerequisite'],
    ['running', 'waiting_koharu_review'],
    ['running', 'waiting_pipeline'],
  ])('treats %s / %s as waiting rather than failed', (status, stage) => {
    const view = normalizeJobState(job({ status, stage }));
    expect(view.state).toBe('waiting');
    expect(view.waiting).toBe(true);
    expect(view.terminal).toBe(false);
    expect(view.actionableError).toBeNull();
  });

  it('preserves the actionable failure', () => {
    const view = normalizeJobState(job({ status: 'failed', error: 'Koharu operation failed.' }));
    expect(view.state).toBe('failed');
    expect(view.actionableError).toBe('Koharu operation failed.');
  });

  it('uses the blocking reason for a blocked job', () => {
    const view = normalizeJobState(job({ status: 'blocked', blockedReason: 'Dependency unavailable.' }));
    expect(view.state).toBe('blocked');
    expect(view.actionableError).toBe('Dependency unavailable.');
  });

  it('returns the earliest failed or blocked child', () => {
    const first = job({ id: 'child-1', status: 'failed', error: 'First failure' });
    const second = job({ id: 'child-2', status: 'blocked', blockedReason: 'Later block' });
    expect(firstFailedChild(job({ children: [first, second] }))).toBe(first);
  });
});
