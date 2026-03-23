import { useEffect, useState } from "react";

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

const FALLBACK_RUNTIME: RuntimeConfig = {
  // 本地默认走内部模式，避免页面一打开就落到中国公开模式的严格约束里。
  mapMode: "internal",
  mapProvider: "osm",
  llmProvider: "openai",
  enableForeignMapExperiments: true
};

const LAYER_LABELS: Record<"vector" | "satellite", string> = {
  vector: "标准地图",
  satellite: "卫星视图"
};

const OPS_MENU = ["语音会话", "地图舞台", "讲解节点", "合规显示", "运行栈"] as const;

const SAMPLE_REQUESTS = [
  "带我看看浦东新区的重点区域",
  "放大到这个园区，并讲解它的产业分布",
  "展示从机场到会展中心的大致路线，并说明沿线重点地标"
] as const;

function projectToViewport(value: number, min: number, max: number) {
  return ((value - min) / Math.max(max - min, 0.01)) * 100;
}

function getFeatureStyle(feature: MapFeature, bounds: Bounds) {
  const left = projectToViewport(feature.bbox[0], bounds[0], bounds[2]);
  const top = projectToViewport(feature.bbox[1], bounds[1], bounds[3]);
  const width = projectToViewport(feature.bbox[2], bounds[0], bounds[2]) - left;
  const height = projectToViewport(feature.bbox[3], bounds[1], bounds[3]) - top;

  return {
    left: `${left}%`,
    top: `${top}%`,
    width: `${width}%`,
    height: `${height}%`
  };
}

function getRoutePoints(path: [number, number][], bounds: Bounds) {
  return path
    .map(([x, y]) => {
      const px = projectToViewport(x, bounds[0], bounds[2]);
      const py = projectToViewport(y, bounds[1], bounds[3]);
      return `${px},${py}`;
    })
    .join(" ");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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
    .filter((item): item is { feature: MapFeature | undefined; anchor: { latitude: number; longitude: number } } =>
      Boolean(item.anchor)
    );

  const points =
    anchors.length > 0
      ? anchors.map((item) => item.anchor)
      : [defaultGeoAnchor];

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
  const headline =
    featureNames.length > 0
      ? `OSM 实验参考底图已聚焦 ${featureNames.slice(0, 3).join(" / ")}`
      : "OSM 参考底图";

  return {
    embedUrl: `https://www.openstreetmap.org/export/embed.html?bbox=${west}%2C${south}%2C${east}%2C${north}&layer=mapnik`,
    openUrl: `https://www.openstreetmap.org/?mlat=${centerLat}&mlon=${centerLon}#map=11/${centerLat}/${centerLon}`,
    headline,
    summary:
      featureNames.length > 1
        ? `当前实验底图会围绕 ${featureNames.join("、")} 给出开放街图参考视角，讲解事实仍以受控工具链和页面说明为准。`
        : featureNames.length === 1
          ? "当前实验底图用于补充开放街图参考视角，地图讲解和合规判断仍以页面中的受控链路说明为准。"
          : "等待你的请求后，底图会跟随当前讲解内容更新。"
  };
}

function EmptyStage(props: { title: string; body: string }) {
  return (
    <section className="empty-stage-shell">
      <div className="empty-stage-content">
        <p className="surface-kicker">{props.title}</p>
        <h2>等待你的请求</h2>
        <p>{props.body}</p>
      </div>
    </section>
  );
}

function renderCalloutPins(mapState: MapViewState) {
  return mapState.callouts.map((callout) => {
    const feature = scenarioFeatures.find((item) => item.id === callout.featureId);
    if (!feature) {
      return null;
    }

    const style = {
      left: `${projectToViewport(
        feature.centroid[0],
        mapState.currentBounds[0],
        mapState.currentBounds[2]
      )}%`,
      top: `${projectToViewport(
        feature.centroid[1],
        mapState.currentBounds[1],
        mapState.currentBounds[3]
      )}%`
    };

    return (
      <div className="callout-pin" key={`${callout.featureId}-${callout.title}`} style={style}>
        <span>{callout.index ?? "•"}</span>
      </div>
    );
  });
}

function PresentationStage(props: {
  mapState: MapViewState;
  compact?: boolean;
  title: string;
  summary: string;
  metrics: StageMetric[];
  features: MapFeature[];
  emptyLabel?: string;
}) {
  const hasContent =
    props.features.length > 0 ||
    props.mapState.callouts.length > 0 ||
    Boolean(props.mapState.routeOverlay);

  return (
    <div className={`stage-surface ${props.compact ? "is-compact" : ""}`}>
      <div className={`map-stage layer-${props.mapState.activeLayer}`}>
        <div className="stage-frame">
          <span className="frame-corner corner-top-left" />
          <span className="frame-corner corner-top-right" />
          <span className="frame-corner corner-bottom-left" />
          <span className="frame-corner corner-bottom-right" />
        </div>
        <div className="north-indicator">
          <span>N</span>
        </div>
        <div className="stage-metric-ribbon">
          {props.metrics.map((metric) => (
            <article className="stage-metric" key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </article>
          ))}
        </div>
        <div className="map-grid" />
        <svg className="route-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
          {props.mapState.routeOverlay ? (
            <polyline
              points={getRoutePoints(props.mapState.routeOverlay.path, props.mapState.currentBounds)}
              className="route-line"
            />
          ) : null}
        </svg>
        {props.features.map((feature) => {
          const isHighlighted = props.mapState.highlightedFeatureIds.includes(feature.id);
          const style = getFeatureStyle(feature, props.mapState.currentBounds);

          return (
            <article
              className={`feature-card ${isHighlighted ? "is-highlighted" : ""}`}
              key={feature.id}
              style={style}
            >
              <span className="feature-kind">{feature.kind}</span>
              <strong>{feature.name}</strong>
            </article>
          );
        })}
        {renderCalloutPins(props.mapState)}
        {!hasContent && !props.compact ? (
          <div className="stage-empty">
            <p className="surface-kicker">准备开始</p>
            <h3>{props.emptyLabel ?? "等待你的请求"}</h3>
          </div>
        ) : null}
      </div>
      <div className="surface-caption">
        <p className="surface-kicker">{props.title}</p>
        <h3>{LAYER_LABELS[props.mapState.activeLayer]}</h3>
        <p>{props.summary}</p>
      </div>
    </div>
  );
}

function updateRuntimeForMode(
  currentRuntime: RuntimeConfig,
  nextMapMode: RuntimeConfig["mapMode"]
) {
  // 切到 china_public 时自动收紧实验开关，并把不合规底图切回国内默认值。
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

function updateRuntimeForExperiments(
  currentRuntime: RuntimeConfig,
  enabled: boolean
) {
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

export function App(props: AppProps) {
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
        current?.startsWith("china_public mode") ||
        current?.startsWith("Non-domestic provider")
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
      return;
    }

    // 新一轮回合开始前先停掉收音和播报，避免回声把同一句话重复触发。
    tts.stop();
    asr.stop();
    setPartialTranscript("");
    setError(null);
    setStatus("thinking");

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
    if (status === "listening") {
      asr.stop();
      return;
    }

    setError(null);
    tts.stop();

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
  // 这个分支只给实验参考视角使用，不得替代中国公开模式下的合规底图。
  const latestSourceCards = latestResult?.mapActionPlan.sourceCards ?? [];
  const conversationEntries = [...conversation].reverse();
  const stageSummary =
    latestResult?.mapActionPlan.summary ??
    "等待你的请求。";
  const heroMetrics: StageMetric[] = [
    {
      label: "对话轮次",
      value: String(conversation.length)
    },
    {
      label: "高亮对象",
      value: String(activeFeatureIds.length)
    },
    {
      label: "来源卡片",
      value: String(latestSourceCards.length)
    }
  ];
  const stageMetrics: StageMetric[] = [
    {
      label: "模式",
      value: formatModeLabel(runtime.mapMode)
    },
    {
      label: "图层",
      value: LAYER_LABELS[currentLayer]
    },
    {
      label: "节点",
      value: String(mapState.callouts.length)
    }
  ];
  const latestNarration =
    latestResult?.narration.text ?? "系统会在这里显示最新一轮的讲解摘要与口播内容。";
  const latestIntent = latestResult?.classification.intent ?? "awaiting_request";
  const focusTags = Array.from(
    new Set(spotlightFeatures.flatMap((feature) => feature.tags))
  ).slice(0, 8);
  const liveTranscript = partialTranscript || draft || "等待语音输入或文本提交。";
  const topBindings = providerBindings.slice(0, 3);
  const topWarnings = providerWarnings.slice(0, 3);

  return (
    <div className="app-shell">
      <div className="background-blur blur-left" />
      <div className="background-blur blur-right" />

      <header className="hero-band">
        <div className="hero-copy">
          <p className="eyebrow">VOICE_MAP_OS</p>
          <h1>语音地图讲解控制台</h1>
          <p className="hero-alias">中文语音输入 / 地图聚焦 / 智能讲解</p>
          <p className="hero-lead">
            用一句自然中文，就能让系统完成语音识别、意图理解、工具调用、地图聚焦与讲解输出，适合区域、园区、路线和重点地标演示。
          </p>
          <div className="hero-inline-list">
            <span>{formatModeLabel(runtime.mapMode)}</span>
            <span>{currentProviderOption?.displayName ?? runtime.mapProvider}</span>
            <span>{runtime.llmProvider}</span>
            <span>{LAYER_LABELS[currentLayer]}</span>
          </div>
          <div className="hero-signal">
            <div className="signal-bars" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <p>地图事实、路线和高亮内容由受控工具链生成，模型只负责理解、规划和讲解，不直接决定地理事实。</p>
          </div>
        </div>

        <div className="hero-stats">
          <article className="hero-stat">
            <p className="stat-label">系统状态</p>
            <StatusBadge status={status} />
          </article>
          <article className="hero-stat">
            <p className="stat-label">地图模式</p>
            <strong>{currentProviderOption?.displayName ?? runtime.mapProvider}</strong>
            <span>{formatModeLabel(runtime.mapMode)}</span>
          </article>
          <article className="hero-stat">
            <p className="stat-label">当前焦点</p>
            <strong>{spotlightFeatures[0]?.name ?? "等待新讲解"}</strong>
            <span>{formatStatusLabel(status)}</span>
          </article>
        </div>
      </header>

      {hasInteraction ? (
        <section className="metric-strip" aria-label="session-overview">
          {heroMetrics.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <p>{metric.label}</p>
              <strong>{metric.value}</strong>
            </article>
          ))}
        </section>
      ) : null}

      <main className="console-grid">
        <section className="atlas-board">
          {hasInteraction ? (
            <section className="narration-banner">
              <div className="narration-copy">
                <p className="board-kicker">当前讲解</p>
                <h2>{latestNarration}</h2>
                <p>
                  当前意图：<strong>{latestIntent}</strong>
                </p>
              </div>
              <div className="narration-meta">
                <article>
                  <span>运行模式</span>
                  <strong>{formatModeLabel(runtime.mapMode)}</strong>
                </article>
                <article>
                  <span>当前底图</span>
                  <strong>{currentProviderOption?.displayName ?? runtime.mapProvider}</strong>
                </article>
                <article>
                  <span>会话状态</span>
                  <strong>{formatStatusLabel(status)}</strong>
                </article>
              </div>
            </section>
          ) : null}

          <div className="board-header">
            <div>
              <p className="board-kicker">主舞台</p>
              <h2>地图主视图</h2>
              <p>{stageSummary}</p>
            </div>
            <div className="board-chip-row">
              <span className="info-chip">{formatModeLabel(runtime.mapMode)}</span>
              <span className="info-chip">{currentProviderOption?.displayName ?? runtime.mapProvider}</span>
              <span className="info-chip">{runtime.llmProvider}</span>
            </div>
          </div>

          <div className="board-grid">
            <div className="surface-stack">
              {!hasInteraction ? (
                <EmptyStage
                  body="说一句话或输入一个地点、区域或路线需求后，地图和讲解内容才会开始生成。"
                  title="地图主视图"
                />
              ) : showOsmSurface ? (
                <section className="osm-stage-card">
                  <iframe
                    className="osm-frame"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    src={osmReference.embedUrl}
                    title="osm-reference-surface"
                  />
                  <div className="osm-overlay">
                    <p className="surface-kicker">OSM 参考底图</p>
                    <h3>{osmReference.headline}</h3>
                    <p>{osmReference.summary}</p>
                    <div className="osm-actions">
                      <a href={osmReference.openUrl} rel="noreferrer" target="_blank">
                        在 OpenStreetMap 打开
                      </a>
                      <span>© OpenStreetMap contributors</span>
                    </div>
                  </div>
                  <div className="stage-inset">
                    {hasInteraction ? (
                      <PresentationStage
                        compact
                        emptyLabel="等待更新"
                        features={highlightedFeatures}
                        mapState={mapState}
                        metrics={stageMetrics}
                        summary="这里会同步展示讲解叠层、高亮和路线标记。"
                        title="讲解叠层"
                      />
                    ) : null}
                  </div>
                </section>
              ) : (
                <PresentationStage
                  emptyLabel="说一句话或输入一个地点，地图会在这里更新"
                  features={highlightedFeatures}
                  mapState={mapState}
                  metrics={stageMetrics}
                  summary={hasInteraction ? "这里会显示当前地图聚焦、高亮和讲解叠层。" : "等待你的操作。"}
                  title="讲解主视图"
                />
              )}

              {!showOsmSurface && runtime.enableForeignMapExperiments ? (
                <section className="reference-strip">
                  <div className="reference-copy">
                    <p className="surface-kicker">可选参考</p>
                    <h3>OSM 参考底图已就绪</h3>
                    <p>
                      如果你想看开放街图参考视角，可以把地图 provider 切到 `osm`；当前主舞台仍保持讲解优先的展示布局。
                    </p>
                  </div>
                  <iframe
                    className="reference-frame"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    src={osmReference.embedUrl}
                    title="osm-reference-preview"
                  />
                </section>
              ) : null}
            </div>

            <div className="insight-column">
              <article className="insight-card">
                <p className="card-kicker">重点区域</p>
                <h3>当前讲解重点</h3>
                <div className="spotlight-list">
                  {spotlightFeatures.length > 0 ? (
                    spotlightFeatures.map((feature) => (
                      <article className="spotlight-item" key={feature.id}>
                        <div className="spotlight-heading">
                          <p className="feature-kind">{feature.kind}</p>
                          <h4>{feature.name}</h4>
                        </div>
                        <p>{feature.description}</p>
                        {feature.narrativeBullets.length > 0 ? (
                          <div className="tag-row">
                            {feature.narrativeBullets.map((bullet) => (
                              <span className="tag-chip" key={`${feature.id}-${bullet}`}>
                                {bullet}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <p className="empty-copy">发起一次请求后，这里才会出现当前高亮的区域和地点。</p>
                  )}
                </div>
              </article>

              <article className="insight-card">
                <p className="card-kicker">讲解卡片</p>
                <h3>讲解节点</h3>
                <div className="callout-stack">
                  {mapState.callouts.length > 0 ? (
                    mapState.callouts.map((callout) => (
                      <article className="callout-card" key={`${callout.featureId}-${callout.title}`}>
                        <p className="callout-index">{callout.index ? `0${callout.index}` : "重点"}</p>
                        <div>
                          <h4>{callout.title}</h4>
                          <p>{callout.body}</p>
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="empty-copy">地图完成一次讲解规划后，这里会出现对应的讲解节点。</p>
                  )}
                </div>
              </article>

              <article className="insight-card">
                <p className="card-kicker">主题标签</p>
                <h3>主题标签</h3>
                {focusTags.length > 0 ? (
                  <div className="tag-row">
                    {focusTags.map((tag) => (
                      <span className="tag-chip" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="empty-copy">有实际讲解内容后，这里会自动汇总主题标签。</p>
                )}
              </article>

              {mapState.routeOverlay ? (
                <article className="insight-card route-summary-card">
                  <p className="card-kicker">路线摘要</p>
                  <h3>路线讲解摘要</h3>
                  <p>{mapState.routeOverlay.summary}</p>
                </article>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="control-rail">
          <section className="ops-section">
            <p className="eyebrow">操作导航</p>
            <div className="ops-menu">
              {OPS_MENU.map((item, index) => (
                <article className="ops-menu-item" key={item}>
                  <span>{`0${index + 1}`}</span>
                  <strong>{item}</strong>
                </article>
              ))}
            </div>
          </section>

          <SectionCard title="开始使用" subtitle="说一句话或输入文字，系统会自动帮你定位和讲解">
            <div className="control-row">
              <button className="primary-button" type="button" onClick={handleMicrophone}>
                {status === "listening" ? "停止收音" : "启动语音"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  tts.stop();
                  setStatus("idle");
                }}
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
              <textarea
                aria-label="transcript-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="请输入或说出你的地图请求"
              />
              <button className="primary-button" type="submit">
                发送任务
              </button>
            </form>
            <div className="transcript-block">
              <p className="transcript-label">实时转写</p>
              <p>{liveTranscript}</p>
            </div>
            <div className="sample-command-list">
              {SAMPLE_REQUESTS.map((command) => (
                <button
                  className="sample-chip"
                  key={command}
                  type="button"
                  onClick={() => {
                    setDraft(command);
                    void runTurn(command);
                  }}
                >
                  {command}
                </button>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="显示设置" subtitle="这里可以切换地图模式、底图来源和实验开关">
            <label>
              地图模式
              <select
                value={runtime.mapMode}
                onChange={(event) =>
                  setRuntime(updateRuntimeForMode(runtime, event.target.value as RuntimeConfig["mapMode"]))
                }
              >
                  <option value="china_public">中国公开模式</option>
                  <option value="internal">内部模式</option>
                  <option value="experimental">实验模式</option>
                </select>
              </label>
            <label>
              底图提供方
              <select
                value={runtime.mapProvider}
                onChange={(event) =>
                  setRuntime({
                    ...runtime,
                    mapProvider: event.target.value as RuntimeConfig["mapProvider"]
                  })
                }
              >
                {providerOptions.map((provider) => (
                  <option disabled={!provider.enabled} key={provider.id} value={provider.id}>
                    {provider.id}
                    {provider.enabled ? "" : "（不可用）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              大模型提供方
              <select
                value={runtime.llmProvider}
                onChange={(event) =>
                  setRuntime({
                    ...runtime,
                    llmProvider: event.target.value as RuntimeConfig["llmProvider"]
                  })
                }
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
                  setRuntime(updateRuntimeForExperiments(runtime, event.target.checked))
                }
                type="checkbox"
              />
              启用海外地图实验链路
            </label>
          </SectionCard>

          <SectionCard title="对话记录" subtitle="系统会保留最近的提问与讲解结果">
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
                <p className="empty-copy">你开始提问后，这里会保留最近几轮对话。</p>
              )}
            </div>
            {latestResult?.clarification ? (
              <div className="clarification-box">
                <p>{latestResult.clarification.question}</p>
                <div className="chip-row">
                  {latestResult.clarification.options.map((option) => (
                    <button
                      className="sample-chip"
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setDraft(option.resolvedValue);
                        void runTurn(option.resolvedValue);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {error ? <p className="error-text">{error}</p> : null}
          </SectionCard>

          <SectionCard title="来源说明" subtitle="你可以在这里查看 attribution、审图号和实验说明">
            <CompliancePanel policy={mapState.policy} />
            <SourceCardList cards={latestSourceCards} />
            {showOsmSurface ? (
              <div className="transcript-block">
                <p className="transcript-label">OSM 来源说明</p>
                <p>
                  当前实验底图引用 OpenStreetMap。公开部署时不得将该路径替代中国公开模式下的国内合规 provider。
                </p>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="技术架构" subtitle="当前页面会把本次原型采用的前后端、AI、地图和语音链路直接展示出来">
            <div className="transcript-block">
              <p className="transcript-label">架构摘要</p>
              <p>{architectureSummary}</p>
            </div>
            <div className="source-grid">
              {runtimeStack.map((item) => (
                <article className="source-card" key={`${item.category}-${item.stack}`}>
                  <p className="source-provider">{item.category}</p>
                  <h3>{item.stack}</h3>
                  <p>{item.detail}</p>
                </article>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="接入状态" subtitle="当前使用了哪些 provider，以及它们是如何接入的">
            <div className="source-grid">
              {providerBindings.map((binding) => (
                <article className="source-card" key={`${binding.kind}-${binding.providerId}`}>
                  <p className="source-provider">
                    {binding.kind} / {binding.providerId}
                  </p>
                  <h3>{binding.adapterMode}</h3>
                  <p>{binding.message}</p>
                  <p>凭据变量：{binding.credentialEnvVar ?? "无需凭据"}</p>
                </article>
              ))}
            </div>
            {providerWarnings.length > 0 ? (
              <div className="clarification-box">
                {providerWarnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="系统追踪" subtitle="这里只显示安全摘要事件，便于排查流程状态">
            <ul className="trace-list">
              {/* 这里只暴露事件名称，避免把完整 provider payload 带到前端界面。 */}
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
        </aside>
      </main>
    </div>
  );
}
