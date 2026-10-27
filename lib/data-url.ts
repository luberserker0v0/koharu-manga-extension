function decodedBytes(value: string, base64: boolean): Uint8Array {
  if (!base64) return new TextEncoder().encode(decodeURIComponent(value));
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const separator = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || separator < 5) throw new Error('page_image_fetch_failed');

  const metadata = dataUrl.slice(5, separator);
  const segments = metadata.split(';');
  const mediaType = segments[0] || 'application/octet-stream';
  const isBase64 = segments.some((segment) => segment.toLowerCase() === 'base64');

  try {
    const bytes = decodedBytes(dataUrl.slice(separator + 1), isBase64);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([buffer], { type: mediaType });
  } catch {
    throw new Error('page_image_fetch_failed');
  }
}
