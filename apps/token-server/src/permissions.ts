import type { Permission } from '@folkwaysio/realtime/server';

/**
 * What a signed-in user's token allows: the example chat on `chat/…` (read
 * history, post, and see who is in the room) and its typing indicators on
 * `typing/…`. The segment's topic rules must allow these operations too; a
 * token can't grant more than the rules do. Who is in a room shows only when
 * the `chat/>` rule has presence turned on.
 *
 * In your app, grant each user only what they need, for example the rooms
 * they are a member of: `{ topics: \`chat/team-${teamId}/>\`, ops: [...] }`.
 */
export function permissionsFor(identity: string): Permission[] {
  void identity;
  return [
    { topics: 'chat/>', ops: ['subscribe', 'history', 'publish', 'presence'] },
    { topics: 'typing/>', ops: ['subscribe', 'signal'] },
  ];
}
