import { describe, expect, it } from "vitest";

import { createLlmProvider } from "@maps/llm-core";
import { createToolRegistry } from "@maps/tools";

import { orchestrateVoiceMapTurn } from "./orchestrator";

describe("orchestrateVoiceMapTurn", () => {
  it("applies China-public compliant defaults and returns a grounded answer", async () => {
    const telemetryEvents: string[] = [];

    const result = await orchestrateVoiceMapTurn(
      {
        runtime: {
          mapMode: "china_public",
          mapProvider: "tianditu",
          llmProvider: "openai",
          enableForeignMapExperiments: false
        },
        session: {
          id: "session-1"
        },
        transcript: {
          text: "带我看看浦东新区的重点区域",
          language: "zh-CN",
          isFinal: true
        },
        mapContext: {
          currentBounds: [0, 0, 100, 100],
          activeLayer: "vector",
          highlightedFeatureIds: []
        }
      },
      {
        llmProvider: createLlmProvider("openai"),
        tools: createToolRegistry(),
        telemetry: {
          record(event) {
            telemetryEvents.push(event.event);
          }
        }
      }
    );

    expect(result.responseMode).toBe("answer");
    expect(result.policy.baseMapProvider).toBe("tianditu");
    expect(result.policy.allowForeignProviders).toBe(false);
    expect(result.narration.text).toContain("浦东新区");
    expect(result.mapActionPlan.actions.some((action) => action.type === "highlight_features")).toBe(true);
    expect(telemetryEvents).toContain("tool_call_started");
    expect(telemetryEvents).toContain("narration_generated");
  });

  it("keeps behavior stable when swapping LLM providers", async () => {
    const result = await orchestrateVoiceMapTurn(
      {
        runtime: {
          mapMode: "china_public",
          mapProvider: "tianditu",
          llmProvider: "anthropic",
          enableForeignMapExperiments: false
        },
        session: {
          id: "session-2"
        },
        transcript: {
          text: "切换到卫星图层，标出陆家嘴和张江科学城，并逐个讲解",
          language: "zh-CN",
          isFinal: true
        },
        mapContext: {
          currentBounds: [0, 0, 100, 100],
          activeLayer: "vector",
          highlightedFeatureIds: []
        }
      },
      {
        llmProvider: createLlmProvider("anthropic"),
        tools: createToolRegistry()
      }
    );

    expect(result.responseMode).toBe("answer");
    expect(result.mapActionPlan.actions.some((action) => action.type === "set_layer")).toBe(true);
    expect(result.mapActionPlan.actions.some((action) => action.type === "show_callouts")).toBe(true);
    expect(result.narration.text).toContain("陆家嘴");
  });

  it("asks for clarification instead of guessing ambiguous route endpoints", async () => {
    const result = await orchestrateVoiceMapTurn(
      {
        runtime: {
          mapMode: "china_public",
          mapProvider: "tianditu",
          llmProvider: "openai",
          enableForeignMapExperiments: false
        },
        session: {
          id: "session-3"
        },
        transcript: {
          text: "展示从机场到会展中心的大致路线，并说明沿线重点地标",
          language: "zh-CN",
          isFinal: true
        },
        mapContext: {
          currentBounds: [0, 0, 100, 100],
          activeLayer: "vector",
          highlightedFeatureIds: []
        }
      },
      {
        llmProvider: createLlmProvider("openai"),
        tools: createToolRegistry()
      }
    );

    expect(result.responseMode).toBe("clarification");
    expect(result.clarification?.question).toContain("确认");
    expect(result.clarification?.options).toHaveLength(2);
  });

  it("rejects malformed map action output safely", async () => {
    await expect(
      orchestrateVoiceMapTurn(
        {
          runtime: {
            mapMode: "china_public",
            mapProvider: "tianditu",
            llmProvider: "openai",
            enableForeignMapExperiments: false
          },
          session: {
            id: "session-4"
          },
          transcript: {
            text: "带我看看浦东新区的重点区域",
            language: "zh-CN",
            isFinal: true
          },
          mapContext: {
            currentBounds: [0, 0, 100, 100],
            activeLayer: "vector",
            highlightedFeatureIds: []
          }
        },
        {
          llmProvider: {
            ...createLlmProvider("openai"),
            async generateMapActions() {
              return {
                summary: "bad",
                actions: [
                  {
                    type: "unknown"
                  }
                ],
                sourceCards: []
              } as never;
            }
          },
          tools: createToolRegistry()
        }
      )
    ).rejects.toThrow();
  });
});
