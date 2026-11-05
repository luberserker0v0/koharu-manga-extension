import React from 'react';
import ReactDOM from 'react-dom/client';
import { PageTranslatorApp } from '../components/PageTranslatorApp';
import type { PageDomBridge } from '../lib/page-images/bridge';
import { findCandidateElement, findCandidateTarget, findCandidateTargets, GenericDomImageDetector } from '../lib/page-images/generic-dom-detector';
import { isDocumentFullscreen } from '../lib/page-images/fullscreen';
import { PageNumberOverlay } from '../lib/page-images/page-number-overlay';
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
    const pageNumberOverlay = new PageNumberOverlay(findCandidateTargets);
    type SavedState =
      | { kind: 'img'; src: string; srcset: string; sizes: string }
      | { kind: 'canvas'; dataUrl: string | null }
      | { kind: 'video'; poster: string | null }
      | { kind: 'css'; backgroundImage: string };
    const replacements = new Map<Element, SavedState>();
    const notifyReplacementState = (applied: boolean) => {
      void browser.runtime.sendMessage({
        type: 'PAGE_TRANSLATION_STATE_CHANGED',
        url: location.href,
        applied,
      }).catch(() => {
        // The popup is normally closed, so there may be no extension-page listener.
      });
    };

    const loadImage = (url: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('inline_replacement_incomplete'));
      image.src = url;
    });

    const bridge: PageDomBridge = {
      detect: (deep, signal, preserveDuplicateUrls) => detector.detect(location.href, {
        deep,
        signal,
        preserveDuplicateUrls,
      }),
      async apply(candidate, url) {
        const target = findCandidateTarget(candidate) ?? findCandidateElement(candidate);
        if (!target) return false;
        const wasApplied = replacements.size > 0;
        const targetWasReplaced = replacements.has(target);
        const kind = candidate.targetKind
          ?? (target instanceof HTMLCanvasElement ? 'canvas' : undefined)
          ?? (target instanceof HTMLVideoElement ? 'video' : undefined)
          ?? 'img';
        if (target instanceof HTMLImageElement && (kind === 'img' || kind === undefined)) {
          if (!replacements.has(target)) {
            replacements.set(target, { kind: 'img', src: target.src, srcset: target.srcset, sizes: target.sizes });
          }
          target.srcset = '';
          target.src = url;
          if (!wasApplied) notifyReplacementState(true);
          return true;
        }
        if (target instanceof HTMLCanvasElement && kind === 'canvas') {
          const context = target.getContext('2d');
          if (!context) return false;
          if (!replacements.has(target)) {
            let dataUrl: string | null = null;
            try { dataUrl = target.toDataURL('image/png'); } catch { dataUrl = null; }
            replacements.set(target, { kind: 'canvas', dataUrl });
          }
          const image = await loadImage(url).catch(() => null);
          if (!image) {
            if (!targetWasReplaced) replacements.delete(target);
            return false;
          }
          const scale = Math.max(target.width / image.naturalWidth, target.height / image.naturalHeight);
          const width = image.naturalWidth * scale;
          const height = image.naturalHeight * scale;
          context.clearRect(0, 0, target.width, target.height);
          context.drawImage(image, (target.width - width) / 2, (target.height - height) / 2, width, height);
          if (!wasApplied) notifyReplacementState(true);
          return true;
        }
        if (target instanceof HTMLVideoElement && kind === 'video') {
          if (!replacements.has(target)) {
            replacements.set(target, { kind: 'video', poster: target.getAttribute('poster') });
          }
          target.setAttribute('poster', url);
          if (!wasApplied) notifyReplacementState(true);
          return true;
        }
        if ((kind === 'css-background' || !(target instanceof HTMLImageElement)) && target instanceof HTMLElement) {
          if (!replacements.has(target)) {
            replacements.set(target, { kind: 'css', backgroundImage: target.style.backgroundImage });
          }
          target.style.backgroundImage = `url("${url}")`;
          if (!wasApplied) notifyReplacementState(true);
          return true;
        }
        return false;
      },
      async restore() {
        for (const [element, original] of replacements) {
          if (original.kind === 'img' && element instanceof HTMLImageElement) {
            element.src = original.src;
            element.srcset = original.srcset;
            element.sizes = original.sizes;
          } else if (original.kind === 'canvas' && element instanceof HTMLCanvasElement) {
            const context = element.getContext('2d');
            if (context && original.dataUrl) {
              const image = await loadImage(original.dataUrl).catch(() => null);
              if (image) {
                context.clearRect(0, 0, element.width, element.height);
                context.drawImage(image, 0, 0, element.width, element.height);
              }
            }
          } else if (original.kind === 'video' && element instanceof HTMLVideoElement) {
            if (original.poster === null) element.removeAttribute('poster');
            else element.setAttribute('poster', original.poster);
          } else if (original.kind === 'css' && element instanceof HTMLElement) {
            element.style.backgroundImage = original.backgroundImage;
          }
        }
        replacements.clear();
        notifyReplacementState(false);
      },
      async snapshotCanvas(candidate) {
        const target = findCandidateTarget(candidate);
        if (!(target instanceof HTMLCanvasElement)) throw new Error('page_image_fetch_failed');
        if (!target.width || !target.height) throw new Error('page_image_fetch_failed');
        const blob = await new Promise<Blob | null>((resolve) => {
          try {
            target.toBlob((result) => resolve(result), 'image/png');
          } catch {
            resolve(null);
          }
        });
        if (blob && blob.size > 0) return new File([blob], candidate.fileName, { type: 'image/png' });
        // Fallback for engines without toBlob; throws on tainted canvases.
        let dataUrl: string;
        try {
          dataUrl = target.toDataURL('image/png');
        } catch {
          throw new Error('page_image_fetch_failed');
        }
        const base64 = dataUrl.split(',')[1];
        if (!base64) throw new Error('page_image_fetch_failed');
        const decoded = atob(base64);
        const bytes = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return new File([buffer], candidate.fileName, { type: 'image/png' });
      },
      async setPageNumberLabels(entries) {
        pageNumberOverlay.set(entries);
      },
      async setLayout() {
        // The modal ShadowRoot container always covers the viewport; its root
        // disables pointer events while the FAB and drawer opt back in.
      },
    };

    const runtimeListener = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return undefined;
      if (message.type === 'KOHARU_PAGE_PING') return Promise.resolve({ ok: true, url: location.href });
      if (message.type === 'GET_PAGE_TRANSLATION_STATE') {
        return Promise.resolve({ ok: true, applied: replacements.size > 0, count: replacements.size });
      }
      if (message.type === 'RESTORE_PAGE_IMAGES') return bridge.restore().then(() => ({ ok: true }));
      return undefined;
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
          const syncFullscreenVisibility = () => {
            shadowHost.style.setProperty(
              'display',
              isDocumentFullscreen(document) ? 'none' : 'block',
              'important',
            );
          };
          document.addEventListener('fullscreenchange', syncFullscreenVisibility);
          document.addEventListener('webkitfullscreenchange', syncFullscreenVisibility);
          syncFullscreenVisibility();
          return { root, syncFullscreenVisibility };
        },
        onRemove(mounted) {
          if (!mounted) return;
          document.removeEventListener('fullscreenchange', mounted.syncFullscreenVisibility);
          document.removeEventListener('webkitfullscreenchange', mounted.syncFullscreenVisibility);
          mounted.root.unmount();
        },
      });
      ui.mount();
      ctx.onInvalidated(() => {
        try { browser.runtime.onMessage.removeListener(runtimeListener); } catch { /* invalidated */ }
        pageNumberOverlay.destroy();
        ui.remove();
        pageWindow.__koharuMangaCompanionMounted__ = false;
      });
    } catch (error) {
      try { browser.runtime.onMessage.removeListener(runtimeListener); } catch { /* invalidated */ }
      pageNumberOverlay.destroy();
      pageWindow.__koharuMangaCompanionMounted__ = false;
      if (isExtensionContextInvalidated(error)) return;
      window.removeEventListener('unhandledrejection', suppressInvalidatedRejection);
      throw error;
    }
  },
});
