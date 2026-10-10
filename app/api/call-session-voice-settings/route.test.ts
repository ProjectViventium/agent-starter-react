/* VIVENTIUM START
 * Feature: Advisory Assistant route labels across the existing voice-settings proxy.
 * Purpose: Preserve public display metadata without another request or weaker call capability auth.
 * VIVENTIUM END */
import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
});
describe("call voice settings label carrier", () => {
  it.each(["GET", "POST"] as const)(
    "forwards labels and exact IDs on the existing %s response",
    async (method) => {
      process.env.VIVENTIUM_LIBRECHAT_ORIGIN = "https://librechat.example.com";
      process.env.VIVENTIUM_CALL_SESSION_SECRET = "synthetic-server-secret";
      const assignment = {
        provider: "declared-provider",
        model: "declared-model",
        providerLabel: "Declared provider",
        modelLabel: "Declared model",
        effort: "high",
      };
      const payload = {
        assistantRoute: {
          primary: assignment,
          effective: assignment,
          inheritsPrimary: true,
        },
        requestedVoiceRoute: {},
        savedVoiceRoute: {},
      };
      const fetchMock = vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("/capabilities") ? { capabilities: [] } : payload,
            ),
            { status: 200 },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const route = await import("@/app/api/call-session-voice-settings/route");
      const req = new Request(
        "https://playground.example.com/api/call-session-voice-settings?callSessionId=call-1",
        {
          method,
          headers: {
            "X-VIVENTIUM-CALL-CAPABILITY": "A".repeat(43),
            "Content-Type": "application/json",
          },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  callSessionId: "call-1",
                  requestedVoiceRoute: {},
                }),
              }
            : {}),
        },
      );
      const response = await route[method](req);
      expect(response.status).toBe(200);
      expect((await response.json()).assistantRoute).toEqual(
        payload.assistantRoute,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it("does not expose route labels without the existing exact call capability", async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = "https://librechat.example.com";
    process.env.VIVENTIUM_CALL_SESSION_SECRET = "synthetic-server-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/call-session-voice-settings/route");
    const response = await GET(
      new Request(
        "https://playground.example.com/api/call-session-voice-settings?callSessionId=call-1",
      ),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).assistantRoute).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
