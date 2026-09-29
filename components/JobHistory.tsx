import { useEffect, useState } from 'react';
import { formatLocalDate, t } from '../lib/i18n';
import {
  clearWorkflowHistory,
  loadWorkflowHistory,
  removeWorkflowHistoryItem,
  WORKFLOW_HISTORY_KEY,
  type StoredWorkflow,
} from '../lib/storage/workflow';

export function JobHistory({ activeJobId, onOpen }: { activeJobId?: string; onOpen: (workflow: StoredWorkflow) => void }) {
  const [items, setItems] = useState<StoredWorkflow[]>([]);

  useEffect(() => {
    const refresh = () => void loadWorkflowHistory().then(setItems);
    refresh();
    const listener = (changes: Record<string, Browser.storage.StorageChange>) => {
      if (WORKFLOW_HISTORY_KEY in changes) refresh();
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);

  const removeItem = async (jobId: string) => {
    await removeWorkflowHistoryItem(jobId);
    setItems((current) => current.filter((item) => item.jobId !== jobId));
  };

  const clearAll = async () => {
    if (!window.confirm(t('clearJobHistoryConfirm'))) return;
    await clearWorkflowHistory();
    setItems([]);
  };

  return (
    <details className="panel history-panel">
      <summary>{t('jobHistoryTitle')} <span className="count-badge">{items.length}</span></summary>
      {items.length === 0 ? <div className="empty-state">{t('jobHistoryEmpty')}</div> : (
        <>
          <div className="history-toolbar">
            <small>{t('jobHistoryLocalOnly')}</small>
            <button type="button" onClick={() => void clearAll()}>{t('clearJobHistory')}</button>
          </div>
          <ul className="history-list">
            {items.map((item) => (
              <li key={item.jobId}>
                <span>
                  <strong>{item.sourcePageUrl || t('notAvailable')}</strong>
                  <small>{formatLocalDate(item.updatedAt)}</small>
                  <small title={item.jobId}>{t('jobIdLabel')}: {item.jobId}</small>
                </span>
                <div className="history-actions">
                  <button type="button" disabled={item.jobId === activeJobId} onClick={() => onOpen(item)}>{item.jobId === activeJobId ? t('currentJob') : t('openJob')}</button>
                  <button className="history-remove" type="button" aria-label={t('removeJobHistory')} title={t('removeJobHistory')} onClick={() => void removeItem(item.jobId!)}>×</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
