// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSilentTtsAdapter, type AsrAdapter } from "@maps/voice-core";

import { App } from "./App";
import type { AssistantApiClient } from "./api-client";

const unsupportedAsr: AsrAdapter = {
  isSupported: false,
  async start(callbacks) {
    callbacks.onError("当前浏览器不支持语音识别，请改用文本输入。");
  },
  stop() {
    return;
  }
};

const stubApiClient: AssistantApiClient = {
  async getRuntime() {
    return {
      runtime: {
        mapMode: "china_public",
        mapProvider: "amap",
        llmProvider: "openai",
        enableForeignMapExperiments: false
      },
      bindings: [
        {
          kind: "llm",
          providerId: "openai",
          adapterMode: "requires_configuration",
          credentialEnvVar: "OPENAI_API_KEY",
          message: "OPENAI_API_KEY 未提供，OpenAI-compatible LLM 路线当前需要补充真实服务配置。"
        },
        {
          kind: "map",
          providerId: "amap",
          adapterMode: "requires_configuration",
          credentialEnvVar: "AMAP_API_KEY",
          message: "AMAP_API_KEY 未提供，当前 map provider 需要补充真实服务配置。"
        }
      ],
      warnings: [
        "OPENAI_API_KEY 未配置，LLM provider 当前不可用。",
        "AMAP_API_KEY 未配置，当前 map provider 不可用。"
      ],
      architectureSummary:
        "当前原型采用前端展示 + Python 后端编排 + 多模型 AI 能力层 + 地图服务层 + 语音交互层的智能体式技术架构，并将 openai 路线按 OpenAI-compatible 接口族预留。",
      stack: [
        {
          category: "backend",
          stack: "Python + FastAPI + Uvicorn + Pydantic",
          detail: "负责请求接收、运行时配置、智能体编排与结构化返回。"
        }
      ]
    };
  },
  async handleTurn() {
    return {
      result: {
        responseMode: "answer",
        policy: {
          mapMode: "china_public",
          baseMapProvider: "amap",
          providerDisplayName: "Amap",
          allowForeignProviders: false,
          requireAttributionDisplay: true,
          requireDomesticReviewNumber: true,
          reviewNumber: "审图号：GS(2024)5678号",
          attributionText: "地图数据通过国内商业地图链路接入，正式上线时需保留供应商版权信息。",
          disclaimerText: "当前配置遵循中国公开地图展示的合规默认值，地图事实仍需以真实合规服务返回为准。"
        },
        classification: {
          intent: "focus_area",
          confidence: 0.74,
          focusQuery: "浦东新区"
        },
        toolCalls: [],
        toolResults: [],
        steps: [],
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
              featureIds: ["district-pudong"],
              style: "primary"
            },
            {
              type: "clear_route"
            },
            {
              type: "show_callouts",
              items: [
                {
                  featureId: "district-pudong",
                  title: "浦东新区",
                  body: "浦东新区区域视图，覆盖陆家嘴、张江等重点功能区。"
                }
              ]
            }
          ],
          sourceCards: [
            {
              id: "source-tianditu",
              title: "高德地图合规底图链路",
              provider: "Amap",
              note: "当前页面固定使用高德地图作为实时底图。"
            }
          ]
        },
        narration: {
          text: "已为你聚焦浦东新区，并高亮重点内容。",
          language: "zh-CN",
          grounding: []
        }
      },
      trace: [{ event: "narration_generated", sessionId: "web-session" }],
      bindings: [
        {
          kind: "llm",
          providerId: "openai",
          adapterMode: "requires_configuration",
          credentialEnvVar: "OPENAI_API_KEY",
          message: "OPENAI_API_KEY 未提供，OpenAI-compatible LLM 路线当前需要补充真实服务配置。"
        }
      ],
      warnings: [],
      architectureSummary:
        "当前原型采用前端展示 + Python 后端编排 + 多模型 AI 能力层 + 地图服务层 + 语音交互层的智能体式技术架构，并将 openai 路线按 OpenAI-compatible 接口族预留。",
      stack: [
        {
          category: "llm",
          stack: "Gemini / OpenAI-compatible / Anthropic",
          detail: "当前运行时优先使用 openai provider 抽象，并保留多模型切换能力。"
        }
      ]
    };
  }
};

function createPendingApiClient(): AssistantApiClient {
  return {
    async getRuntime() {
      return {
        runtime: {
          mapMode: "internal",
          mapProvider: "amap",
          llmProvider: "gemini",
          enableForeignMapExperiments: false
        },
        bindings: [],
        warnings: [],
        architectureSummary: "runtime-ready",
        stack: []
      };
    },
    async handleTurn() {
      return await new Promise(() => undefined);
    }
  };
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("keeps presenter flow on the main page and updates the map result after manual input", async () => {
    render(
      <App
        apiClient={stubApiClient}
        asrAdapter={unsupportedAsr}
        ttsAdapter={createSilentTtsAdapter()}
      />
    );

    expect(screen.getByText("语音地图展示台")).toBeInTheDocument();
    expect(await screen.findByText("审图号：GS(2024)5678号")).toBeInTheDocument();
    expect(screen.queryByText("运行设置")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("transcript-input"), {
      target: { value: "带我看看浦东新区的重点区域" }
    });
    fireEvent.click(screen.getByRole("button", { name: "提交任务" }));

    expect(await screen.findByText(/结果：已为你聚焦浦东新区/)).toBeInTheDocument();
    expect(screen.getByText("纬度 39.9090°")).toBeInTheDocument();
    expect(screen.getByText("经度 116.3970°")).toBeInTheDocument();

    fireEvent.click(screen.getByText("展开 AI 处理过程"));
    expect(screen.getByText("意图识别")).toBeInTheDocument();
    expect(screen.getByText("步骤执行")).toBeInTheDocument();
    expect(screen.getByText("工具调用")).toBeInTheDocument();
    expect(screen.getAllByText("地图动作").length).toBeGreaterThan(0);
  });

  it("moves settings and diagnostics onto a dedicated system page", async () => {
    window.history.pushState({}, "", "/?page=system");

    render(
      <App
        apiClient={stubApiClient}
        asrAdapter={unsupportedAsr}
        ttsAdapter={createSilentTtsAdapter()}
      />
    );

    expect(await screen.findByRole("heading", { name: "运行设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Provider 绑定" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "运行诊断" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "OpenAI-compatible" })).toBeInTheDocument();
    expect(screen.getByLabelText("当前模型")).toBeInTheDocument();
    expect(screen.getByLabelText("模型环境变量")).toHaveValue("OPENAI_MODEL");
    expect(screen.getByRole("option", { name: "qwen3.5-flash" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "OpenAI 兼容模式" })).toHaveAttribute(
      "href",
      "https://help.aliyun.com/zh/model-studio/context-cache"
    );
    expect(screen.queryByRole("heading", { name: "语音输入" })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "返回展示页" })[0]);

    expect(await screen.findByRole("heading", { name: "语音输入" })).toBeInTheDocument();
  });

  it("keeps the presenter page free of any settings entry", async () => {
    render(
      <App
        apiClient={stubApiClient}
        asrAdapter={unsupportedAsr}
        ttsAdapter={createSilentTtsAdapter()}
      />
    );

    await screen.findByText("语音地图展示台");

    expect(screen.queryByRole("button", { name: "系统页" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开系统页" })).not.toBeInTheDocument();
  });

  it("shows a visible processing state while waiting for the backend turn result", async () => {
    render(
      <App
        apiClient={createPendingApiClient()}
        asrAdapter={unsupportedAsr}
        ttsAdapter={createSilentTtsAdapter()}
      />
    );

    fireEvent.change(screen.getByLabelText("transcript-input"), {
      target: { value: "带我看看浦东新区" }
    });
    fireEvent.click(await screen.findByRole("button", { name: "提交任务" }));

    expect(await screen.findAllByText("处理中")).not.toHaveLength(0);
    expect(screen.getByText("正在分析你的请求，并准备地图结果。")).toBeInTheDocument();
    expect(screen.getByText("已经收到请求，正在等待 Gemini 和高德工具返回结果。")).toBeInTheDocument();
  });
});
