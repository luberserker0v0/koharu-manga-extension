import { useState } from 'react';
import type { ComicCrawlerClient } from '../lib/comic-crawler/client';
import type { AdapterDiscoveryFeature } from '../lib/comic-crawler/types';
import { t } from '../lib/i18n';
import type { DetectionResult } from '../lib/page-images/types';
import { ErrorNotice } from './ErrorNotice';

export function AdapterDiscoveryPanel({ client, pageUrl, result }: {
  client: ComicCrawlerClient | null;
  pageUrl: string;
  result: DetectionResult;
}) {
  const [feature, setFeature] = useState<AdapterDiscoveryFeature>('specific_chapters');
  const [queueing, setQueueing] = useState(false);
  const [discoveryId, setDiscoveryId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (!client || !result.discoveryAvailable) return null;

  const queueDiscovery = async () => {
    if (!confirm(t('confirmAdapterDiscovery'))) return;
    setQueueing(true);
    setError(null);
    try {
      const queued = await client.queueDiscovery(pageUrl, feature);
      setDiscoveryId(queued.discoveryId);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setQueueing(false);
    }
  };

  return (
    <section className="adapter-discovery-panel">
      <div className="notice notice-waiting">
        {result.adapterStatus === 'capability_mismatch'
          ? t('adapterCapabilityMismatch')
          : t('adapterNotFound')}
      </div>
      <label>
        <span>{t('adapterFeatureLabel')}</span>
        <select value={feature} onChange={(event) => setFeature(event.target.value as AdapterDiscoveryFeature)}>
          <option value="specific_chapters">{t('adapterFeatureSpecificChapters')}</option>
        </select>
      </label>
      <div className="adapter-target">
        <span>{t('adapterTargetPageLabel')}</span>
        <code title={pageUrl}>{pageUrl}</code>
      </div>
      <p className="field-help">{t('adapterDiscoveryReviewHelp')}</p>
      <ErrorNotice error={error} />
      {discoveryId ? (
        <div className="notice notice-success">{t('discoveryQueued', discoveryId)}</div>
      ) : (
        <button className="secondary-button" type="button" disabled={queueing} onClick={() => void queueDiscovery()}>
          {queueing ? t('queueingAdapterDiscovery') : t('requestAdapter')}
        </button>
      )}
    </section>
  );
}
