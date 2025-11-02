import { describe, it, expect } from 'vitest'
import { MessageType, Priority } from './types'

describe('MessageType', () => {
    describe('fromU8', () => {
        it('should convert valid numbers to MessageType', () => {
            expect(MessageType.fromU8(0x01)).toBe(MessageType.Auth)
            expect(MessageType.fromU8(0x02)).toBe(MessageType.Publish)
            expect(MessageType.fromU8(0x03)).toBe(MessageType.Subscribe)
            expect(MessageType.fromU8(0x04)).toBe(MessageType.Unsubscribe)
            expect(MessageType.fromU8(0x05)).toBe(MessageType.Ack)
            expect(MessageType.fromU8(0x06)).toBe(MessageType.Nack)
            expect(MessageType.fromU8(0x07)).toBe(MessageType.Ping)
            expect(MessageType.fromU8(0x08)).toBe(MessageType.Pong)
            expect(MessageType.fromU8(0x09)).toBe(MessageType.Disconnect)
            expect(MessageType.fromU8(0x0E)).toBe(MessageType.Error)
        })

        it('should return null for invalid numbers', () => {
            expect(MessageType.fromU8(0x00)).toBeNull()
            expect(MessageType.fromU8(0xFF)).toBeNull()
        })
    })

    describe('requiresResponse', () => {
        it('should return true for messages requiring response', () => {
            expect(MessageType.requiresResponse(MessageType.Ping)).toBe(true)
            expect(MessageType.requiresResponse(MessageType.Auth)).toBe(true)
            expect(MessageType.requiresResponse(MessageType.Subscribe)).toBe(true)
        })

        it('should return false for messages not requiring response', () => {
            expect(MessageType.requiresResponse(MessageType.Publish)).toBe(false)
            expect(MessageType.requiresResponse(MessageType.Pong)).toBe(false)
            expect(MessageType.requiresResponse(MessageType.Error)).toBe(false)
        })
    })

    describe('isControl', () => {
        it('should identify control messages correctly', () => {
            expect(MessageType.isControl(MessageType.Ping)).toBe(true)
            expect(MessageType.isControl(MessageType.Pong)).toBe(true)
            expect(MessageType.isControl(MessageType.Disconnect)).toBe(true)
        })

        it('should identify non-control messages correctly', () => {
            expect(MessageType.isControl(MessageType.Auth)).toBe(false)
            expect(MessageType.isControl(MessageType.Publish)).toBe(false)
            expect(MessageType.isControl(MessageType.Error)).toBe(false)
        })
    })
})

describe('Priority', () => {
    describe('fromU8', () => {
        it('should convert valid numbers to Priority', () => {
            expect(Priority.fromU8(0)).toBe(Priority.Low)
            expect(Priority.fromU8(1)).toBe(Priority.Normal)
            expect(Priority.fromU8(2)).toBe(Priority.High)
            expect(Priority.fromU8(3)).toBe(Priority.Critical)
        })

        it('should mask input to 2 bits', () => {
            expect(Priority.fromU8(0b11111100)).toBe(Priority.Low)
            expect(Priority.fromU8(0b11111101)).toBe(Priority.Normal)
            expect(Priority.fromU8(0b11111110)).toBe(Priority.High)
            expect(Priority.fromU8(0b11111111)).toBe(Priority.Critical)
        })
    })
})