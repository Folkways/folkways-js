/** Identities that can name a personal topic and participate in membership or DM APIs. */
export function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 245 && !/[^A-Za-z0-9._~:@=+-]/.test(value) && !value.startsWith('anon:');
}
