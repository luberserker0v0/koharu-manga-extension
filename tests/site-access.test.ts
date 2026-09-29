import { describe, expect, it, vi } from 'vitest';
import { ensurePageAccess, pageOriginPattern, type HostPermissionApi } from '../lib/page-images/site-access';

describe('site access', () => {
  it('creates a narrow origin pattern and rejects restricted pages', () => {
    expect(pageOriginPattern('https://reader.example/chapter/1')).toBe('https://reader.example/*');
    expect(pageOriginPattern('chrome://extensions')).toBeNull();
  });

  it('does not reprompt when access is already granted', async () => {
    const api: HostPermissionApi = { contains: vi.fn().mockResolvedValue(true), request: vi.fn() };
    expect(await ensurePageAccess('https://reader.example/1', api)).toBe('granted');
    expect(api.request).not.toHaveBeenCalled();
  });

  it('reports denied and supports a later re-request after revocation', async () => {
    const api: HostPermissionApi = {
      contains: vi.fn().mockResolvedValue(false),
      request: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    };
    expect(await ensurePageAccess('https://reader.example/1', api)).toBe('denied');
    expect(await ensurePageAccess('https://reader.example/1', api)).toBe('granted');
  });
});
