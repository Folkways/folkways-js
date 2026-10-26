/**
 * @folkways/realtime/server: the backend side.
 *
 *   import { Folkways } from '@folkways/realtime/server';
 *   const rte = new Folkways.Rest({ url, segment, signingKey: { kid, privateKey } });
 */
import { Rest } from './rest';

export { Rest, type CreateTokenOptions, type IssuedToken, type RestOptions, type RestPublishOptions } from './rest';
export { type SigningAlgorithm, type SigningKey } from './sign';
export { Code, codeName } from '../shared/codes';
export { RealtimeError, isRealtimeError } from '../shared/errors';
export type { Delivery, Op, Permission, PublishReceipt } from '../api/types';

/** `new Folkways.Rest({ url, segment, signingKey })`. */
export const Folkways = Object.freeze({ Rest });
