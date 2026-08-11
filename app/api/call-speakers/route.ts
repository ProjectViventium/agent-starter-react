import { NextResponse } from 'next/server';
import { proxyCallTaskRequest } from '@/app/api/call-tasks/proxy';
import { readRequestCallBrowserCapability } from '@/lib/call-browser-capability';
import { parseCallIdentifier } from '@/lib/call-proxy';

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const callSessionId = parseCallIdentifier(searchParams.get('callSessionId'));
  if (!callSessionId) {
    return NextResponse.json(
      { code: 'unknown', message: 'A valid callSessionId is required.', retryable: false },
      { status: 400 }
    );
  }
  const browserCapability = readRequestCallBrowserCapability(request);
  if (!browserCapability) {
    return NextResponse.json(
      {
        code: 'auth_expired',
        message: 'The call capability is missing or invalid.',
        retryable: false,
      },
      { status: 401 }
    );
  }
  const rawBeforeSequence = searchParams.get('beforeSequence');
  const rawBeforeSegmentId = searchParams.get('beforeSegmentId');
  const rawAfterSequence = searchParams.get('afterSequence');
  const rawAfterSegmentId = searchParams.get('afterSegmentId');
  const beforeCursorPresent = rawBeforeSequence !== null || rawBeforeSegmentId !== null;
  const afterCursorPresent = rawAfterSequence !== null || rawAfterSegmentId !== null;
  const beforeSequence =
    rawBeforeSequence !== null && /^\d+$/.test(rawBeforeSequence)
      ? Number(rawBeforeSequence)
      : null;
  const beforeSegmentId =
    typeof rawBeforeSegmentId === 'string' &&
    rawBeforeSegmentId.length > 0 &&
    rawBeforeSegmentId.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(rawBeforeSegmentId)
      ? rawBeforeSegmentId
      : null;
  const afterSequence =
    rawAfterSequence !== null && /^\d+$/.test(rawAfterSequence) ? Number(rawAfterSequence) : null;
  const afterSegmentId =
    typeof rawAfterSegmentId === 'string' &&
    rawAfterSegmentId.length > 0 &&
    rawAfterSegmentId.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(rawAfterSegmentId)
      ? rawAfterSegmentId
      : null;
  if (
    (beforeCursorPresent && afterCursorPresent) ||
    (beforeCursorPresent &&
      (rawBeforeSequence === null ||
        rawBeforeSegmentId === null ||
        beforeSequence === null ||
        !Number.isSafeInteger(beforeSequence) ||
        beforeSequence < 0 ||
        beforeSegmentId === null)) ||
    (afterCursorPresent &&
      (rawAfterSequence === null ||
        rawAfterSegmentId === null ||
        afterSequence === null ||
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 ||
        afterSegmentId === null))
  ) {
    return NextResponse.json(
      { code: 'unknown', message: 'A valid speaker paging cursor is required.', retryable: false },
      { status: 400 }
    );
  }
  const cursor = beforeCursorPresent
    ? `&beforeSequence=${encodeURIComponent(beforeSequence!)}&beforeSegmentId=${encodeURIComponent(beforeSegmentId!)}`
    : afterCursorPresent
      ? `&afterSequence=${encodeURIComponent(afterSequence!)}&afterSegmentId=${encodeURIComponent(afterSegmentId!)}`
      : '';
  return proxyCallTaskRequest(
    `/api/viventium/voice/speaker-segments?callSessionId=${encodeURIComponent(callSessionId)}${cursor}`,
    'GET',
    callSessionId,
    browserCapability
  );
}
