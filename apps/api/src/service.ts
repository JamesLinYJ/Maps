import { createTraceCollector, type SafeTraceEvent } from "@maps/observability";
import type { AssistantTurnResult, MapContext, RuntimeConfig, Transcript } from "@maps/schemas";
import type { TtsAdapter, VoiceTelemetrySink } from "@maps/voice-core";

import { orchestrateVoiceMapTurn } from "./orchestrator";
import {
  createRuntimeDependencies,
  resolveRuntimeDefaults,
  type ProviderBindingSummary
} from "./provider-config";

interface PendingClarification {
  rewrittenPrompt: (selection: string) => string;
}

export interface DemoAssistantService {
  readonly defaultRuntime: RuntimeConfig;
  handleTurn(input: {
    runtime: RuntimeConfig;
    sessionId: string;
    transcriptText: string;
    mapContext: MapContext;
  }): Promise<{
    result: AssistantTurnResult;
    trace: SafeTraceEvent[];
    bindings: ProviderBindingSummary[];
    warnings: string[];
  }>;
  speakNarration(result: AssistantTurnResult): Promise<void>;
  interruptNarration(): void;
  inspectRuntime(runtime: RuntimeConfig): {
    bindings: ProviderBindingSummary[];
    warnings: string[];
  };
}

export function createAssistantService(options: {
  tts: TtsAdapter;
  env?: Record<string, string | boolean | undefined>;
}): DemoAssistantService {
  const pendingClarifications = new Map<string, PendingClarification>();
  const env = options.env ?? {};
  const defaultRuntime = resolveRuntimeDefaults(env);

  return {
    defaultRuntime,
    async handleTurn({ runtime, sessionId, transcriptText, mapContext }) {
      const traceCollector = createTraceCollector();
      const telemetry: VoiceTelemetrySink = {
        record(event) {
          traceCollector.record({
            event: event.event,
            sessionId: event.sessionId,
            metadata: {
              intent: event.intent,
              language: event.language,
              toolCount: event.toolCount,
              actionCount: event.actionCount,
              error: event.error
            }
          });
        }
      };

      const pending = pendingClarifications.get(sessionId);
      const effectiveTranscript = pending ? pending.rewrittenPrompt(transcriptText) : transcriptText;
      const dependencies = createRuntimeDependencies(runtime, env);

      const result = await orchestrateVoiceMapTurn(
        {
          runtime,
          session: {
            id: sessionId
          },
          transcript: {
            text: effectiveTranscript,
            language: "zh-CN",
            isFinal: true
          } satisfies Transcript,
          mapContext
        },
        {
          llmProvider: dependencies.llmProvider,
          tools: dependencies.tools,
          telemetry
        }
      );

      if (result.responseMode === "clarification") {
        const routeCall = result.toolCalls.find((call) => call.toolName === "routeSummary");

        if (routeCall) {
          const originalFrom = String(routeCall.arguments.from);
          const originalTo = String(routeCall.arguments.to);
          const ambiguousRoute = result.toolResults.find(
            (toolResult) => toolResult.tool === "routeSummary" && toolResult.ambiguity
          );

          if (ambiguousRoute && ambiguousRoute.tool === "routeSummary") {
            const ambiguity = ambiguousRoute.ambiguity;
            if (!ambiguity) {
              return {
                result,
                trace: traceCollector.flush(),
                bindings: dependencies.bindings,
                warnings: dependencies.warnings
              };
            }

            pendingClarifications.set(sessionId, {
              rewrittenPrompt(selection) {
                return ambiguity.field === "from"
                  ? `展示从${selection}到${originalTo}的大致路线，并说明沿线重点地标`
                  : `展示从${originalFrom}到${selection}的大致路线，并说明沿线重点地标`;
              }
            });
          }
        } else {
          const poiCall = result.toolCalls.find((call) => call.toolName === "poiSearch");
          if (poiCall) {
            pendingClarifications.set(sessionId, {
              rewrittenPrompt(selection) {
                return `带我看看${selection}的重点区域`;
              }
            });
          }
        }
      } else {
        pendingClarifications.delete(sessionId);
      }

      return {
        result,
        trace: traceCollector.flush(),
        bindings: dependencies.bindings,
        warnings: dependencies.warnings
      };
    },
    async speakNarration(result) {
      await options.tts.speak(result.narration.text, result.narration.language);
    },
    interruptNarration() {
      options.tts.stop();
    },
    inspectRuntime(runtime) {
      const dependencies = createRuntimeDependencies(runtime, env);
      return {
        bindings: dependencies.bindings,
        warnings: dependencies.warnings
      };
    }
  };
}

export function createDemoAssistantService(tts: TtsAdapter): DemoAssistantService {
  return createAssistantService({ tts });
}
