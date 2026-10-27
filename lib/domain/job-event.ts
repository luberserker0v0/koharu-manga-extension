import type { JobEvent } from '../api/types';

export type JobEventTone = 'neutral' | 'progress' | 'waiting' | 'success' | 'error';

export interface JobEventMeta {
  kind: 'stage' | 'status' | 'progress' | 'child';
  value: string;
}

export interface JobEventView {
  titleKey: string;
  tone: JobEventTone;
  message: string | null;
  metadata: JobEventMeta[];
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function firstText(source: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(source?.[key]);
    if (value) return value;
  }
  return null;
}

function typeKey(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.trim().replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

function progressText(payload: Record<string, unknown>): string | null {
  const explicitPercent = numeric(payload.percent ?? payload.progressPercent);
  if (explicitPercent !== null) return formatPercent(explicitPercent);
  const ratio = numeric(payload.progress);
  if (ratio !== null) return formatPercent(ratio >= 0 && ratio <= 1 ? ratio * 100 : ratio);
  const current = firstText(payload, ['currentPageIndex', 'completedPages', 'current', 'completed', 'processed']);
  const total = firstText(payload, ['totalPages', 'total', 'count']);
  return current && total ? `${current}/${total}` : null;
}

function eventTone(type: string, status: string | null): JobEventTone {
  const combined = `${type} ${status ?? ''}`.toLowerCase();
  if (/fail|error|block/.test(combined)) return 'error';
  if (/succeed|complete|finish/.test(combined)) return 'success';
  if (/wait|queue|pending|cancel_request/.test(combined)) return 'waiting';
  if (/progress|stage|start|running/.test(combined)) return 'progress';
  return 'neutral';
}

export function presentJobEvent(event: JobEvent): JobEventView {
  const payload = event.payload ?? {};
  const stage = firstText(payload, ['stage', 'currentStage']) ?? text(event.job?.stage);
  const status = firstText(payload, ['status', 'jobStatus']) ?? text(event.job?.status);
  const child = firstText(payload, ['childJobId', 'childId', 'dependencyId']);
  const progress = progressText(payload);
  const metadata: JobEventMeta[] = [];
  if (stage) metadata.push({ kind: 'stage', value: stage });
  if (status) metadata.push({ kind: 'status', value: status });
  if (progress) metadata.push({ kind: 'progress', value: progress });
  if (child) metadata.push({ kind: 'child', value: child });
  const message = firstText(payload, ['message', 'error', 'reason', 'detail', 'description'])
    ?? text(event.job?.error)
    ?? text(event.job?.blockedReason);
  return {
    titleKey: `jobEventType_${typeKey(event.type) || 'unknown'}`,
    tone: eventTone(event.type, status),
    message,
    metadata,
  };
}
