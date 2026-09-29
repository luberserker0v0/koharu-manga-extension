export interface HostPermissionApi {
  contains(permissions: { origins: string[] }): Promise<boolean>;
  request(permissions: { origins: string[] }): Promise<boolean>;
}

export function pageOriginPattern(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return `${url.protocol}//${url.host}/*`;
  } catch { return null; }
}

export async function ensurePageAccess(rawUrl: string, api: HostPermissionApi): Promise<'granted' | 'denied' | 'unsupported'> {
  const pattern = pageOriginPattern(rawUrl);
  if (!pattern) return 'unsupported';
  if (await api.contains({ origins: [pattern] })) return 'granted';
  return await api.request({ origins: [pattern] }) ? 'granted' : 'denied';
}
