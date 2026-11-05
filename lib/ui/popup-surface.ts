export interface PopupNavigatorInfo {
  userAgent?: string;
  userAgentData?: {
    mobile?: boolean;
  } | null;
}

export type PopupSurface = 'desktop' | 'mobile';

export function detectPopupSurface(navigatorInfo: PopupNavigatorInfo): PopupSurface {
  if (navigatorInfo.userAgentData?.mobile === true) return 'mobile';
  return /Android/i.test(navigatorInfo.userAgent ?? '') ? 'mobile' : 'desktop';
}

export function markPopupSurface(
  root: Pick<HTMLElement, 'dataset'>,
  navigatorInfo: PopupNavigatorInfo,
): PopupSurface {
  const surface = detectPopupSurface(navigatorInfo);
  root.dataset.koharuPopupSurface = surface;
  return surface;
}
