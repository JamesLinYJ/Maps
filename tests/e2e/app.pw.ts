import { expect, test } from "@playwright/test";

function createRuntimePayload() {
  return {
    runtime: {
      mapMode: "internal",
      mapProvider: "amap",
      llmProvider: "gemini",
      enableForeignMapExperiments: false
    },
    bindings: [
      {
        kind: "llm",
        providerId: "gemini",
        adapterMode: "pydanticai_direct",
        credentialEnvVar: "GEMINI_API_KEY",
        message: "GEMINI_API_KEY 已提供。"
      },
      {
        kind: "map",
        providerId: "amap",
        adapterMode: "amap_official_mcp",
        credentialEnvVar: "AMAP_API_KEY",
        message: "高德 MCP 已接通。"
      }
    ],
    warnings: [],
    architectureSummary: "frontend-e2e-runtime",
    stack: []
  };
}

function createTurnPayload() {
  return {
    result: {
      responseMode: "answer",
      policy: {
        mapMode: "internal",
        baseMapProvider: "amap",
        providerDisplayName: "Amap",
        allowForeignProviders: false,
        requireAttributionDisplay: true,
        requireDomesticReviewNumber: false,
        reviewNumber: null,
        attributionText: "地图数据通过国内商业地图链路接入。",
        disclaimerText: "当前为内部模式。"
      },
      classification: {
        intent: "focus_area",
        confidence: 0.88,
        requestedLayer: null,
        focusQuery: "浦东新区",
        route: null,
        pointQueries: null
      },
      steps: [],
      toolCalls: [
        {
          toolName: "poiSearch",
          arguments: {
            query: "浦东新区"
          }
        }
      ],
      toolResults: [
        {
          tool: "poiSearch",
          query: "浦东新区",
          isAmbiguous: false,
          features: [
            {
              id: "amap-poi-pudong",
              name: "浦东新区",
              aliases: ["上海市浦东新区"],
              kind: "district",
              description: "浦东新区",
              bbox: [116.347, 39.859, 116.447, 39.959],
              centroid: [116.397, 39.909],
              tags: ["district"],
              narrativeBullets: ["浦东新区"]
            }
          ],
          sourceCards: [
            {
              id: "source-amap-mcp",
              title: "高德官方 MCP 工具链",
              provider: "AMap MCP",
              note: "浏览器测试桩"
            }
          ]
        }
      ],
      mapActionPlan: {
        summary: "已生成地图聚焦展示视图。",
        actions: [
          {
            type: "fly_to_bounds",
            bounds: [116.347, 39.859, 116.447, 39.959],
            reason: "Focus on 浦东新区"
          },
          {
            type: "highlight_features",
            featureIds: ["amap-poi-pudong"],
            style: "primary"
          },
          {
            type: "show_callouts",
            items: [
              {
                featureId: "amap-poi-pudong",
                title: "浦东新区",
                body: "浦东新区",
                index: 1
              }
            ]
          }
        ],
        sourceCards: [
          {
            id: "source-amap-mcp",
            title: "高德官方 MCP 工具链",
            provider: "AMap MCP",
            note: "浏览器测试桩"
          }
        ]
      },
      narration: {
        text: "已为你聚焦浦东新区，并更新地图。",
        language: "zh-CN",
        grounding: ["amap-poi-pudong"]
      },
      clarification: null
    },
    trace: [
      { event: "voice_session_started", sessionId: "web-session" },
      { event: "intent_classified", sessionId: "web-session" },
      { event: "tool_calls_completed", sessionId: "web-session" },
      { event: "map_action_plan_generated", sessionId: "web-session" }
    ],
    bindings: createRuntimePayload().bindings,
    warnings: [],
    architectureSummary: "frontend-e2e-turn",
    stack: []
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const MapStub = class {
      setFitView() {}
      setBounds() {}
      setLayers() {}
      destroy() {}
    };
    const MarkerStub = class {
      setMap() {}
    };
    const PolylineStub = class {
      setMap() {}
    };
    const TileLayerBase = class {};
    TileLayerBase.Satellite = class {};
    TileLayerBase.RoadNet = class {};

    (window as typeof window & { AMap?: unknown }).AMap = {
      Map: MapStub,
      Marker: MarkerStub,
      Polyline: PolylineStub,
      Bounds: class {},
      TileLayer: TileLayerBase
    };
  });

  await page.route("**/api/runtime", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createRuntimePayload())
    });
  });
});

test("presenter page supports submitting a map request and viewing the process panel", async ({
  page
}) => {
  await page.route("**/api/turn", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createTurnPayload())
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "语音地图展示台" })).toBeVisible();
  await expect(page.getByRole("button", { name: "提交任务", exact: true })).toBeVisible();

  await page.getByLabel("transcript-input").fill("带我看看浦东新区的重点区域");
  const turnResponse = page.waitForResponse("**/api/turn");
  await page.getByRole("button", { name: "提交任务", exact: true }).click();
  await turnResponse;

  await expect(
    page.getByRole("heading", { name: "已为你聚焦浦东新区，并更新地图。", exact: true })
  ).toBeVisible();
  await expect(page.getByText("纬度 39.9090°", { exact: true })).toBeVisible();
  await expect(page.getByText("经度 116.3970°", { exact: true })).toBeVisible();
  await page.getByText("展开 AI 处理过程").click();
  await expect(page.getByText("意图识别")).toBeVisible();
  await expect(page.getByText("工具调用")).toBeVisible();
  await expect(page.getByText("poiSearch(浦东新区)", { exact: true })).toBeVisible();
});

test("system page shows runtime settings and diagnostics", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "系统页", exact: true }).click();

  await expect(page.getByRole("heading", { name: "运行设置", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Provider 绑定", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行诊断", exact: true })).toBeVisible();
  await expect(page.getByText("模型链路")).toBeVisible();
});
