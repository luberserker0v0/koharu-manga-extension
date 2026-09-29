export function normalizeApiBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('unsupported_protocol');
  }
  if (!url.pathname.endsWith('/api/v1')) {
    throw new Error('versioned_route_required');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function healthUrlFromApiBase(baseUrl: string): string {
  const url = new URL(normalizeApiBaseUrl(baseUrl));
  url.pathname = url.pathname.replace(/\/api\/v1$/, '/health');
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function originPermissionPattern(baseUrl: string): string {
  const url = new URL(normalizeApiBaseUrl(baseUrl));
  return `${url.protocol}//${url.host}/*`;
}

export function normalizeServiceBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function serviceOriginPermissionPattern(baseUrl: string): string {
  const url = new URL(normalizeServiceBaseUrl(baseUrl));
  return `${url.protocol}//${url.host}/*`;
}
