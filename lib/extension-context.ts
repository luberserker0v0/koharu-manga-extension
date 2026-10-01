export function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /extension context invalidated/i.test(message);
}
