import { describe, it, expect } from 'vitest';
import { MessageFlags } from './flags';

describe('MessageFlags', () => {
    it('has expected constant bit values', () => {
        expect(MessageFlags.NONE.bits()).toBe(0);
        expect(MessageFlags.HAS_FOOTER.bits()).toBe(0b0000_0001);
        expect(MessageFlags.COMPRESSED.bits()).toBe(0b0000_0010);
        expect(MessageFlags.ENCRYPTED.bits()).toBe(0b0000_0100);
        expect(MessageFlags.REQUIRES_ACK.bits()).toBe(0b0000_1000);
        expect(MessageFlags.RETRY.bits()).toBe(0b0001_0000);
        expect(MessageFlags.RESERVED_5.bits()).toBe(0b0010_0000);
        expect(MessageFlags.RESERVED_6.bits()).toBe(0b0100_0000);
        expect(MessageFlags.RESERVED_7.bits()).toBe(0b1000_0000);
    });

    it('masks bits to 8 bits in constructor and fromBits', () => {
        const over = new MessageFlags(0x1FF); // 9 bits set -> should be masked to 0xFF
        expect(over.bits()).toBe(0xFF);

        const negative = MessageFlags.fromBits(-1); // -1 should become 0xFF after masking
        expect(negative.bits()).toBe(0xFF);
    });

    it('or returns a new MessageFlags and does not mutate operands', () => {
        const a = MessageFlags.HAS_FOOTER;
        const b = MessageFlags.COMPRESSED;
        const combined = a.or(b);

        expect(combined).not.toBe(a);
        expect(combined.bits()).toBe(a.bits() | b.bits());
        // originals unchanged
        expect(a.bits()).toBe(0b0000_0001);
        expect(b.bits()).toBe(0b0000_0010);
    });

    it('and returns a new MessageFlags with intersection', () => {
        const combined = MessageFlags.HAS_FOOTER.or(MessageFlags.COMPRESSED).or(MessageFlags.ENCRYPTED);
        const intersect = combined.and(MessageFlags.COMPRESSED.or(MessageFlags.ENCRYPTED));
        expect(intersect.bits()).toBe(MessageFlags.COMPRESSED.bits() | MessageFlags.ENCRYPTED.bits());
    });

    it('contains returns true only when all bits present', () => {
        const combo = MessageFlags.fromBits(
            MessageFlags.HAS_FOOTER.bits() | MessageFlags.COMPRESSED.bits()
        );
        expect(combo.contains(MessageFlags.HAS_FOOTER)).toBe(true);
        expect(combo.contains(MessageFlags.COMPRESSED)).toBe(true);
        expect(combo.contains(MessageFlags.ENCRYPTED)).toBe(false);
        const both = MessageFlags.HAS_FOOTER.or(MessageFlags.COMPRESSED);
        expect(combo.contains(both)).toBe(true);
        expect(both.contains(combo)).toBe(true); // they are equal
        const larger = combo.or(MessageFlags.ENCRYPTED);
        expect(combo.contains(larger)).toBe(false);
    });

    it('insert and remove modify the instance correctly', () => {
        const f = MessageFlags.fromBits(0); // start empty to avoid mutating statics
        expect(f.bits()).toBe(0);

        f.insert(MessageFlags.HAS_FOOTER);
        expect(f.contains(MessageFlags.HAS_FOOTER)).toBe(true);
        expect(f.bits()).toBe(MessageFlags.HAS_FOOTER.bits());

        f.insert(MessageFlags.COMPRESSED);
        expect(f.contains(MessageFlags.COMPRESSED)).toBe(true);
        expect(f.bits()).toBe(MessageFlags.HAS_FOOTER.bits() | MessageFlags.COMPRESSED.bits());

        // removing a flag clears it
        f.remove(MessageFlags.HAS_FOOTER);
        expect(f.contains(MessageFlags.HAS_FOOTER)).toBe(false);
        expect(f.contains(MessageFlags.COMPRESSED)).toBe(true);

        // removing a non-present flag has no adverse effect
        const before = f.bits();
        f.remove(MessageFlags.REQUIRES_ACK);
        expect(f.bits()).toBe(before);
    });
});