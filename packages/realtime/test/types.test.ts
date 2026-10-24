import { describe, expectTypeOf, it } from 'vitest';

import type { Message, MessageOf, PublishReceipt, Realtime, Topic } from '../src';

type Chat = { message: { text: string }; typing: { on: boolean }; read: { upTo: string } };

// Checked by `pnpm lint` (tsc); never run.
function narrowsByEventName(room: Topic<Chat>, client: Realtime): void {
  expectTypeOf(room.publish('message', { text: 'hi' })).toEqualTypeOf<Promise<PublishReceipt>>();
  expectTypeOf(room.publish('typing', { on: true }, { delivery: 'signal' })).toEqualTypeOf<Promise<void>>();
  // @ts-expect-error: wrong payload for the event
  void room.publish('message', { on: true });
  // @ts-expect-error: unknown event name
  void room.publish('nope', {});
  room.subscribe((m) => {
    expectTypeOf(m).toEqualTypeOf<MessageOf<Chat>>();
    if (m.name === 'read') expectTypeOf(m.data).toEqualTypeOf<{ upTo: string }>();
  });
  expectTypeOf(client.topic<Chat>('chat/1')).toEqualTypeOf<Topic<Chat>>();
  expectTypeOf<MessageOf<{ a: number }>>().toEqualTypeOf<Message<number, 'a'>>();
}

describe('public types', () => {
  it('narrow data by event name (checked at compile time)', () => {
    expectTypeOf(narrowsByEventName).toBeFunction();
  });
});
