import type { JobStateView } from '../lib/domain/job-state';
import { t } from '../lib/i18n';

export function StatusPill({ view }: { view: JobStateView }) {
  return <span className={`status-pill status-${view.state}`}>{t(`jobState_${view.state}`)}</span>;
}
