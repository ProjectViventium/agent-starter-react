export type CallIssueKind =
  | 'auth_expired'
  | 'mic_denied'
  | 'microphone_missing'
  | 'no_route'
  | 'gateway_down'
  | 'provider_failure'
  | 'unknown';

export type CallIssue = {
  kind: CallIssueKind;
  message: string;
  retryable?: boolean;
};

const CALL_ISSUE_CODES = new Set<CallIssueKind>([
  'auth_expired',
  'mic_denied',
  'microphone_missing',
  'no_route',
  'gateway_down',
  'provider_failure',
  'unknown',
]);

export class CallRequestError extends Error {
  readonly code: CallIssueKind;
  readonly retryable: boolean;

  constructor(issue: CallIssue, retryable = false) {
    super(issue.message);
    this.name = 'CallRequestError';
    this.code = issue.kind;
    this.retryable = retryable;
  }
}

export function callIssueFromResponse(status: number, payload: unknown): CallIssue {
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const code =
    typeof value.code === 'string' && CALL_ISSUE_CODES.has(value.code as CallIssueKind)
      ? (value.code as CallIssueKind)
      : status === 401 || status === 410
        ? 'auth_expired'
        : status >= 500
          ? 'gateway_down'
          : 'unknown';
  const message =
    typeof value.message === 'string' && value.message.trim()
      ? value.message.trim().slice(0, 2_000)
      : 'The call request failed.';
  return {
    kind: code,
    message,
    ...(value.retryable === true ? { retryable: true } : {}),
  };
}

export type CallDeepLink = {
  tokenOptions?: {
    roomName?: string;
    agentName?: string;
    agentMetadata?: string;
    participantMetadata?: string;
  };
  autoConnect: boolean;
  expectedRoomName: string | null;
  expectedCallSessionId: string | null;
  expectedConversationId: string | null;
};

export function readCallDeepLink(search: string): CallDeepLink {
  const params = new URLSearchParams(search);
  const roomName = params.get('roomName')?.trim() || null;
  const agentName = params.get('agentName')?.trim() || null;
  const callSessionId = params.get('callSessionId')?.trim() || null;
  const conversationId = params.get('conversationId')?.trim() || null;
  const tokenOptions: NonNullable<CallDeepLink['tokenOptions']> = {};
  if (roomName) {
    tokenOptions.roomName = roomName;
  }
  if (agentName) {
    tokenOptions.agentName = agentName;
  }
  if (callSessionId) {
    const metadata = JSON.stringify({ callSessionId });
    tokenOptions.agentMetadata = metadata;
    tokenOptions.participantMetadata = metadata;
  }
  return {
    tokenOptions: Object.keys(tokenOptions).length > 0 ? tokenOptions : undefined,
    autoConnect: params.get('autoConnect') === '1',
    expectedRoomName: roomName,
    expectedCallSessionId: callSessionId,
    expectedConversationId: conversationId,
  };
}

export function classifyCallIssue(error: unknown): CallIssue {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const cause =
    value?.cause && typeof value.cause === 'object'
      ? (value.cause as Record<string, unknown>)
      : null;
  const rawMessage =
    value && typeof value.message === 'string'
      ? value.message.trim()
      : error instanceof Error
        ? error.message.trim()
        : '';
  const message = rawMessage.slice(0, 2_000);
  const normalizedName = value && typeof value.name === 'string' ? value.name.toLowerCase() : '';
  const normalizedCauseName =
    cause && typeof cause.name === 'string' ? cause.name.toLowerCase() : '';
  const retryable = value?.retryable === true ? { retryable: true as const } : {};

  if (normalizedName === 'notallowederror' || normalizedCauseName === 'notallowederror') {
    return { kind: 'mic_denied', message, ...retryable };
  }
  if (normalizedName === 'notfounderror' || normalizedCauseName === 'notfounderror') {
    return { kind: 'microphone_missing', message, ...retryable };
  }
  const code = value?.code;
  if (typeof code === 'string' && CALL_ISSUE_CODES.has(code as CallIssueKind)) {
    return { kind: code as CallIssueKind, message, ...retryable };
  }
  return { kind: 'unknown', message, ...retryable };
}
