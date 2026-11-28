/**
 * @folkwaysio/realtime/server: the backend side.
 *
 *   import { Folkways } from '@folkwaysio/realtime/server';
 *   const folkways = new Folkways.Rest({ url, segment, signingKey: { kid, privateKey } });
 */
import { Rest } from './rest';

export { Rest, type CreateTokenOptions, type IssuedToken, type RestOptions, type RestPublishOptions } from './rest';
export type { MembersApi, TopicMember, MemberList } from './members';
export type { DmApi, DmOpenOptions, DmOpened, DmInvite, JsonValue } from './dm';
export { type SigningAlgorithm, type SigningKey } from './sign';
export { Code, codeName } from '../shared/codes';
export { RealtimeError, isRealtimeError } from '../shared/errors';
export type { Delivery, Op, Permission, PublishReceipt } from '../api/types';

/** `new Folkways.Rest({ url, segment, signingKey })`. */
export const Folkways = Object.freeze({ Rest });
