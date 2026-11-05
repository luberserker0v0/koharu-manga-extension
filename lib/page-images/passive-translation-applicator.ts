import type { PageImageCandidate } from './types';

export interface PassiveSourcePage {
  pageId: string;
  sourceImageId: string;
}

export interface PassiveApplicationProgress {
  completed: number;
  total: number;
}

interface PassiveApplicatorOptions {
  pages: PassiveSourcePage[];
  concurrency?: number;
  resolveTranslatedUrl: (sourceImageId: string) => Promise<string>;
  apply: (candidate: PageImageCandidate, translatedUrl: string) => Promise<boolean>;
  onProgress?: (progress: PassiveApplicationProgress) => void;
}

interface PendingApplication {
  page: PassiveSourcePage;
  candidate: PageImageCandidate;
}

export class PassiveTranslationApplicator {
  readonly completion: Promise<void>;
  private readonly pageById = new Map<string, PassiveSourcePage>();
  private readonly concurrency: number;
  private readonly queue: PendingApplication[] = [];
  private readonly scheduledPageIds = new Set<string>();
  private readonly appliedPageIds = new Set<string>();
  private active = 0;
  private stopped = false;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: unknown) => void;

  constructor(private readonly options: PassiveApplicatorOptions) {
    if (!options.pages.length) throw new Error('artifact_image_count_mismatch');
    this.concurrency = Math.max(1, Math.min(6, options.concurrency ?? 2));
    const sourceImageIds = new Set<string>();
    for (const page of options.pages) {
      if (!page.pageId || !page.sourceImageId || this.pageById.has(page.pageId)
        || sourceImageIds.has(page.sourceImageId)) throw new Error('source_page_manifest_invalid');
      this.pageById.set(page.pageId, page);
      sourceImageIds.add(page.sourceImageId);
    }
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.reportProgress();
  }

  offerResolved(pageId: string, candidate: PageImageCandidate): void {
    if (this.stopped || candidate.loadStatus !== 'loaded') return;
    const page = this.pageById.get(pageId);
    if (!page || this.scheduledPageIds.has(page.pageId)) return;
    this.scheduledPageIds.add(page.pageId);
    this.queue.push({ page, candidate });
    this.pump();
  }

  stop(reason: unknown = new DOMException('Aborted', 'AbortError')): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    this.rejectCompletion(reason);
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.queue.length) {
      const pending = this.queue.shift()!;
      this.active += 1;
      void this.process(pending).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async process({ page, candidate }: PendingApplication): Promise<void> {
    try {
      const url = await this.options.resolveTranslatedUrl(page.sourceImageId);
      if (!await this.options.apply(candidate, url)) throw new Error('inline_replacement_incomplete');
      this.appliedPageIds.add(page.pageId);
      this.reportProgress();
      if (this.appliedPageIds.size === this.options.pages.length) {
        this.stopped = true;
        this.resolveCompletion();
      }
    } catch (error) {
      if (!this.stopped) {
        this.stopped = true;
        this.queue.length = 0;
        this.rejectCompletion(error);
      }
    }
  }

  private reportProgress(): void {
    this.options.onProgress?.({ completed: this.appliedPageIds.size, total: this.options.pages.length });
  }
}
