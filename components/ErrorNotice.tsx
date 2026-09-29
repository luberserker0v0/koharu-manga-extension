import { BackendApiError, BackendNetworkError, isAbortError } from '../lib/api/errors';
import { optionalMessage, t } from '../lib/i18n';
import { ComicCrawlerError } from '../lib/comic-crawler/errors';

function presentError(error: unknown): string {
  if (!error) return '';
  if (isAbortError(error)) return t('errorUploadCanceled');
  if (error instanceof BackendApiError) {
    const requestId = error.requestId ? t('requestIdDetail', error.requestId) : '';
    return t('backendErrorDetail', [String(error.status), error.message, requestId]);
  }
  if (error instanceof BackendNetworkError) return t('errorBackendUnreachable');
  if (error instanceof ComicCrawlerError) return t(`error_comicCrawler_${error.kind}`);
  if (error instanceof Error) {
    const known = optionalMessage(`error_${error.message}`);
    return known || error.message;
  }
  return t('errorUnknown');
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice notice-error" role="alert">{presentError(error)}</div>;
}
