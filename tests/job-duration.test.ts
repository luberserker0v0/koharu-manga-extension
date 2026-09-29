import { describe, expect, it } from 'vitest';
import { durationParts, jobDurationMilliseconds } from '../lib/domain/job-duration';

describe('job duration', () => {
  it('uses the final update time for terminal jobs', () => {
    const duration = jobDurationMilliseconds(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:12:34.000Z',
      true,
      new Date('2026-01-02T00:00:00.000Z').getTime(),
    );
    expect(duration).toBe(754_000);
    expect(durationParts(duration!)).toEqual({ hours: 0, minutes: 12, seconds: 34 });
  });

  it('uses the current time while a job is active', () => {
    expect(jobDurationMilliseconds(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:10.000Z',
      false,
      new Date('2026-01-01T01:05:09.000Z').getTime(),
    )).toBe(3_909_000);
  });

  it('returns no duration for malformed timestamps', () => {
    expect(jobDurationMilliseconds('invalid', 'invalid', true)).toBeNull();
  });
});
