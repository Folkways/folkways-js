import { describe, expect, it } from 'vitest';
import { event } from '../../test/support/server-codec';
import { AckMode, DeliveryClass } from '../engine';
import { toMessage } from './message';
import { toReceipt } from './topic';

describe('event identity', () => {
  it.each([
    { delivery: DeliveryClass.Durable, name: 'stream', seq: 2n },
    { delivery: DeliveryClass.LastValue, name: 'kv', seq: 2n },
    { delivery: DeliveryClass.LastValue, name: 'kv', seq: 0n },
  ] as const)('keeps receipt and delivery identity aligned for $name with sequence $seq', ({ delivery, name, seq }) => {
    const uid = { hi: 1n, lo: 2n };
    const e = event(7n, 3n, seq, 'value', { delivery, uid });
    const m = toMessage({ topic: 'chat/1', event: e, delivery, replayed: false, fromSnapshot: false });
    const receipt = toReceipt('chat/1', name, { topicId: 7n, level: AckMode.Accepted, cursor: { epoch: 3n, seq }, uid, duplicate: false, serverTsMs: e.serverTsMs });
    expect(receipt.id).toBe(m.id);
    expect(receipt.uid).toBe(m.uid);
    expect(receipt.cursor).toEqual(m.cursor);
    expect(m.id).toBe(seq ? '3:2' : '00000000000000010000000000000002');
  });

  it('does not invent a durable identity for signals', () => {
    const delivery = DeliveryClass.Ephemeral;
    for (const seq of [0n, 2n]) {
      const e = event(7n, 3n, seq, 'on', { delivery, name: 'typing' });
      const m = toMessage({ topic: 'chat/1', event: e, delivery, replayed: false, fromSnapshot: false });
      expect(m.uid).toBeUndefined();
      expect(m.cursor).toEqual(seq ? { epoch: 3n, seq } : undefined);
      if (seq) expect(m.id).toBe('3:2');
    }
  });
});
