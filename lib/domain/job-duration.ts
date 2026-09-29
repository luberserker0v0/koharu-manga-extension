export interface DurationParts {
  hours: number;
  minutes: number;
  seconds: number;
}

export function jobDurationMilliseconds(
  createdAt: string,
  updatedAt: string,
  terminal: boolean,
  now = Date.now(),
): number | null {
  const start = new Date(createdAt).getTime();
  const terminalEnd = new Date(updatedAt).getTime();
  if (!Number.isFinite(start) || (terminal && !Number.isFinite(terminalEnd))) return null;
  return Math.max(0, (terminal ? terminalEnd : now) - start);
}

export function durationParts(milliseconds: number): DurationParts {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}
