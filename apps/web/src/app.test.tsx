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
        mapProvider: "tianditu",
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
          providerId: "tianditu",
          adapterMode: "requires_configuration",
          credentialEnvVar: "TIANDITU_API_KEY",
          message: "TIANDITU_API_KEY 未提供，当前 map provider 需要补充真实服务配置。"
        }
      ],
      warnings: [
        "OPENAI_API_KEY 未配置，LLM provider 当前不可用。",
        "TIANDITU_API_KEY 未配置，当前 map provider 不可用。"
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
          baseMapProvider: "tianditu",
          providerDisplayName: "Tianditu",
          allowForeignProviders: false,
          requireAttributionDisplay: true,
          requireDomesticReviewNumber: true,
          reviewNumber: "审图号：GS(2024)1234号",
          attributionText: "地图数据通过天地图合规链路接入，正式上线时需使用真实授权服务。",
          disclaimerText: "当前配置遵循中国公开地图展示的合规默认值，地图事实仍需以真实合规服务返回为准。"
        },
        classification: {
          intent: "focus_area",
          confidence: 0.74,
          focusQuery: "浦东新区"
        },
        toolCalls: [],
        toolResults: [],
        mapActionPlan: {
          summary: "Prepared a focused presentation view.",
          actions: [
            {
              type: "fly_to_bounds",
              bounds: [56, 18, 90, 70],
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
              title: "Tianditu 合规底图链路",
              provider: "Tianditu",
              note: "公开模式默认使用国内合规 provider 抽象。"
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

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("keeps presenter flow on the main page and updates the narration after manual input", async () => {
    render(
      <App
        apiClient={stubApiClient}
        asrAdapter={unsupportedAsr}
        ttsAdapter={createSilentTtsAdapter()}
      />
    );

    expect(screen.getByText("语音地图讲解台")).toBeInTheDocument();
    expect(await screen.findByText("审图号：GS(2024)1234号")).toBeInTheDocument();
    expect(screen.queryByText("运行设置")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("transcript-input"), {
      target: { value: "带我看看浦东新区的重点区域" }
    });
    fireEvent.click(screen.getByRole("button", { name: "提交任务" }));

    expect(await screen.findByText(/系统：已为你聚焦浦东新区/)).toBeInTheDocument();
    expect(screen.getByText("地图主舞台")).toBeInTheDocument();
  });

  it("moves settings and diagnostics onto a dedicated system page", async () => {
    render(
      <App
        apiClient={stubApiClient}
        asrAdapter={unsupportedAsr}
        ttsAdapter={createSilentTtsAdapter()}
      />
    );

    fireEvent.click(screen.getAllByRole("button", { name: "系统页" })[0]);

    expect(await screen.findByRole("heading", { name: "运行设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Provider 绑定" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "运行诊断" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "语音输入" })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "返回讲解页" })[0]);

    expect(await screen.findByRole("heading", { name: "语音输入" })).toBeInTheDocument();
  });
});
