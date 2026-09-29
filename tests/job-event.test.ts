import { describe, expect, it } from 'vitest';
import { presentJobEvent } from '../lib/domain/job-event';

describe('job event presentation', () => {
  it('turns a stage event into readable metadata', () => {
    expect(presentJobEvent({
      id: 12,
      type: 'job.stage',
      createdAt: '2026-01-01T00:00:00Z',
      payload: { stage: 'translate', progress: 42, message: 'Translating page 6' },
    })).toEqual({
      titleKey: 'jobEventType_job_stage',
      tone: 'progress',
      message: 'Translating page 6',
      metadata: [
        { kind: 'stage', value: 'translate' },
        { kind: 'progress', value: '42%' },
      ],
    });
  });

  it('preserves actionable failure text and child-job identity', () => {
    const view = presentJobEvent({
      type: 'child_job.failed',
      createdAt: '2026-01-01T00:00:00Z',
      payload: { childJobId: 'child-7', error: 'OCR process exited unexpectedly' },
    });
    expect(view).toMatchObject({
      titleKey: 'jobEventType_child_job_failed',
      tone: 'error',
      message: 'OCR process exited unexpectedly',
      metadata: [{ kind: 'child', value: 'child-7' }],
    });
  });

  it('creates a safe localization key for unknown backend event types', () => {
    expect(presentJobEvent({ type: 'vendor/custom event', createdAt: '2026-01-01T00:00:00Z' }).titleKey)
      .toBe('jobEventType_vendor_custom_event');
  });

  it('converts backend progress ratios to percentages', () => {
    expect(presentJobEvent({
      type: 'job.progress', createdAt: '2026-01-01T00:00:00Z', payload: { progress: 1 },
    }).metadata).toContainEqual({ kind: 'progress', value: '100%' });
    expect(presentJobEvent({
      type: 'job.progress', createdAt: '2026-01-01T00:00:00Z', payload: { progress: 0.425 },
    }).metadata).toContainEqual({ kind: 'progress', value: '42.5%' });
  });

  it('keeps explicitly named percent fields on the zero-to-100 scale', () => {
    expect(presentJobEvent({
      type: 'job.progress', createdAt: '2026-01-01T00:00:00Z', payload: { percent: 1 },
    }).metadata).toContainEqual({ kind: 'progress', value: '1%' });
  });
});
