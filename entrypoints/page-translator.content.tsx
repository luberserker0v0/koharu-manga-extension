import React from 'react';
import ReactDOM from 'react-dom/client';
import { PageTranslatorApp } from '../components/PageTranslatorApp';
import { BackendClient } from '../lib/api/backend-client';
import { orderedTranslatedImages } from '../lib/artifacts/translated-images';
import type { PageDomBridge } from '../lib/page-images/bridge';
import { findCandidateElement, GenericDomImageDetector } from '../lib/page-images/generic-dom-detector';
import { loadApiSettings } from '../lib/storage/settings';
import { optionalMessage } from '../lib/i18n';
import { isExtensionContextInvalidated } from '../lib/extension-context';
import './popup/style.css';
import '../assets/page-translator.css';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  cssInjectionMode: 'ui',
  async main(ctx) {
    const pageWindow = window as typeof window & { __koharuMangaCompanionMounted__?: boolean };
    if (pageWindow.__koharuMangaCompanionMounted__) return;
    const suppressInvalidatedRejection = (event: PromiseRejectionEvent) => {
      if (isExtensionContextInvalidated(event.reason)) event.preventDefault();
    };
    window.addEventListener('unhandledrejection', suppressInvalidatedRejection);
    pageWindow.__koharuMangaCompanionMounted__ = true;

    const detector = new GenericDomImageDetector();
    const replacements = new Map<HTMLImageElement, { src: string; srcset: string; sizes: string }>();

    const bridge: PageDomBridge = {
      detect: (deep, signal) => detector.detect(location.href, { deep, signal }),
      async apply(candidate, url) {
        const element = findCandidateElement(candidate);
        if (!element) return false;
        if (!replacements.has(element)) {
          replacements.set(element, { src: element.src, srcset: element.srcset, sizes: element.sizes });
        }
        element.srcset = '';
        element.src = url;
        return true;
      },
      async restore() {
        for (const [element, original] of replacements) {
          element.src = original.src;
          element.srcset = original.srcset;
          element.sizes = original.sizes;
        }
        replacements.clear();
      },
      async setLayout() {
        // The modal ShadowRoot container always covers the viewport; its root
        // disables pointer events while the FAB and drawer opt back in.
      },
    };

    const applyTranslatedImages = async (urls: string[]) => {
      const detected = await detector.detect(location.href, { deep: true });
      const candidates = detected.images.filter((image) => image.selected && image.loadStatus === 'loaded');
      if (urls.length !== candidates.length) throw new Error('artifact_image_count_mismatch');
      for (let index = 0; index < candidates.length; index += 1) {
        if (!await bridge.apply(candidates[index]!, urls[index]!)) {
          await bridge.restore();
          throw new Error('inline_replacement_incomplete');
        }
      }
    };

    const applyTranslationJob = async (jobId: string, expectedCount: number) => {
      const client = new BackendClient(await loadApiSettings(), { useBackgroundProxy: true });
      const manifest = await client.getTranslatedImages(jobId);
      const images = orderedTranslatedImages(manifest, expectedCount);
      const blobs = await Promise.all(images.map((image) => client.downloadTranslatedImage(jobId, image)));
      const urls = await Promise.all(blobs.map((blob) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result)));
        reader.addEventListener('error', () => reject(reader.error ?? new Error('artifact_read_failed')));
        reader.readAsDataURL(blob);
      })));
      await applyTranslatedImages(urls);
      return urls.length;
    };

    const runtimeListener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return undefined;
      if (message.type === 'KOHARU_PAGE_PING') return Promise.resolve({ ok: true, url: location.href });
      if (message.type === 'RESTORE_PAGE_IMAGES') return bridge.restore().then(() => ({ ok: true }));
      if (message.type === 'APPLY_TRANSLATION_JOB') {
        const jobId = 'jobId' in message && typeof message.jobId === 'string' ? message.jobId : '';
        const expectedCount = 'expectedCount' in message && typeof message.expectedCount === 'number' ? message.expectedCount : 0;
        return applyTranslationJob(jobId, expectedCount)
          .then((applied) => ({ ok: true, applied }))
          .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'inline_replacement_incomplete' }));
      }
      if (message.type !== 'APPLY_TRANSLATED_IMAGES') return undefined;
      const urls = 'urls' in message && Array.isArray(message.urls)
        ? message.urls.filter((url): url is string => typeof url === 'string')
        : [];
      return applyTranslatedImages(urls)
        .then(() => ({ ok: true, applied: urls.length }))
        .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'inline_replacement_incomplete' }));
    };
    browser.runtime.onMessage.addListener(runtimeListener);

    try {
      const ui = await createShadowRootUi(ctx, {
        name: 'koharu-manga-companion',
        position: 'modal',
        zIndex: 2147483647,
        isolateEvents: true,
        inheritStyles: true,
        onMount(container, _shadow, shadowHost) {
          shadowHost.style.setProperty('position', 'relative', 'important');
          shadowHost.style.setProperty('display', 'block', 'important');
          shadowHost.style.setProperty('width', '0', 'important');
          shadowHost.style.setProperty('height', '0', 'important');
          shadowHost.style.setProperty('z-index', '2147483647', 'important');
          container.style.setProperty('position', 'fixed', 'important');
          container.style.setProperty('inset', '0', 'important');
          container.style.setProperty('pointer-events', 'none', 'important');
          container.lang = optionalMessage('htmlLanguage') || 'en';
          const rootElement = document.createElement('div');
          rootElement.id = 'root';
          container.append(rootElement);
          const root = ReactDOM.createRoot(rootElement);
          root.render(<React.StrictMode><PageTranslatorApp domBridge={bridge} /></React.StrictMode>);
          return root;
        },
        onRemove(root) {
          root?.unmount();
        },
      });
      ui.mount();
      ctx.onInvalidated(() => {
        try { browser.runtime.onMessage.removeListener(runtimeListener); } catch { /* invalidated */ }
        ui.remove();
        pageWindow.__koharuMangaCompanionMounted__ = false;
      });
    } catch (error) {
      try { browser.runtime.onMessage.removeListener(runtimeListener); } catch { /* invalidated */ }
      pageWindow.__koharuMangaCompanionMounted__ = false;
      if (isExtensionContextInvalidated(error)) return;
      window.removeEventListener('unhandledrejection', suppressInvalidatedRejection);
      throw error;
    }
  },
});
