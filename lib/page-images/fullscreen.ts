export interface FullscreenDocumentLike {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
}

export function isDocumentFullscreen(documentLike: FullscreenDocumentLike): boolean {
  return Boolean(documentLike.fullscreenElement ?? documentLike.webkitFullscreenElement);
}
