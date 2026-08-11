import { NextResponse } from 'next/server';
import { proxyCallTaskRequest } from '@/app/api/call-tasks/proxy';
import { readRequestCallBrowserCapability } from '@/lib/call-browser-capability';
import { parseCallIdentifier } from '@/lib/call-proxy';

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const { taskId: rawTaskId } = await context.params;
  const taskId = parseCallIdentifier(rawTaskId);
  const callSessionId = parseCallIdentifier(new URL(request.url).searchParams.get('callSessionId'));
  if (!taskId || !callSessionId) {
    return NextResponse.json(
      {
        code: 'unknown',
        message: 'Valid task and call session IDs are required.',
        retryable: false,
      },
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
  return proxyCallTaskRequest(
    `/api/viventium/voice/tasks/${encodeURIComponent(taskId)}?callSessionId=${encodeURIComponent(callSessionId)}`,
    'GET',
    callSessionId,
    browserCapability
  );
}
