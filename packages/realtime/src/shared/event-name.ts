const encoder = new TextEncoder();

/** Event names may contain Unicode, but the wire limit is measured in UTF-8 bytes. */
export function eventNameError(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return 'event name must be a non-empty string';
  if (name.length > 64 || encoder.encode(name).length > 64) return 'event name must be at most 64 UTF-8 bytes';
  return undefined;
}
