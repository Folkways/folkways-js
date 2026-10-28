import type { Permission } from '@folkwaysio/realtime/server';

/**
 * What a signed-in user's token allows: the example app's chat on `chat/…`
 * and its typing indicators on `typing/…`. The segment also needs topic rules
 * that allow these operations; a token can't grant more than the rules do.
 *
 * In your app, grant each user only what they need, for example the rooms
 * they are a member of: `{ topics: \`chat/team-${teamId}/>\`, ops: [...] }`.
 */
export function permissionsFor(identity: string): Permission[] {
  void identity;
  return [
    { topics: 'chat/>', ops: ['subscribe', 'publish'] },
    { topics: 'typing/>', ops: ['subscribe', 'signal'] },
  ];
}
