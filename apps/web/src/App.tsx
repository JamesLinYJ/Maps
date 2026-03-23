import { useEffect, useRef, useState } from "react";

import { listMapProviders, resolveMapPolicy } from "@maps/compliance";
import {
  applyMapActionPlan,
  createInitialMapViewState,
  type MapViewState
} from "@maps/map-core";
import type { SafeTraceEvent } from "@maps/observability";
import type {
  AssistantTurnResult,
  Bounds,
  MapFeature,
  ProviderBindingSummary,
  RuntimeConfig,
  StackComponentSummary
} from "@maps/schemas";
import {
  defaultGeoAnchor,
  geoAnchorsByFeatureId,
  scenarioFeatures
} from "@maps/tools";
import { CompliancePanel, SectionCard, SourceCardList, StatusBadge } from "@maps/ui";
import {
  createBrowserAsrAdapter,
  createBrowserTtsAdapter,
  type AsrAdapter,
  type TtsAdapter,
  type VoiceStatus
} from "@maps/voice-core";

import {
  createFetchAssistantApiClient,
  type AssistantApiClient
} from "./api-client";

interface ConversationEntry {
  id: string;
  user: string;
  assistant: string;
  mode: AssistantTurnResult["responseMode"];
}

interface AppProps {
  asrAdapter?: AsrAdapter;
  ttsAdapter?: TtsAdapter;
  apiClient?: AssistantApiClient;
}

interface OSMReference {
  embedUrl: string;
  openUrl: string;
  headline: string;
  summary: string;
}

interface StageMetric {
  label: string;
  value: string;
}

type AppPage = "presenter" | "system";
type NavSection = readonly [label: string, id: string];

const FALLBACK_RUNTIME: RuntimeConfig = {
  mapMode: "internal",
  mapProvider: "osm",
  llmProvider: "openai",
  enableForeignMapExperiments: true
};

const LAYER_LABELS: Record<"vector" | "satellite", string> = {
  vector: "标准地图",
  satellite: "卫星视图"
};

const SAMPLE_REQUESTS = [
  "带我看看浦东新区的重点区域",
  "放大到这个园区，并讲解它的产业分布",
  "展示从机场到会展中心的大致路线，并说明沿线重点地标"
] as const;

const PRESENTER_TOP_SECTIONS: readonly NavSection[] = [
  ["总览", "overview"],
  ["地图", "stage"],
  ["输入", "voice"],
  ["会话", "history"],
  ["来源", "compliance"]
] as const;

const PRESENTER_SIDE_SECTIONS: readonly NavSection[] = [
  ["讲解概览", "overview"],
  ["语音输入", "voice"],
  ["地图舞台", "stage"],
  ["会话记录", "history"],
  ["来源合规", "compliance"]
] as const;

const SYSTEM_TOP_SECTIONS: readonly NavSection[] = [
  ["概览", "system-overview"],
  ["运行设置", "runtime"],
  ["Provider", "bindings"],
  ["诊断", "diagnostics"]
] as const;

const SYSTEM_SIDE_SECTIONS: readonly NavSection[] = [
  ["系统总览", "system-overview"],
  ["运行设置", "runtime"],
  ["Provider 绑定", "bindings"],
  ["架构与栈", "architecture"],
  ["事件追踪", "diagnostics"]
] as const;

function readPageFromLocation(): AppPage {
  if (typeof window === "undefined") {
    return "presenter";
  }

  const page = new URLSearchParams(window.location.search).get("page");
  return page === "system" ? "system" : "presenter";
}

function project(value: number, min: number, max: number) {
  return ((value - min) / Math.max(max - min, 0.01)) * 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getFeatureStyle(feature: MapFeature, bounds: Bounds) {
  const left = project(feature.bbox[0], bounds[0], bounds[2]);
  const top = project(feature.bbox[1], bounds[1], bounds[3]);
  const width = project(feature.bbox[2], bounds[0], bounds[2]) - left;
  const height = project(feature.bbox[3], bounds[1], bounds[3]) - top;

  return {
    left: `${left}%`,
    top: `${top}%`,
    width: `${width}%`,
    height: `${height}%`
  };
}

function getRoutePoints(path: [number, number][], bounds: Bounds) {
  return path
    .map(([x, y]) => `${project(x, bounds[0], bounds[2])},${project(y, bounds[1], bounds[3])}`)
    .join(" ");
}

function getActiveFeatureIds(mapState: MapViewState) {
  return Array.from(
    new Set([
      ...mapState.highlightedFeatureIds,
      ...mapState.callouts.map((callout) => callout.featureId),
      ...(mapState.routeOverlay?.landmarkFeatureIds ?? [])
    ])
  );
}

function buildOsmReference(mapState: MapViewState): OSMReference {
  const featureIds = getActiveFeatureIds(mapState);
  const anchors = featureIds
    .map((featureId) => ({
      feature: scenarioFeatures.find((feature) => feature.id === featureId),
      anchor: geoAnchorsByFeatureId[featureId]
    }))
    .filter(
      (item): item is { feature: MapFeature | undefined; anchor: { latitude: number; longitude: number } } =>
        Boolean(item.anchor)
    );

  const points = anchors.length > 0 ? anchors.map((item) => item.anchor) : [defaultGeoAnchor];
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const latPadding = Math.max(0.04, (maxLat - minLat) * 0.45);
  const lonPadding = Math.max(0.05, (maxLon - minLon) * 0.45);
  const south = clamp(minLat - latPadding, -85, 85);
  const north = clamp(maxLat + latPadding, -85, 85);
  const west = clamp(minLon - lonPadding, -180, 180);
  const east = clamp(maxLon + lonPadding, -180, 180);
  const centerLat = (south + north) / 2;
  const centerLon = (west + east) / 2;
  const featureNames = anchors
    .map((item) => item.feature?.name)
    .filter((name): name is string => Boolean(name));

  return {
    embedUrl: `https://www.openstreetmap.org/export/embed.html?bbox=${west}%2C${south}%2C${east}%2C${north}&layer=mapnik`,
    openUrl: `https://www.openstreetmap.org/?mlat=${centerLat}&mlon=${centerLon}#map=11/${centerLat}/${centerLon}`,
    headline:
      featureNames.length > 0
        ? `开放地图参考已聚焦 ${featureNames.slice(0, 3).join(" / ")}`
        : "开放地图参考底图",
    summary:
      featureNames.length > 1
        ? `当前开放底图会围绕 ${featureNames.join("、")} 给出参考视角，讲解事实仍以受控工具链和页面说明为准。`
        : featureNames.length === 1
          ? "当前开放底图用于补充参考视角，地图讲解和合规判断仍以受控链路说明为准。"
          : "等待你的请求后，底图会跟随当前讲解内容更新。"
  };
}

function formatModeLabel(mapMode: RuntimeConfig["mapMode"]) {
  switch (mapMode) {
    case "china_public":
      return "中国公开模式";
    case "internal":
      return "内部模式";
    case "experimental":
      return "实验模式";
  }
}

function formatStatusLabel(status: VoiceStatus) {
  switch (status) {
    case "idle":
      return "待命";
    case "listening":
      return "收音中";
    case "thinking":
      return "处理中";
    case "speaking":
      return "讲解中";
    case "error":
      return "异常";
  }
}

function nextRuntimeForMode(currentRuntime: RuntimeConfig, nextMapMode: RuntimeConfig["mapMode"]) {
  const nextExperiments =
    nextMapMode === "china_public" ? false : currentRuntime.enableForeignMapExperiments;
  const nextOptions = listMapProviders({
    ...currentRuntime,
    mapMode: nextMapMode,
    enableForeignMapExperiments: nextExperiments
  });
  const nextProvider = nextOptions.find((provider) => provider.id === currentRuntime.mapProvider);

  return {
    ...currentRuntime,
    mapMode: nextMapMode,
    enableForeignMapExperiments: nextExperiments,
    mapProvider: nextProvider?.enabled ? currentRuntime.mapProvider : "tianditu"
  };
}

function nextRuntimeForExperiments(currentRuntime: RuntimeConfig, enabled: boolean) {
  const nextOptions = listMapProviders({
    ...currentRuntime,
    enableForeignMapExperiments: enabled
  });
  const nextProvider = nextOptions.find((provider) => provider.id === currentRuntime.mapProvider);

  return {
    ...currentRuntime,
    enableForeignMapExperiments: enabled,
    mapProvider: nextProvider?.enabled ? currentRuntime.mapProvider : "tianditu"
  };
}

function EmptyStage(props: { title: string; body: string }) {
  return (
    <section className="empty-stage">
      <p className="eyebrow">{props.title}</p>
      <h2>等待新的地图讲解任务</h2>
      <p>{props.body}</p>
    </section>
  );
}

function PresentationStage(props: {
  mapState: MapViewState;
  title: string;
  summary: string;
  metrics: StageMetric[];
  features: MapFeature[];
}) {
  return (
    <div className="presentation-stage">
      <div className={`presentation-canvas layer-${props.mapState.activeLayer}`}>
        <div className="presentation-grid" />
        <div className="stage-metric-row">
          {props.metrics.map((metric) => (
            <article className="stage-metric" key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </article>
          ))}
        </div>
        <div className="north-indicator">N</div>
        <svg className="route-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
          {props.mapState.routeOverlay ? (
            <polyline
              className="route-line"
              points={getRoutePoints(props.mapState.routeOverlay.path, props.mapState.currentBounds)}
            />
          ) : null}
        </svg>
        {props.features.map((feature) => (
          <article
            className={`feature-card ${props.mapState.highlightedFeatureIds.includes(feature.id) ? "is-highlighted" : ""}`}
            key={feature.id}
            style={getFeatureStyle(feature, props.mapState.currentBounds)}
          >
            <span>{feature.kind}</span>
            <strong>{feature.name}</strong>
          </article>
        ))}
        {props.mapState.callouts.map((callout) => {
          const feature = scenarioFeatures.find((item) => item.id === callout.featureId);
          if (!feature) {
            return null;
          }

          return (
            <div
              className="callout-pin"
              key={`${callout.featureId}-${callout.title}`}
              style={{
                left: `${project(feature.centroid[0], props.mapState.currentBounds[0], props.mapState.currentBounds[2])}%`,
                top: `${project(feature.centroid[1], props.mapState.currentBounds[1], props.mapState.currentBounds[3])}%`
              }}
            >
              {callout.index ?? "•"}
            </div>
          );
        })}
      </div>
      <div className="presentation-caption">
        <p className="eyebrow">{props.title}</p>
        <h3>{LAYER_LABELS[props.mapState.activeLayer]}</h3>
        <p>{props.summary}</p>
      </div>
    </div>
  );
}

function renderSectionButtons(
  sections: readonly NavSection[],
  onSelect: (id: string) => void
) {
  return sections.map(([label, id]) => (
    <button className="nav-link" key={id} onClick={() => onSelect(id)} type="button">
      {label}
    </button>
  ));
}

export function App(props: AppProps) {
  const [page, setPage] = useState<AppPage>(readPageFromLocation);
  const [apiClient] = useState(
    () =>
      props.apiClient ??
      createFetchAssistantApiClient(
        (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000"
      )
  );
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [draft, setDraft] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [latestTrace, setLatestTrace] = useState<SafeTraceEvent[]>([]);
  const [latestResult, setLatestResult] = useState<AssistantTurnResult | null>(null);
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [tts] = useState(() => props.ttsAdapter ?? createBrowserTtsAdapter());
  const [asr] = useState(() => props.asrAdapter ?? createBrowserAsrAdapter("zh-CN"));
  const [runtime, setRuntime] = useState<RuntimeConfig>(FALLBACK_RUNTIME);
  const [providerBindings, setProviderBindings] = useState<ProviderBindingSummary[]>([]);
  const [providerWarnings, setProviderWarnings] = useState<string[]>([]);
  const [architectureSummary, setArchitectureSummary] = useState(
    "当前采用前端展示、Python 后端编排、AI 能力层、地图服务层和语音交互层协同运行。"
  );
  const [runtimeStack, setRuntimeStack] = useState<StackComponentSummary[]>([]);
  const [mapState, setMapState] = useState(() =>
    createInitialMapViewState(resolveMapPolicy(FALLBACK_RUNTIME))
  );
  const [sessionId] = useState("web-session");
  const [playerIndex, setPlayerIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let isMounted = true;

    void apiClient
      .getRuntime()
      .then((inspection) => {
        if (!isMounted) {
          return;
        }

        setRuntime(inspection.runtime);
        setProviderBindings(inspection.bindings);
        setProviderWarnings(inspection.warnings);
        setArchitectureSummary(inspection.architectureSummary);
        setRuntimeStack(inspection.stack);
        setMapState((current) => ({
          ...current,
          policy: resolveMapPolicy(inspection.runtime)
        }));
      })
      .catch((caughtError) => {
        if (!isMounted) {
          return;
        }

        setError(
          caughtError instanceof Error ? caughtError.message : "Failed to load runtime config"
        );
      });

    return () => {
      isMounted = false;
    };
  }, [apiClient]);

  useEffect(() => {
    try {
      setMapState((current) => ({
        ...current,
        policy: resolveMapPolicy(runtime)
      }));
      setError((current) =>
        current?.startsWith("china_public mode") || current?.startsWith("Non-domestic provider")
          ? null
          : current
      );
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Runtime config error");
    }
  }, [
    runtime.enableForeignMapExperiments,
    runtime.llmProvider,
    runtime.mapMode,
    runtime.mapProvider
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handlePopState = () => {
      setPage(readPageFromLocation());
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const hash = window.location.hash.replace("#", "");
    if (!hash) {
      return;
    }

    window.setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }, 80);
  }, [page]);

  function scrollToSection(sectionId: string) {
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }

  function scheduleScroll(sectionId?: string) {
    if (typeof window === "undefined") {
      return;
    }

    window.setTimeout(() => {
      if (sectionId) {
        scrollToSection(sectionId);
        return;
      }

      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 80);
  }

  function navigateToPage(nextPage: AppPage, sectionId?: string) {
    setPage(nextPage);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (nextPage === "presenter") {
        url.searchParams.delete("page");
      } else {
        url.searchParams.set("page", nextPage);
      }
      url.hash = sectionId ? sectionId : "";
      window.history.pushState({}, "", url);
    }

    scheduleScroll(sectionId);
  }

  function pulse() {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(10);
    }
  }

  async function speakResult(result: AssistantTurnResult) {
    setStatus("speaking");
    try {
      await tts.speak(result.narration.text, result.narration.language);
    } finally {
      setStatus("idle");
    }
  }

  async function runTurn(text: string) {
    const transcriptText = text.trim();
    if (!transcriptText) {
      inputRef.current?.focus();
      return;
    }

    tts.stop();
    asr.stop();
    setPartialTranscript("");
    setError(null);
    setStatus("thinking");
    pulse();

    try {
      const turnResponse = await apiClient.handleTurn({
        runtime,
        sessionId,
        transcriptText,
        mapContext: {
          currentBounds: mapState.currentBounds as [number, number, number, number],
          activeLayer: mapState.activeLayer,
          highlightedFeatureIds: mapState.highlightedFeatureIds
        }
      });

      setLatestTrace(turnResponse.trace);
      setLatestResult(turnResponse.result);
      setProviderBindings(turnResponse.bindings);
      setProviderWarnings(turnResponse.warnings);
      setArchitectureSummary(turnResponse.architectureSummary);
      setRuntimeStack(turnResponse.stack);
      setConversation((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          user: transcriptText,
          assistant: turnResponse.result.narration.text,
          mode: turnResponse.result.responseMode
        }
      ]);
      setMapState((current) =>
        applyMapActionPlan(
          {
            ...current,
            policy: turnResponse.result.policy
          },
          turnResponse.result.mapActionPlan
        )
      );
      setDraft("");
      await speakResult(turnResponse.result);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unexpected error");
      setStatus("error");
    }
  }

  async function handleMicrophone() {
    if (page !== "presenter") {
      navigateToPage("presenter", "voice");
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 120);
      return;
    }

    if (status === "listening") {
      asr.stop();
      return;
    }

    setError(null);
    tts.stop();
    pulse();

    await asr.start({
      onPartialTranscript(text) {
        setPartialTranscript(text);
      },
      onFinalTranscript(text) {
        setDraft(text);
        void runTurn(text);
      },
      onStatusChange(nextStatus) {
        setStatus(nextStatus);
      },
      onError(message) {
        setError(message);
      }
    });
  }

  function focusInput() {
    if (page !== "presenter") {
      navigateToPage("presenter", "voice");
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 120);
      return;
    }

    scrollToSection("voice");
    inputRef.current?.focus();
  }

  function loadSample(index: number) {
    setPlayerIndex(index);
    setDraft(SAMPLE_REQUESTS[index]);
    focusInput();
  }

  function handlePreviousPrompt() {
    loadSample((playerIndex - 1 + SAMPLE_REQUESTS.length) % SAMPLE_REQUESTS.length);
  }

  function handleNextPrompt() {
    loadSample((playerIndex + 1) % SAMPLE_REQUESTS.length);
  }

  const providerOptions = listMapProviders(runtime);
  const currentLayer = latestResult?.classification.requestedLayer ?? mapState.activeLayer;
  const currentProviderOption = providerOptions.find((provider) => provider.id === runtime.mapProvider);
  const activeFeatureIds = getActiveFeatureIds(mapState);
  const hasInteraction = conversation.length > 0 || latestResult !== null;
  const highlightedFeatures = activeFeatureIds
    .map((featureId) => scenarioFeatures.find((feature) => feature.id === featureId))
    .filter((feature): feature is MapFeature => Boolean(feature));
  const spotlightFeatures = activeFeatureIds
    .map((featureId) => scenarioFeatures.find((feature) => feature.id === featureId))
    .filter((feature): feature is MapFeature => Boolean(feature));
  const osmReference = buildOsmReference(mapState);
  const showOsmSurface =
    hasInteraction &&
    runtime.mapProvider === "osm" &&
    runtime.mapMode !== "china_public" &&
    runtime.enableForeignMapExperiments;
  const latestSourceCards = latestResult?.mapActionPlan.sourceCards ?? [];
  const conversationEntries = [...conversation].reverse();
  const stageSummary = latestResult?.mapActionPlan.summary ?? "等待你的请求。";
  const latestNarration =
    latestResult?.narration.text ?? "系统会在这里显示最新一轮的讲解摘要与口播内容。";
  const latestIntent = latestResult?.classification.intent ?? "awaiting_request";
  const liveTranscript = partialTranscript || draft || "等待语音输入或文本提交。";
  const focusTags = Array.from(new Set(spotlightFeatures.flatMap((feature) => feature.tags))).slice(0, 8);
  const anchor = geoAnchorsByFeatureId[activeFeatureIds[0] ?? ""] ?? defaultGeoAnchor;
  const stageMetrics: StageMetric[] = [
    { label: "模式", value: formatModeLabel(runtime.mapMode) },
    { label: "图层", value: LAYER_LABELS[currentLayer] },
    { label: "节点", value: String(mapState.callouts.length) }
  ];
  const systemStats: StageMetric[] = [
    { label: "Provider 绑定", value: String(providerBindings.length) },
    { label: "预警数", value: String(providerWarnings.length) },
    { label: "事件数", value: String(latestTrace.length) }
  ];
  const topSections = page === "presenter" ? PRESENTER_TOP_SECTIONS : SYSTEM_TOP_SECTIONS;
  const sideSections = page === "presenter" ? PRESENTER_SIDE_SECTIONS : SYSTEM_SIDE_SECTIONS;

  return (
    <div className="app-shell">
      <header className="natural-topbar">
        <div className="brand-block">
          <p className="eyebrow">Voice Map OS</p>
          <h1>语音地图讲解台</h1>
        </div>

        <nav className="top-nav" aria-label={page === "presenter" ? "讲解页导航" : "系统页导航"}>
          {renderSectionButtons(topSections, (sectionId) => scrollToSection(sectionId))}
        </nav>

        <div className="top-actions">
          <div className="page-switcher" aria-label="页面切换">
            <button
              aria-current={page === "presenter" ? "page" : undefined}
              className={`page-pill ${page === "presenter" ? "is-active" : ""}`}
              onClick={() => navigateToPage("presenter")}
              type="button"
            >
              讲解页
            </button>
            <button
              aria-current={page === "system" ? "page" : undefined}
              className={`page-pill ${page === "system" ? "is-active" : ""}`}
              onClick={() => navigateToPage("system")}
              type="button"
            >
              系统页
            </button>
          </div>

          {page === "presenter" ? (
            <>
              <label className="visually-hidden" htmlFor="quick-query">
                快速任务输入
              </label>
              <input
                className="quick-query"
                id="quick-query"
                onChange={(event) => setDraft(event.target.value)}
                placeholder="输入地图任务..."
                value={draft}
              />
              <button
                className="icon-button"
                onClick={() => navigateToPage("system", "runtime")}
                type="button"
              >
                设置
              </button>
              <button className="icon-button" onClick={() => void handleMicrophone()} type="button">
                {status === "listening" ? "停止收音" : "收音"}
              </button>
            </>
          ) : (
            <>
              <button
                className="icon-button"
                onClick={() => navigateToPage("presenter", "voice")}
                type="button"
              >
                返回讲解页
              </button>
              <button
                className="icon-button"
                onClick={() => scrollToSection("diagnostics")}
                type="button"
              >
                查看诊断
              </button>
            </>
          )}
        </div>
      </header>

      <div className={`page-layout page-layout-${page}`}>
        <aside className="natural-sidebar">
          <div className="sidebar-intro">
            <p className="eyebrow">当前状态</p>
            <StatusBadge status={status} />
            <p className="muted-copy">
              {page === "presenter"
                ? "这里保持用户主流程：输入、地图、讲解和来源说明。"
                : "这里集中放置系统设置、Provider 绑定与运行诊断。"}
            </p>
          </div>

          <nav className="sidebar-nav" aria-label={page === "presenter" ? "讲解页侧边导航" : "系统页侧边导航"}>
            {renderSectionButtons(sideSections, (sectionId) => scrollToSection(sectionId))}
          </nav>

          <div className="sidebar-footer">
            {page === "presenter" ? (
              <>
                <button className="primary-button" onClick={() => void handleMicrophone()} type="button">
                  {status === "listening" ? "停止收音" : "开始语音"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setDraft("请告诉我当前支持哪些地图讲解操作");
                    focusInput();
                  }}
                  type="button"
                >
                  帮助
                </button>
                <button
                  className="secondary-button"
                  onClick={() => navigateToPage("system", "diagnostics")}
                  type="button"
                >
                  系统诊断
                </button>
              </>
            ) : (
              <>
                <button
                  className="primary-button"
                  onClick={() => navigateToPage("presenter", "voice")}
                  type="button"
                >
                  返回讲解页
                </button>
                <button
                  className="secondary-button"
                  onClick={() => scrollToSection("runtime")}
                  type="button"
                >
                  调整设置
                </button>
                <button
                  className="secondary-button"
                  onClick={() => scrollToSection("bindings")}
                  type="button"
                >
                  查看绑定
                </button>
              </>
            )}
          </div>
        </aside>

        <main className="natural-main">
          {page === "presenter" ? (
            <>
              <section className="hero-panel" id="overview">
                <div className="hero-copy">
                  <p className="eyebrow">明亮、自然、只保留讲解主流程</p>
                  <h2>{hasInteraction ? latestNarration : "用一句自然中文，开始你的地图讲解。"}</h2>
                  <p>
                    {hasInteraction
                      ? stageSummary
                      : "用户页专注于语音输入、地图更新、讲解输出与来源说明。运行设置和技术诊断已被拆到单独系统页，避免打扰主流程。"}
                  </p>
                  <div className="hero-chips">
                    <span>{formatModeLabel(runtime.mapMode)}</span>
                    <span>{currentProviderOption?.displayName ?? runtime.mapProvider}</span>
                    <span>{runtime.llmProvider}</span>
                    <span>{LAYER_LABELS[currentLayer]}</span>
                  </div>
                </div>
                <div className="hero-stats">
                  <article>
                    <p>会话状态</p>
                    <strong>{formatStatusLabel(status)}</strong>
                  </article>
                  <article>
                    <p>当前意图</p>
                    <strong>{latestIntent}</strong>
                  </article>
                  <article>
                    <p>当前焦点</p>
                    <strong>{spotlightFeatures[0]?.name ?? "等待任务"}</strong>
                  </article>
                </div>
              </section>

              <div className="content-grid">
                <section className="stage-section" id="stage">
                  {hasInteraction ? (
                    showOsmSurface ? (
                      <section className="stage-shell stage-shell--osm">
                        <iframe
                          className="osm-frame"
                          loading="lazy"
                          referrerPolicy="no-referrer-when-downgrade"
                          src={osmReference.embedUrl}
                          title="osm-reference-surface"
                        />
                        <div className="floating-summary">
                          <p className="eyebrow">地理数据</p>
                          <h3>{spotlightFeatures[0]?.name ?? osmReference.headline}</h3>
                          <p>{osmReference.summary}</p>
                          <div className="inline-metrics">
                            <span>纬度 {anchor.latitude.toFixed(4)}°</span>
                            <span>经度 {anchor.longitude.toFixed(4)}°</span>
                          </div>
                        </div>
                        <div className="stage-inset">
                          <PresentationStage
                            features={highlightedFeatures}
                            mapState={mapState}
                            metrics={stageMetrics}
                            summary="这里同步展示讲解叠层、高亮和路线标记。"
                            title="讲解叠层"
                          />
                        </div>
                      </section>
                    ) : (
                      <PresentationStage
                        features={highlightedFeatures}
                        mapState={mapState}
                        metrics={stageMetrics}
                        summary={stageSummary}
                        title="地图主舞台"
                      />
                    )
                  ) : (
                    <EmptyStage
                      body="说一句话或输入一个地点、区域或路线需求后，地图和讲解内容才会开始生成。"
                      title="地图主舞台"
                    />
                  )}
                </section>

                <aside className="right-rail">
                  <div id="voice">
                    <SectionCard title="语音输入" subtitle="所有主按钮都能直接触发真实行为">
                      <div className="control-row">
                        <button className="primary-button" onClick={() => void handleMicrophone()} type="button">
                          {status === "listening" ? "停止收音" : "开始收音"}
                        </button>
                        <button
                          className="secondary-button"
                          onClick={() => {
                            tts.stop();
                            setStatus("idle");
                          }}
                          type="button"
                        >
                          打断讲解
                        </button>
                      </div>
                      <form
                        className="composer"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void runTurn(draft);
                        }}
                      >
                        <label htmlFor="transcript-input">任务输入</label>
                        <textarea
                          aria-label="transcript-input"
                          id="transcript-input"
                          onChange={(event) => setDraft(event.target.value)}
                          placeholder="请输入或说出你的地图请求"
                          ref={inputRef}
                          value={draft}
                        />
                        <button className="primary-button" type="submit">
                          提交任务
                        </button>
                      </form>
                      <div aria-live="polite" className="live-block">
                        <p className="eyebrow">实时转写</p>
                        <p>{liveTranscript}</p>
                      </div>
                      <div className="sample-list">
                        {SAMPLE_REQUESTS.map((command, index) => (
                          <button
                            className="secondary-button"
                            key={command}
                            onClick={() => loadSample(index)}
                            type="button"
                          >
                            {command}
                          </button>
                        ))}
                      </div>
                      {error ? <p className="error-text">{error}</p> : null}
                    </SectionCard>
                  </div>

                  <SectionCard title="辅助操作" subtitle="用户页只保留与讲解主流程直接相关的动作">
                    <div className="button-grid">
                      <button className="secondary-button" onClick={() => scrollToSection("stage")} type="button">
                        查看地图
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => scrollToSection("compliance")}
                        type="button"
                      >
                        查看来源
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => navigateToPage("system", "runtime")}
                        type="button"
                      >
                        打开系统页
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          if (latestResult) {
                            void speakResult(latestResult);
                          }
                        }}
                        type="button"
                      >
                        重播讲解
                      </button>
                    </div>
                  </SectionCard>

                  <SectionCard title="讲解内容" subtitle="当前高亮区域、讲解节点与主题标签">
                    <div aria-live="polite" className="live-block">
                      <p className="eyebrow">当前讲解</p>
                      <p>{latestNarration}</p>
                    </div>
                    <div className="spotlight-list">
                      {spotlightFeatures.length > 0 ? (
                        spotlightFeatures.map((feature) => (
                          <article className="spotlight-item" key={feature.id}>
                            <p className="eyebrow">{feature.kind}</p>
                            <h4>{feature.name}</h4>
                            <p>{feature.description}</p>
                          </article>
                        ))
                      ) : (
                        <p className="muted-copy">发起一次请求后，这里会出现当前高亮区域。</p>
                      )}
                    </div>
                    {focusTags.length > 0 ? (
                      <div className="tag-row">
                        {focusTags.map((tag) => (
                          <span className="tag-chip" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </SectionCard>

                  <div id="history">
                    <SectionCard title="会话记录" subtitle="最近几轮问答会保留在这里">
                      <div className="conversation-log">
                        {conversationEntries.length > 0 ? (
                          conversationEntries.map((entry) => (
                            <article className="conversation-entry" key={entry.id}>
                              <p className="conversation-user">用户：{entry.user}</p>
                              <p className="conversation-assistant">
                                系统：{entry.assistant}
                                {entry.mode === "clarification" ? "（澄清）" : ""}
                              </p>
                            </article>
                          ))
                        ) : (
                          <p className="muted-copy">你开始提问后，这里会保留最近几轮对话。</p>
                        )}
                      </div>
                    </SectionCard>
                  </div>

                  <div id="compliance">
                    <SectionCard title="来源与合规" subtitle="来源说明、审图号与合规提示保持可见">
                      <CompliancePanel policy={mapState.policy} />
                      <SourceCardList cards={latestSourceCards} />
                      {showOsmSurface ? (
                        <div className="live-block">
                          <p className="eyebrow">开放底图说明</p>
                          <p>
                            当前实验底图引用 OpenStreetMap。公开部署时不得将该路径替代中国公开模式下的国内合规
                            provider。
                          </p>
                        </div>
                      ) : null}
                    </SectionCard>
                  </div>
                </aside>
              </div>
            </>
          ) : (
            <>
              <section className="hero-panel system-hero" id="system-overview">
                <div className="hero-copy">
                  <p className="eyebrow">系统设置与技术诊断</p>
                  <h2>把用户无关的控制项单独收口到系统页。</h2>
                  <p>
                    这里集中承载运行模式、底图与模型切换、Provider 绑定、运行栈摘要和事件追踪。讲解主页面只保留用户真正会用到的交互。
                  </p>
                  <div className="hero-chips">
                    <span>{formatModeLabel(runtime.mapMode)}</span>
                    <span>{runtime.mapProvider}</span>
                    <span>{runtime.llmProvider}</span>
                  </div>
                </div>
                <div className="hero-stats">
                  {systemStats.map((metric) => (
                    <article key={metric.label}>
                      <p>{metric.label}</p>
                      <strong>{metric.value}</strong>
                    </article>
                  ))}
                </div>
              </section>

              <div className="system-grid">
                <div className="panel-stack">
                  <div id="runtime">
                    <SectionCard title="运行设置" subtitle="模式、底图与模型切换都集中到这里">
                      <label htmlFor="map-mode-select">
                        地图模式
                        <select
                          id="map-mode-select"
                          onChange={(event) =>
                            setRuntime(
                              nextRuntimeForMode(runtime, event.target.value as RuntimeConfig["mapMode"])
                            )
                          }
                          value={runtime.mapMode}
                        >
                          <option value="china_public">中国公开模式</option>
                          <option value="internal">内部模式</option>
                          <option value="experimental">实验模式</option>
                        </select>
                      </label>
                      <label htmlFor="map-provider-select">
                        底图提供方
                        <select
                          id="map-provider-select"
                          onChange={(event) =>
                            setRuntime({
                              ...runtime,
                              mapProvider: event.target.value as RuntimeConfig["mapProvider"]
                            })
                          }
                          value={runtime.mapProvider}
                        >
                          {providerOptions.map((provider) => (
                            <option disabled={!provider.enabled} key={provider.id} value={provider.id}>
                              {provider.id}
                              {provider.enabled ? "" : "（不可用）"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label htmlFor="llm-provider-select">
                        大模型提供方
                        <select
                          id="llm-provider-select"
                          onChange={(event) =>
                            setRuntime({
                              ...runtime,
                              llmProvider: event.target.value as RuntimeConfig["llmProvider"]
                            })
                          }
                          value={runtime.llmProvider}
                        >
                          <option value="openai">OpenAI-compatible</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="gemini">Gemini</option>
                        </select>
                      </label>
                      <label className="checkbox-row">
                        <input
                          checked={runtime.enableForeignMapExperiments}
                          disabled={runtime.mapMode === "china_public"}
                          onChange={(event) =>
                            setRuntime(nextRuntimeForExperiments(runtime, event.target.checked))
                          }
                          type="checkbox"
                        />
                        启用海外地图实验链路
                      </label>
                    </SectionCard>
                  </div>
                  <div id="architecture">
                    <SectionCard title="架构与运行栈" subtitle="保持前端、后端、AI、地图与语音分层清晰">
                      <div className="live-block">
                        <p className="eyebrow">架构摘要</p>
                        <p>{architectureSummary}</p>
                      </div>
                      <div className="source-grid">
                        {runtimeStack.length > 0 ? (
                          runtimeStack.map((item) => (
                            <article className="source-card" key={`${item.category}-${item.stack}`}>
                              <p className="source-provider">{item.category}</p>
                              <h3>{item.stack}</h3>
                              <p>{item.detail}</p>
                            </article>
                          ))
                        ) : (
                          <p className="muted-copy">运行时栈信息加载后会显示在这里。</p>
                        )}
                      </div>
                    </SectionCard>
                  </div>
                </div>

                <aside className="panel-stack">
                  <div id="bindings">
                    <SectionCard title="Provider 绑定" subtitle="统一查看当前 provider 接入状态与提示">
                      <div className="source-grid">
                        {providerBindings.length > 0 ? (
                          providerBindings.map((binding) => (
                            <article className="source-card" key={`${binding.kind}-${binding.providerId}`}>
                              <p className="source-provider">
                                {binding.kind} / {binding.providerId}
                              </p>
                              <h3>{binding.adapterMode}</h3>
                              <p>{binding.message}</p>
                            </article>
                          ))
                        ) : (
                          <p className="muted-copy">Provider 绑定信息加载后会显示在这里。</p>
                        )}
                      </div>
                    </SectionCard>
                  </div>

                  <div id="diagnostics">
                    <SectionCard title="运行诊断" subtitle="告警、追踪事件与调试信息都集中到这里">
                      {providerWarnings.length > 0 ? (
                        <div className="warning-list">
                          {providerWarnings.map((warning) => (
                            <p key={warning}>{warning}</p>
                          ))}
                        </div>
                      ) : (
                        <p className="muted-copy">当前没有 provider 告警。</p>
                      )}
                      <ul className="trace-list">
                        {latestTrace.length > 0 ? (
                          latestTrace.map((event, index) => (
                            <li key={`${event.event}-${index}`}>
                              <strong>{event.event}</strong>
                            </li>
                          ))
                        ) : (
                          <li>开始一次请求后，这里会显示对应的流程事件。</li>
                        )}
                      </ul>
                    </SectionCard>
                  </div>
                </aside>
              </div>
            </>
          )}
        </main>
      </div>

      {page === "presenter" ? (
        <div className="player-bar">
          <div className="player-controls">
            <button className="secondary-button" onClick={handlePreviousPrompt} type="button">
              上一条
            </button>
            <button
              className="primary-button"
              onClick={() => void runTurn(draft || SAMPLE_REQUESTS[playerIndex])}
              type="button"
            >
              立即讲解
            </button>
            <button className="secondary-button" onClick={handleNextPrompt} type="button">
              下一条
            </button>
          </div>
          <div className="player-track">
            <span>{SAMPLE_REQUESTS[playerIndex]}</span>
            <div className="progress-track">
              <div style={{ width: `${((playerIndex + 1) / SAMPLE_REQUESTS.length) * 100}%` }} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
