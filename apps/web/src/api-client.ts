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

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
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
      const response = await fetchWithTimeout(`${baseUrl}/api/runtime`, undefined, 12000);
      if (!response.ok) {
        throw await toError(response, "Failed to load runtime config");
      }
      return response.json();
    },
    async handleTurn(input) {
      // 把完整回合交给后端编排，前端只负责提交上下文并消费结构化结果。
      let response: Response;
      try {
        response = await fetchWithTimeout(
          `${baseUrl}/api/turn`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify(input)
          },
          30000
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error("地图请求处理时间过长，请重试或换一个更明确的地点。");
        }
        throw error;
      }

      if (!response.ok) {
        throw await toError(response, "Turn request failed");
      }

      return response.json();
    }
  };
}
