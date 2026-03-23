import { resolveMapPolicy } from "@maps/compliance";
import {
  assistantTurnResultSchema,
  intentClassificationSchema,
  mapActionPlanSchema,
  narrationSchema,
  orchestratorRequestSchema,
  type AssistantTurnResult,
  type Clarification,
  type IntentClassification,
  type ToolCall,
  type ToolResult
} from "@maps/schemas";
import type { LlmProvider } from "@maps/llm-core";
import type { ToolRegistry } from "@maps/tools";
import type { VoiceTelemetrySink } from "@maps/voice-core";

export interface OrchestratorDependencies {
  llmProvider: LlmProvider;
  tools: ToolRegistry;
  telemetry?: VoiceTelemetrySink;
}

function buildClarification(
  classification: IntentClassification,
  toolCalls: ToolCall[],
  toolResults: ToolResult[]
): Clarification | undefined {
  const ambiguousPoi = toolResults.find(
    (result) => result.tool === "poiSearch" && result.isAmbiguous
  );

  if (ambiguousPoi && ambiguousPoi.tool === "poiSearch") {
    return {
      question: `你想看${ambiguousPoi.features.map((feature) => feature.name).join("还是")}？`,
      options: ambiguousPoi.features.map((feature) => ({
        id: feature.id,
        label: feature.name,
        resolvedValue: feature.name
      }))
    };
  }

  const emptyPoi = toolResults.find(
    (result) => result.tool === "poiSearch" && result.features.length === 0
  );

  if (emptyPoi && emptyPoi.tool === "poiSearch") {
    return {
      question: `当前演示场景里还没有“${emptyPoi.query}”的内置数据，你可以试试浦东新区、陆家嘴、张江科学城或国家会展中心。`,
      options: []
    };
  }

  const ambiguousRoute = toolResults.find(
    (result) => result.tool === "routeSummary" && result.ambiguity
  );

  if (ambiguousRoute && ambiguousRoute.tool === "routeSummary" && ambiguousRoute.ambiguity) {
    const targetLabel = ambiguousRoute.ambiguity.field === "from" ? "出发点" : "终点";
    return {
      question: `我需要先确认${targetLabel}，你想说的是${ambiguousRoute.ambiguity.options
        .map((feature) => feature.name)
        .join("还是")}？`,
      options: ambiguousRoute.ambiguity.options.map((feature) => ({
        id: feature.id,
        label: feature.name,
        resolvedValue: feature.name
      }))
    };
  }

  if (classification.intent === "multi_point_story" && toolCalls.length === 0) {
    return {
      question: "请告诉我需要标注的具体地点名称。",
      options: []
    };
  }

  return undefined;
}

export async function orchestrateVoiceMapTurn(
  rawRequest: unknown,
  dependencies: OrchestratorDependencies
): Promise<AssistantTurnResult> {
  const request = orchestratorRequestSchema.parse(rawRequest);
  const policy = resolveMapPolicy(request.runtime);

  dependencies.telemetry?.record({
    event: "voice_session_started",
    sessionId: request.session.id
  });

  dependencies.telemetry?.record({
    event: "asr_transcript_received",
    sessionId: request.session.id,
    language: request.transcript.language
  });

  const classification = intentClassificationSchema.parse(
    await dependencies.llmProvider.classifyIntent({
      transcript: request.transcript,
      mapContext: request.mapContext
    })
  );

  dependencies.telemetry?.record({
    event: "intent_classified",
    sessionId: request.session.id,
    intent: classification.intent
  });

  const toolCalls = await dependencies.llmProvider.callTools({
    transcript: request.transcript,
    classification,
    mapContext: request.mapContext,
    runtime: request.runtime
  });

  let toolResults: ToolResult[] = [];

  if (toolCalls.length > 0) {
    dependencies.telemetry?.record({
      event: "tool_call_started",
      sessionId: request.session.id,
      toolCount: toolCalls.length
    });

    try {
      const rawToolResults = await dependencies.tools.execute(toolCalls);
      toolResults = rawToolResults.map((result) => result.schema.parse(result.payload));

      dependencies.telemetry?.record({
        event: "tool_calls_completed",
        sessionId: request.session.id,
        toolCount: toolResults.length
      });
    } catch (error) {
      dependencies.telemetry?.record({
        event: "tool_calls_failed",
        sessionId: request.session.id,
        error: error instanceof Error ? error.message : "unknown tool failure"
      });
      throw error;
    }
  }

  const clarification = buildClarification(classification, toolCalls, toolResults);

  const clarificationPlan = mapActionPlanSchema.parse({
    summary: "Waiting for clarification.",
    actions:
      classification.requestedLayer && classification.requestedLayer !== request.mapContext.activeLayer
        ? [
            {
              type: "set_layer",
              layer: classification.requestedLayer
            }
          ]
        : [
            {
              type: "clear_route"
            }
          ],
    sourceCards: toolResults.flatMap((result) => result.sourceCards)
  });

  const mapActionPlan =
    clarification === undefined
      ? mapActionPlanSchema.parse(
          await dependencies.llmProvider.generateMapActions({
            transcript: request.transcript,
            classification,
            toolResults,
            mapContext: request.mapContext,
            mapPolicy: policy
          })
        )
      : clarificationPlan;

  dependencies.telemetry?.record({
    event: "map_action_plan_generated",
    sessionId: request.session.id,
    actionCount: mapActionPlan.actions.length
  });

  const narration =
    clarification === undefined
      ? narrationSchema.parse(
          await dependencies.llmProvider.generateNarration({
            transcript: request.transcript,
            classification,
            toolResults,
            mapActionPlan,
            mapPolicy: policy
          })
        )
      : narrationSchema.parse({
          text: clarification.question,
          language: request.transcript.language,
          grounding: []
        });

  dependencies.telemetry?.record({
    event: "narration_generated",
    sessionId: request.session.id
  });

  const responseMode = clarification ? "clarification" : "answer";

  return assistantTurnResultSchema.parse({
    responseMode,
    policy,
    classification,
    toolCalls,
    toolResults,
    mapActionPlan,
    narration,
    clarification
  });
}
