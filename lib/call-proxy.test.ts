import { describe, expect, it } from 'vitest';
import { normalizeProxyFailure, parseCallIdentifier, parseTaskInput } from '@/lib/call-proxy';

describe('call proxy boundary', () => {
  it('accepts bounded structured IDs and rejects path/control payloads', () => {
    expect(parseCallIdentifier('task:abc-123')).toBe('task:abc-123');
    expect(parseCallIdentifier('../secret')).toBeNull();
    expect(parseCallIdentifier('a'.repeat(161))).toBeNull();
    expect(parseCallIdentifier('task\nsecret')).toBeNull();
  });

  it('accepts only bounded nonempty task input', () => {
    expect(parseTaskInput('  yes  ')).toBe('yes');
    expect(parseTaskInput('')).toBeNull();
    expect(parseTaskInput('a'.repeat(8_001))).toBeNull();
    expect(parseTaskInput({ value: 'yes' })).toBeNull();
  });

  it('maps only exact classified upstream codes and status fallbacks', () => {
    expect(normalizeProxyFailure(503, { code: 'provider_failure', message: 'Down' })).toEqual({
      code: 'provider_failure',
      message: 'Down',
      retryable: false,
    });
    expect(normalizeProxyFailure(410, { message: 'Expired' }).code).toBe('auth_expired');
    expect(normalizeProxyFailure(503, { message: 'Provider is down' }).code).toBe('gateway_down');
    expect(normalizeProxyFailure(400, { message: 'expired provider route' }).code).toBe('unknown');
  });
});
