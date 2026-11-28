import type { Permission } from '@folkwaysio/realtime/server';

/** The example uses one room. Real applications must grant only authorized rooms. */
export function permissionsFor(identity: string): Permission[] {
  void identity;
  return [
    { topics: 'chat/lobby', ops: ['subscribe', 'history', 'publish', 'set', 'signal', 'presence'] },
  ];
}
