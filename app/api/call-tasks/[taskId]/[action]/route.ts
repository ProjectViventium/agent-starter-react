import { NextResponse } from 'next/server';
import { proxyCallTaskRequest } from '@/app/api/call-tasks/proxy';
import { readRequestCallBrowserCapability } from '@/lib/call-browser-capability';
import { parseCallIdentifier, parseTaskInput } from '@/lib/call-proxy';

const ACTIONS = new Set(['cancel', 'retry', 'input']);

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string; action: string }> }
) {
  const { taskId: rawTaskId, action } = await context.params;
  const taskId = parseCallIdentifier(rawTaskId);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const callSessionId = parseCallIdentifier(body?.callSessionId);
  if (!taskId || !callSessionId || !ACTIONS.has(action)) {
    return NextResponse.json(
      { code: 'unknown', message: 'The task action request is invalid.', retryable: false },
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
  const input = action === 'input' ? parseTaskInput(body?.input) : null;
  if (action === 'input' && !input) {
    return NextResponse.json(
      { code: 'unknown', message: 'A valid task input is required.', retryable: false },
      { status: 400 }
    );
  }
  return proxyCallTaskRequest(
    `/api/viventium/voice/tasks/${encodeURIComponent(taskId)}/${action}`,
    'POST',
    callSessionId,
    browserCapability,
    { callSessionId, ...(input ? { input } : {}) }
  );
}
