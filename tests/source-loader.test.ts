import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCandidateFiles, requiredSourceOrigins } from '../lib/page-images/source-loader';
import type { PageImageCandidate } from '../lib/page-images/types';

afterEach(() => vi.unstubAllGlobals());

function candidate(id: string, order: number): PageImageCandidate {
  return {
    id,
    order,
    sourceUrl: `https://cdn.example/${id}.jpg`,
    fileName: `${id}.jpg`,
    width: 800,
    height: 1200,
    origin: 'comic_crawler',
    loadStatus: 'loaded',
    selected: true,
  };
}

describe('page source loading', () => {
  it('preserves reviewed order when creating upload files', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: btoa('\u0001\u0002\u0003'), contentType: 'image/jpeg' });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    const files = await loadCandidateFiles([candidate('page-b', 0), candidate('page-a', 1)]);
    expect(files.map((file) => file.name)).toEqual(['page-b.jpg', 'page-a.jpg']);
    expect(sendMessage.mock.calls.map((call) => call[0].url)).toEqual([
      'https://cdn.example/page-b.jpg',
      'https://cdn.example/page-a.jpg',
    ]);
  });

  it('deduplicates the optional host permissions needed for DOM sources', async () => {
    const first = { ...candidate('a', 0), origin: 'dom' as const };
    const second = { ...candidate('b', 1), origin: 'dom' as const };
    expect(await requiredSourceOrigins([first, second])).toEqual(['https://cdn.example/*']);
  });
});
