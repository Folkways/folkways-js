/**
 * @folkways/realtime/server: the backend side.
 *
 *   import { Folkways } from '@folkways/realtime/server';
 *   const rte = new Folkways.Rest({ apiKey, url });
 */
import { Rest } from './rest';

export { Rest, type CreateTokenOptions, type IssuedToken, type RestOptions, type RestPublishOptions } from './rest';
export { Code, codeName } from '../shared/codes';
export { RealtimeError, isRealtimeError } from '../shared/errors';
export type { Delivery, Op, Permission, PublishReceipt } from '../api/types';

/** `new Folkways.Rest({ apiKey, url })`. */
export const Folkways = Object.freeze({ Rest });
