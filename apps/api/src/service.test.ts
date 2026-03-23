import { describe, expect, it } from "vitest";

import { createSilentTtsAdapter } from "@maps/voice-core";

import { createDemoAssistantService } from "./service";

describe("createDemoAssistantService", () => {
  it("resolves a clarification follow-up into a completed route request", async () => {
    const service = createDemoAssistantService(createSilentTtsAdapter());

    const firstTurn = await service.handleTurn({
      runtime: {
        mapMode: "china_public",
        mapProvider: "tianditu",
        llmProvider: "openai",
        enableForeignMapExperiments: false
      },
      sessionId: "service-session",
      transcriptText: "展示从机场到会展中心的大致路线，并说明沿线重点地标",
      mapContext: {
        currentBounds: [0, 0, 100, 100],
        activeLayer: "vector",
        highlightedFeatureIds: []
      }
    });

    expect(firstTurn.result.responseMode).toBe("clarification");

    const secondTurn = await service.handleTurn({
      runtime: {
        mapMode: "china_public",
        mapProvider: "tianditu",
        llmProvider: "openai",
        enableForeignMapExperiments: false
      },
      sessionId: "service-session",
      transcriptText: "虹桥交通枢纽",
      mapContext: {
        currentBounds: [0, 0, 100, 100],
        activeLayer: "vector",
        highlightedFeatureIds: []
      }
    });

    expect(secondTurn.result.responseMode).toBe("answer");
    expect(secondTurn.result.narration.text).toContain("国家会展中心");
  });
});
