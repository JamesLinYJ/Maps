// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFetchAssistantApiClient } from "./api-client";

describe("createFetchAssistantApiClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("returns a helpful timeout error when the turn request takes too long", async () => {
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    ) as typeof fetch;

    const client = createFetchAssistantApiClient("http://127.0.0.1:8000");
    const pending = client.handleTurn({
      runtime: {
        mapMode: "internal",
        mapProvider: "amap",
        llmProvider: "gemini",
        enableForeignMapExperiments: false
      },
      sessionId: "timeout-test",
      transcriptText: "带我看看浦东新区",
      mapContext: {
        currentBounds: [121.2, 31.1, 121.7, 31.4],
        activeLayer: "vector",
        highlightedFeatureIds: []
      }
    });
    const expectation = expect(pending).rejects.toThrow("地图请求处理时间过长");

    await vi.advanceTimersByTimeAsync(30000);
    await expectation;
  });
});
