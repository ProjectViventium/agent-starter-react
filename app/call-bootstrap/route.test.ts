import { describe, expect, it } from 'vitest';
import { GET } from '@/app/call-bootstrap/route';

describe('framework-free call capability bootstrap document', () => {
  it('runs the generic strip script as its first executable with no Next runtime', async () => {
    const response = GET();
    const html = await response.text();
    const firstScript = html.indexOf('<script>');

    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(firstScript).toBeGreaterThan(0);
    expect(html.slice(0, firstScript)).not.toContain('<script');
    expect(html).not.toContain('/_next/');
    expect(html).not.toContain('viventiumCallCapability=A');
    expect(html).toContain('window.location.replace(d)');
  });
});
