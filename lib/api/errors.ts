export class BackendApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly requestId: string | null;
  readonly detail: unknown;

  constructor(options: {
    message: string;
    status: number;
    method: string;
    path: string;
    requestId?: string | null;
    detail?: unknown;
  }) {
    super(options.message);
    this.name = 'BackendApiError';
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.requestId = options.requestId ?? null;
    this.detail = options.detail;
  }
}

export class BackendNetworkError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'BackendNetworkError';
    this.cause = cause;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
