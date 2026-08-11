import { describe, expect, it } from 'vitest';
import { shouldUseSandboxTokenSource } from '@/lib/utils';

describe('connection token source authority', () => {
  it('always selects the same-origin BFF for a signed call even when a sandbox endpoint exists', () => {
    expect(
      shouldUseSandboxTokenSource(
        '550e8400-e29b-41d4-a716-446655440000',
        'https://sandbox.example.test/token'
      )
    ).toBe(false);
  });

  it('allows the sandbox source only for an unsigned standalone session', () => {
    expect(shouldUseSandboxTokenSource(null, 'https://sandbox.example.test/token')).toBe(true);
    expect(shouldUseSandboxTokenSource(null, undefined)).toBe(false);
  });
});
