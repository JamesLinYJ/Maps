import type {
  AssistantTurnResult,
  ProviderBindingSummary,
  RuntimeConfig,
  StackComponentSummary
} from "@maps/schemas";
import type { SafeTraceEvent } from "@maps/observability";

export interface RuntimeInspection {
  runtime: RuntimeConfig;
  bindings: ProviderBindingSummary[];
  warnings: string[];
  architectureSummary: string;
  stack: StackComponentSummary[];
}

export interface TurnResponse {
  result: AssistantTurnResult;
  trace: SafeTraceEvent[];
  bindings: ProviderBindingSummary[];
  warnings: string[];
  architectureSummary: string;
  stack: StackComponentSummary[];
}

export interface AssistantApiClient {
  getRuntime(): Promise<RuntimeInspection>;
  handleTurn(input: {
    runtime: RuntimeConfig;
    sessionId: string;
    transcriptText: string;
    mapContext: {
      currentBounds: [number, number, number, number];
      activeLayer: "vector" | "satellite";
      highlightedFeatureIds: string[];
    };
  }): Promise<TurnResponse>;
}

function resolveDefaultApiBaseUrl() {
  if (typeof window === "undefined") {
    return "http://127.0.0.1:8000";
  }

  const { protocol, hostname, port } = window.location;

  // 开发态的 Vite 页面默认仍然走本地 8000 后端；生产态改为同源部署。
  if (hostname === "127.0.0.1" && port === "5173") {
    return "http://127.0.0.1:8000";
  }

  return `${protocol}//${window.location.host}`;
}

export function createFetchAssistantApiClient(baseUrl = resolveDefaultApiBaseUrl()): AssistantApiClient {
  async function toError(response: Response, fallback: string) {
    try {
      const payload = (await response.json()) as { detail?: string };
      return new Error(payload.detail ?? `${fallback}: ${response.status}`);
    } catch {
      return new Error(`${fallback}: ${response.status}`);
    }
  }

  return {
    async getRuntime() {
      // 前端只依赖稳定 HTTP 契约，具体 provider 差异都由后端封装。
      const response = await fetch(`${baseUrl}/api/runtime`);
      if (!response.ok) {
        throw await toError(response, "Failed to load runtime config");
      }
      return response.json();
    },
    async handleTurn(input) {
      // 把完整回合交给后端编排，前端只负责提交上下文并消费结构化结果。
      const response = await fetch(`${baseUrl}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        throw await toError(response, "Turn request failed");
      }

      return response.json();
    }
  };
}
