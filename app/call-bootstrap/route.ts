import crypto from 'node:crypto';
import { CALL_CAPABILITY_BOOTSTRAP_SCRIPT } from '@/lib/call-capability-bootstrap';

export const dynamic = 'force-dynamic';

export function GET() {
  const hash = crypto
    .createHash('sha256')
    .update(CALL_CAPABILITY_BOOTSTRAP_SCRIPT, 'utf8')
    .digest('base64');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>${CALL_CAPABILITY_BOOTSTRAP_SCRIPT}</script></head><body></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
