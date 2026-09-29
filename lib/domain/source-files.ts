const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif', 'tif', 'tiff', 'heic', 'heif']);
const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/bmp', 'image/gif',
  'image/tiff', 'image/heic', 'image/heif',
]);

export interface PreparedSourceFiles {
  accepted: File[];
  rejected: File[];
}

export function isSupportedSourceImage(file: Pick<File, 'name' | 'type'>): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXTENSIONS.has(extension) && (!file.type || SUPPORTED_MIME_TYPES.has(file.type.toLowerCase()));
}

export function prepareSourceFiles(files: File[]): PreparedSourceFiles {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const file of files) (isSupportedSourceImage(file) ? accepted : rejected).push(file);
  accepted.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { accepted, rejected };
}

export function moveSourceFile(files: File[], from: number, direction: -1 | 1): File[] {
  const to = from + direction;
  if (to < 0 || to >= files.length) return files;
  const next = [...files];
  const [item] = next.splice(from, 1);
  if (!item) return files;
  next.splice(to, 0, item);
  return next;
}
