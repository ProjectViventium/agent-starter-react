/* VIVENTIUM START
 * Purpose: Lightweight modern playground readiness probe for the macOS helper.
 *
 * Why:
 * - The helper must know whether the voice playground is reachable without rendering
 *   the root React page every few seconds.
 * - Keeping this endpoint local and side-effect-free preserves the local-prod/dev-env
 *   runtime boundary while avoiding unnecessary Next dev server work.
 * VIVENTIUM END */
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      surface: 'modern-playground',
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
