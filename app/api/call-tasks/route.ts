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
  const beforeCreatedAt = searchParams.get('beforeCreatedAt');
  const beforeTaskId = parseCallIdentifier(searchParams.get('beforeTaskId'));
  const hasCursor = beforeCreatedAt !== null || searchParams.get('beforeTaskId') !== null;
  const parsedBeforeCreatedAt = beforeCreatedAt ? new Date(beforeCreatedAt) : null;
  if (
    hasCursor &&
    (!parsedBeforeCreatedAt || !Number.isFinite(parsedBeforeCreatedAt.getTime()) || !beforeTaskId)
  ) {
    return NextResponse.json(
      { code: 'unknown', message: 'A valid task paging cursor is required.', retryable: false },
      { status: 400 }
    );
  }
  const cursor = hasCursor
    ? `&beforeCreatedAt=${encodeURIComponent(parsedBeforeCreatedAt!.toISOString())}&beforeTaskId=${encodeURIComponent(beforeTaskId!)}`
    : '';
  return proxyCallTaskRequest(
    `/api/viventium/voice/tasks?callSessionId=${encodeURIComponent(callSessionId)}${cursor}`,
    'GET',
    callSessionId,
    browserCapability
  );
}
