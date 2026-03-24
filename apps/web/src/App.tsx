import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";

import { resolveMapPolicy } from "@maps/compliance";
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
  RouteLandmark,
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

declare global {
  interface Window {
    _AMapSecurityConfig?: {
      securityJsCode?: string;
      serviceHost?: string;
    };
  }

  interface Window {
    AMapPixel?: new (x: number, y: number) => unknown;
    AMap?: {
      Map: new (container: HTMLElement, options: Record<string, unknown>) => {
        destroy?: () => void;
        setFitView: (overlays?: unknown[]) => void;
        setBounds?: (bounds: unknown) => void;
        setPitch?: (pitch: number, immediately?: boolean, duration?: number) => void;
        setRotation?: (rotation: number, immediately?: boolean, duration?: number) => void;
        setLayers?: (layers: unknown[]) => void;
        addControl?: (control: unknown) => void;
        setStatus?: (status: Record<string, boolean | string | number>) => void;
        on?: (eventName: string, handler: (...args: any[]) => void) => void;
        off?: (eventName: string, handler: (...args: any[]) => void) => void;
        getZoom?: () => number;
        getCenter?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
        getBounds?: () => {
          getSouthWest?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
          getNorthEast?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
        };
      };
      Marker: new (options: Record<string, unknown>) => {
        setMap?: (map: unknown) => void;
        on?: (eventName: string, handler: (...args: any[]) => void) => void;
        off?: (eventName: string, handler: (...args: any[]) => void) => void;
        getPosition?: () => unknown;
      };
      Polyline: new (options: Record<string, unknown>) => { setMap?: (map: unknown) => void };
      InfoWindow?: new (options?: Record<string, unknown>) => {
        open?: (map: unknown, position: unknown) => void;
        close?: () => void;
        setContent?: (content: string) => void;
      };
      Bounds?: new (southWest: [number, number], northEast: [number, number]) => unknown;
      Pixel?: new (x: number, y: number) => unknown;
      Scale?: new (options?: Record<string, unknown>) => unknown;
      ToolBar?: new (options?: Record<string, unknown>) => unknown;
      ControlBar?: new (options?: Record<string, unknown>) => unknown;
      MapType?: new (options?: Record<string, unknown>) => unknown;
      plugin?: (plugins: string[], callback: () => void) => void;
      TileLayer?: {
        Satellite?: new () => unknown;
        RoadNet?: new () => unknown;
        Traffic?: new (options?: Record<string, unknown>) => unknown;
      } & (new () => unknown);
    };
    __amapLoaderPromise?: Promise<NonNullable<Window["AMap"]>>;
  }
}

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

interface AmapViewport {
  headline: string;
  summary: string;
  providerLabel: string;
  latitude: number;
  longitude: number;
}

interface ProcessStep {
  title: string;
  detail: string;
}

interface ProcessArtifact {
  title: string;
  payload: string;
}

interface RuntimeHealthItem {
  label: string;
  value: string;
  tone: "neutral" | "good" | "warn";
}

interface AmapClientConfig {
  key?: string;
  securityJsCode?: string;
  serviceHost?: string;
}

interface MapViewportTelemetry {
  bounds: Bounds;
  center: [number, number];
  zoom: number;
}

interface MapInteractionState {
  title: string;
  detail: string;
  source: "map" | "feature" | "system";
}

interface LlmProviderPanelMeta {
  providerLabel: string;
  modelEnvVar: string;
  modelOptions: string[];
  defaultModel: string;
  baseUrlEnvVar?: string;
  baseUrlPlaceholder?: string;
  notes: string[];
  docsLinks?: Array<{ label: string; href: string }>;
}

interface LlmPanelConfig {
  model: string;
  baseUrl?: string;
}

type AppPage = "presenter" | "system";
type NavSection = readonly [label: string, id: string];
type GeoAnchor = typeof defaultGeoAnchor;

const FALLBACK_RUNTIME: RuntimeConfig = {
  mapMode: "internal",
  mapProvider: "amap",
  llmProvider: "gemini",
  enableForeignMapExperiments: false
};

const LAYER_LABELS: Record<"vector" | "satellite", string> = {
  vector: "标准地图",
  satellite: "卫星视图"
};

const PRESENTER_TOP_SECTIONS: readonly NavSection[] = [
  ["总览", "overview"],
  ["地图", "stage"],
  ["输入", "voice"],
  ["会话", "history"],
  ["来源", "compliance"]
] as const;

const PRESENTER_SIDE_SECTIONS: readonly NavSection[] = [
  ["地图概览", "overview"],
  ["语音输入", "voice"],
  ["地图舞台", "stage"],
  ["请求记录", "history"],
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

const SCENARIO_FEATURE_MAP = new Map(scenarioFeatures.map((feature) => [feature.id, feature] as const));
const LLM_PANEL_META: Record<RuntimeConfig["llmProvider"], LlmProviderPanelMeta> = {
  openai: {
    providerLabel: "OpenAI-compatible",
    modelEnvVar: "OPENAI_MODEL",
    modelOptions: ["gpt-5-mini", "gpt-4.1-mini", "qwen3.5-flash"],
    defaultModel: "gpt-5-mini",
    baseUrlEnvVar: "OPENAI_COMPAT_BASE_URL",
    baseUrlPlaceholder: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    notes: [
      "保持 OpenAI-compatible 接口族，方便切换官方 OpenAI 或兼容网关。",
      "千问官方 OpenAI 兼容模型名称使用 qwen3.5-flash，是否可真实调用仍取决于后端环境和兼容地址。"
    ],
    docsLinks: [
      {
        label: "OpenAI 兼容模式",
        href: "https://help.aliyun.com/zh/model-studio/context-cache"
      },
      {
        label: "DashScope 兼容基地址",
        href: "https://dashscope.aliyuncs.com/compatible-mode/v1"
      }
    ]
  },
  anthropic: {
    providerLabel: "Anthropic",
    modelEnvVar: "ANTHROPIC_MODEL",
    modelOptions: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest"],
    defaultModel: "claude-sonnet-4-20250514",
    notes: ["当前后端按独立 Anthropic provider 路线处理，不走 OpenAI-compatible 基地址。"]
  },
  gemini: {
    providerLabel: "Gemini",
    modelEnvVar: "GEMINI_MODEL",
    modelOptions: ["gemini-2.5-flash", "gemini-2.5-pro"],
    defaultModel: "gemini-2.5-flash",
    notes: ["Gemini 走独立 provider 抽象，模型切换与 OpenAI-compatible 配置相互隔离。"]
  }
};

function readClientEnv(key: string) {
  const value = import.meta.env[key as keyof ImportMetaEnv];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function createInitialLlmPanelConfig(): Record<RuntimeConfig["llmProvider"], LlmPanelConfig> {
  return {
    openai: {
      model: readClientEnv("VITE_OPENAI_COMPAT_MODEL") ?? readClientEnv("VITE_OPENAI_MODEL") ?? "gpt-5-mini",
      baseUrl: readClientEnv("VITE_OPENAI_COMPAT_BASE_URL") ?? readClientEnv("VITE_OPENAI_BASE_URL")
    },
    anthropic: {
      model: readClientEnv("VITE_ANTHROPIC_MODEL") ?? "claude-sonnet-4-20250514"
    },
    gemini: {
      model: readClientEnv("VITE_GEMINI_MODEL") ?? "gemini-2.5-flash"
    }
  };
}

function getBindingByKind(bindings: ProviderBindingSummary[], kind: ProviderBindingSummary["kind"]) {
  return bindings.find((binding) => binding.kind === kind) ?? null;
}

function readPageFromLocation(): AppPage {
  if (typeof window === "undefined") {
    return "presenter";
  }

  const page = new URLSearchParams(window.location.search).get("page");
  return page === "system" ? "system" : "presenter";
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

function getFeatureCatalog(toolResults: AssistantTurnResult["toolResults"]): Map<string, MapFeature> {
  const catalog = new Map(SCENARIO_FEATURE_MAP);

  for (const result of toolResults) {
    if (result.tool === "poiSearch") {
      result.features.forEach((feature) => {
        catalog.set(feature.id, feature);
      });
      continue;
    }

    if (result.tool === "areaLookup") {
      catalog.set(result.feature.id, result.feature);
      continue;
    }

    if (result.tool === "routeSummary") {
      if (result.startFeature) {
        catalog.set(result.startFeature.id, result.startFeature);
      }
      if (result.endFeature) {
        catalog.set(result.endFeature.id, result.endFeature);
      }
      result.landmarks.forEach((landmark) => {
        if (!catalog.has(landmark.featureId)) {
          catalog.set(landmark.featureId, createRouteLandmarkFeature(landmark));
        }
      });
    }
  }

  return catalog;
}

function createRouteLandmarkFeature(landmark: RouteLandmark): MapFeature {
  const [x, y] = landmark.point;
  const size = Math.abs(x) <= 100 && Math.abs(y) <= 100 ? 2.5 : 0.02;
  return {
    id: landmark.featureId,
    name: landmark.name,
    aliases: [],
    kind: "route_landmark",
    description: landmark.summary,
    bbox: [x - size, y - size, x + size, y + size],
    centroid: landmark.point,
    tags: ["route", "landmark"],
    narrativeBullets: [landmark.summary]
  };
}

function isGeographicBounds(bounds: Bounds) {
  return (
    Math.abs(bounds[0]) <= 180 &&
    Math.abs(bounds[2]) <= 180 &&
    Math.abs(bounds[1]) <= 90 &&
    Math.abs(bounds[3]) <= 90 &&
    (Math.abs(bounds[0]) > 100 ||
      Math.abs(bounds[2]) > 100 ||
      (bounds[2] - bounds[0] <= 5 && bounds[3] - bounds[1] <= 5))
  );
}

function toGeoAnchor(feature: MapFeature | undefined): GeoAnchor | null {
  if (!feature) {
    return null;
  }

  const [longitude, latitude] = feature.centroid;
  if (Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90) {
    return { longitude, latitude };
  }

  return geoAnchorsByFeatureId[feature.id] ?? null;
}

function buildAmapViewport(
  mapState: MapViewState,
  featureCatalog: Map<string, MapFeature>
): AmapViewport {
  const featureIds = getActiveFeatureIds(mapState);
  const anchors = featureIds
    .map((featureId) => ({
      feature: featureCatalog.get(featureId),
      anchor: toGeoAnchor(featureCatalog.get(featureId))
    }))
    .filter(
      (item): item is { feature: MapFeature | undefined; anchor: GeoAnchor } =>
        Boolean(item.anchor)
    );

  let south: number;
  let north: number;
  let west: number;
  let east: number;

  if (isGeographicBounds(mapState.currentBounds)) {
    [west, south, east, north] = mapState.currentBounds;
  } else {
    const points = anchors.length > 0 ? anchors.map((item) => item.anchor) : [defaultGeoAnchor];
    const latitudes = points.map((point) => point.latitude);
    const longitudes = points.map((point) => point.longitude);
    const minLat = Math.min(...latitudes);
    const maxLat = Math.max(...latitudes);
    const minLon = Math.min(...longitudes);
    const maxLon = Math.max(...longitudes);
    const latPadding = Math.max(0.04, (maxLat - minLat) * 0.45);
    const lonPadding = Math.max(0.05, (maxLon - minLon) * 0.45);
    south = clamp(minLat - latPadding, -85, 85);
    north = clamp(maxLat + latPadding, -85, 85);
    west = clamp(minLon - lonPadding, -180, 180);
    east = clamp(maxLon + lonPadding, -180, 180);
  }
  const centerLat = (south + north) / 2;
  const centerLon = (west + east) / 2;
  const featureNames = anchors
    .map((item) => item.feature?.name)
    .filter((name): name is string => Boolean(name));

  return {
    headline:
      featureNames.length > 0
        ? `地图已定位到 ${featureNames.slice(0, 3).join(" / ")}`
        : "地图控制台",
    summary:
      featureNames.length > 1
        ? `当前地图视图正围绕 ${featureNames.join("、")} 展示，便于连续查看点位、高亮与路线变化。`
        : featureNames.length === 1
          ? "主舞台会跟随当前点位或区域实时更新，右侧控制台同步显示结果摘要与关键节点。"
          : "输入地点、区域或路线后，主舞台会实时刷新到对应地图范围。",
    providerLabel: "高德地图实时底图",
    latitude: centerLat,
    longitude: centerLon
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
      return "展示中";
    case "error":
      return "异常";
  }
}

function formatBindingLabel(bindings: ProviderBindingSummary[], kind: string) {
  const binding = bindings.find((item) => item.kind === kind);
  if (!binding) {
    return "待检测";
  }

  if (binding.adapterMode.includes("requires_configuration")) {
    return "待配置";
  }

  if (binding.adapterMode.includes("mcp") || binding.adapterMode.includes("direct")) {
    return "已接通";
  }

  return "已启用";
}

function nextRuntimeForMode(currentRuntime: RuntimeConfig, nextMapMode: RuntimeConfig["mapMode"]) {
  return {
    ...currentRuntime,
    mapMode: nextMapMode,
    enableForeignMapExperiments: nextMapMode === "china_public" ? false : currentRuntime.enableForeignMapExperiments,
    mapProvider: "amap" as RuntimeConfig["mapProvider"]
  } satisfies RuntimeConfig;
}

function nextRuntimeForExperiments(currentRuntime: RuntimeConfig, enabled: boolean) {
  return {
    ...currentRuntime,
    enableForeignMapExperiments: enabled && currentRuntime.mapMode !== "china_public",
    mapProvider: "amap" as RuntimeConfig["mapProvider"]
  } satisfies RuntimeConfig;
}

function readCoordinate(
  value:
    | { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number }
    | undefined
    | null
): [number, number] | null {
  if (!value) {
    return null;
  }

  const longitude = typeof value.getLng === "function" ? value.getLng() : value.lng;
  const latitude = typeof value.getLat === "function" ? value.getLat() : value.lat;

  if (typeof longitude !== "number" || typeof latitude !== "number") {
    return null;
  }

  return [longitude, latitude];
}

function getBoundsFromAmap(
  bounds:
    | {
        getSouthWest?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
        getNorthEast?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
      }
    | undefined
    | null
): Bounds | null {
  if (!bounds?.getSouthWest || !bounds.getNorthEast) {
    return null;
  }

  const southWest = readCoordinate(bounds.getSouthWest());
  const northEast = readCoordinate(bounds.getNorthEast());

  if (!southWest || !northEast) {
    return null;
  }

  return [southWest[0], southWest[1], northEast[0], northEast[1]];
}

function getMapViewportTelemetry(map: {
  getZoom?: () => number;
  getCenter?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
  getBounds?: () => {
    getSouthWest?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
    getNorthEast?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
  };
}): MapViewportTelemetry | null {
  const center = readCoordinate(map.getCenter?.());
  const bounds = getBoundsFromAmap(map.getBounds?.());
  const zoom = map.getZoom?.();

  if (!center || !bounds || typeof zoom !== "number") {
    return null;
  }

  return {
    center,
    bounds,
    zoom
  };
}

function resolveAmapClientConfig(): AmapClientConfig {
  return {
    key: (import.meta.env.VITE_AMAP_JS_API_KEY as string | undefined) ?? undefined,
    securityJsCode:
      (import.meta.env.VITE_AMAP_SECURITY_JS_CODE as string | undefined) ?? undefined,
    serviceHost: (import.meta.env.VITE_AMAP_SERVICE_HOST as string | undefined) ?? undefined
  };
}

function validateAmapClientConfig(config: AmapClientConfig) {
  if (!config.key) {
    return "未配置 VITE_AMAP_JS_API_KEY，当前无法加载高德地图底图。";
  }

  return null;
}

function applyAmapSecurityConfig(config: AmapClientConfig) {
  if (typeof window === "undefined") {
    return;
  }

  // 临时放宽开发环境限制：未配置 securityJsCode / serviceHost 时仍允许尝试加载 JSAPI。
  if (config.serviceHost) {
    window._AMapSecurityConfig = {
      serviceHost: config.serviceHost
    };
    return;
  }

  if (config.securityJsCode) {
    window._AMapSecurityConfig = {
      securityJsCode: config.securityJsCode
    };
    return;
  }

  delete window._AMapSecurityConfig;
}

function loadAmap(config: AmapClientConfig) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("AMap can only load in the browser."));
  }

  const configError = validateAmapClientConfig(config);
  if (configError) {
    return Promise.reject(new Error(configError));
  }

  if (window.AMap) {
    return Promise.resolve(window.AMap);
  }

  if (window.__amapLoaderPromise) {
    return window.__amapLoaderPromise;
  }

  applyAmapSecurityConfig(config);

  window.__amapLoaderPromise = AMapLoader.load({
    key: config.key!,
    version: "2.0",
    plugins: ["AMap.Scale", "AMap.ToolBar", "AMap.MapType", "AMap.ControlBar"],
    ...(config.serviceHost ? { serviceHost: config.serviceHost } : {})
  }) as Promise<NonNullable<Window["AMap"]>>;

  return window.__amapLoaderPromise;
}

function buildFeatureSignature(features: MapFeature[]) {
  return features
    .map((feature) => `${feature.id}:${feature.centroid[0]},${feature.centroid[1]}`)
    .join("|");
}

function buildRouteSignature(mapState: MapViewState) {
  return mapState.routeOverlay
    ? [
        mapState.routeOverlay.summary,
        ...mapState.routeOverlay.path.map((point) => `${point[0]},${point[1]}`)
      ].join("|")
    : "";
}

function RealtimeAmapStageInner(props: {
  amapConfig: AmapClientConfig;
  mapState: MapViewState;
  features: MapFeature[];
  onViewportChange: (telemetry: MapViewportTelemetry) => void;
  onInteraction: (state: MapInteractionState) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<{
    setFitView: (overlays?: unknown[]) => void;
    setBounds?: (bounds: unknown) => void;
    setPitch?: (pitch: number, immediately?: boolean, duration?: number) => void;
    setRotation?: (rotation: number, immediately?: boolean, duration?: number) => void;
    setLayers?: (layers: unknown[]) => void;
    addControl?: (control: unknown) => void;
    setStatus?: (status: Record<string, boolean | string | number>) => void;
    on?: (eventName: string, handler: (...args: any[]) => void) => void;
    off?: (eventName: string, handler: (...args: any[]) => void) => void;
    getZoom?: () => number;
    getCenter?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
    getBounds?: () => {
      getSouthWest?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
      getNorthEast?: () => { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
    };
    destroy?: () => void;
  } | null>(null);
  const overlaysRef = useRef<Array<{ setMap?: (map: unknown) => void }>>([]);
  const controlsInitializedRef = useRef(false);
  const infoWindowRef = useRef<{ open?: (map: unknown, position: unknown) => void; close?: () => void; setContent?: (content: string) => void } | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const featureSignature = buildFeatureSignature(props.features);
  const boundsSignature = props.mapState.currentBounds.join(",");
  const routeSignature = buildRouteSignature(props.mapState);
  const emitViewportChange = useEffectEvent((telemetry: MapViewportTelemetry) => {
    props.onViewportChange(telemetry);
  });
  const emitInteraction = useEffectEvent((state: MapInteractionState) => {
    props.onInteraction(state);
  });

  useEffect(() => {
    const configError = validateAmapClientConfig(props.amapConfig);
    if (configError) {
      setMapError(configError);
      return;
    }

    let disposed = false;
    let detachListeners: (() => void) | undefined;

    void loadAmap(props.amapConfig)
      .then((AMap) => {
        if (disposed || !containerRef.current) {
          return;
        }

        if (!mapRef.current) {
          mapRef.current = new AMap.Map(containerRef.current, {
            zoom: 11,
            center: [121.544346, 31.221461],
            viewMode: "3D",
            zooms: [3, 18],
            dragEnable: true,
            zoomEnable: true,
            doubleClickZoom: true,
            scrollWheel: true,
            keyboardEnable: true,
            animateEnable: true,
            jogEnable: true,
            defaultCursor: "grab",
            pitchEnable: true,
            rotateEnable: true,
            pitch: 0,
            rotation: 0,
            showBuildingBlock: true,
            mapStyle: "amap://styles/normal",
            features: ["bg", "point", "road", "building"]
          });
        }

        mapRef.current.setStatus?.({
          dragEnable: true,
          zoomEnable: true,
          doubleClickZoom: true,
          scrollWheel: true,
          keyboardEnable: true,
          jogEnable: true,
          animateEnable: true
        });

        if (!controlsInitializedRef.current && AMap.plugin) {
          AMap.plugin(["AMap.Scale", "AMap.ToolBar", "AMap.MapType", "AMap.ControlBar"], () => {
            if (!mapRef.current) {
              return;
            }

            if (AMap.Scale) {
              mapRef.current.addControl?.(new AMap.Scale({ position: "LB" }));
            }

            if (AMap.ToolBar) {
              mapRef.current.addControl?.(new AMap.ToolBar({ position: "RB" }));
            }

            if (AMap.MapType) {
              mapRef.current.addControl?.(
                new AMap.MapType({
                  defaultType: props.mapState.activeLayer === "satellite" ? 1 : 0,
                  showTraffic: true,
                  showRoad: true
                })
              );
            }

            if (AMap.ControlBar) {
              mapRef.current.addControl?.(
                new AMap.ControlBar({
                  position: { right: 10, top: 10 },
                  showControlButton: false
                })
              );
            }

            controlsInitializedRef.current = true;
          });
        }

        if (!infoWindowRef.current && AMap.InfoWindow) {
          infoWindowRef.current = new AMap.InfoWindow({
            anchor: "bottom-center",
            offset: AMap.Pixel ? new AMap.Pixel(0, -18) : undefined
          });
        }

        const map = mapRef.current;
        const emitViewport = () => {
          if (!map) {
            return;
          }

          const telemetry = getMapViewportTelemetry(map);
          if (telemetry) {
            emitViewportChange(telemetry);
          }
        };

        const handleComplete = () => {
          emitViewport();
          emitInteraction({
            title: "地图已就绪",
            detail: "高德地图底图和交互控件已加载完成，现在可以直接拖拽、缩放和点选地图。",
            source: "system"
          });
        };

        const handleMoveEnd = () => {
          emitViewport();
        };

        const handleZoomEnd = () => {
          const telemetry = getMapViewportTelemetry(map);
          if (!telemetry) {
            return;
          }

          emitViewportChange(telemetry);
          emitInteraction({
            title: "视野缩放",
            detail: `当前缩放级别约为 ${telemetry.zoom.toFixed(1)}，地图会继续围绕你当前视野进行浏览。`,
            source: "map"
          });
        };

        const handleClick = (event: {
          lnglat?: { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
        }) => {
          const position = readCoordinate(event.lnglat);
          if (!position) {
            return;
          }

          emitInteraction({
            title: "地图选点",
            detail: `已选中经纬度 ${position[0].toFixed(4)}, ${position[1].toFixed(4)}，可以继续围绕这个点位发起讲解。`,
            source: "map"
          });
        };

        map.on?.("complete", handleComplete);
        map.on?.("moveend", handleMoveEnd);
        map.on?.("zoomend", handleZoomEnd);
        map.on?.("click", handleClick);

        setMapError(null);

        detachListeners = () => {
          map.off?.("complete", handleComplete);
          map.off?.("moveend", handleMoveEnd);
          map.off?.("zoomend", handleZoomEnd);
          map.off?.("click", handleClick);
        };
      })
      .catch((error) => {
        if (!disposed) {
          setMapError(error instanceof Error ? error.message : "高德地图加载失败。");
        }
      });

    return () => {
      disposed = true;
      detachListeners?.();
    };
  }, [
    props.amapConfig.key,
    props.amapConfig.securityJsCode,
    props.amapConfig.serviceHost,
    props.mapState.activeLayer
  ]);

  useEffect(() => {
    if (!window.AMap || !mapRef.current) {
      return;
    }

    const AMap = window.AMap;
    const map = mapRef.current;
    overlaysRef.current.forEach((overlay) => overlay.setMap?.(null));
    overlaysRef.current = [];
    infoWindowRef.current?.close?.();

    if (map.setLayers) {
      if (props.mapState.activeLayer === "satellite" && AMap.TileLayer?.Satellite) {
        const layers = [new AMap.TileLayer.Satellite()];
        if (AMap.TileLayer.RoadNet) {
          layers.push(new AMap.TileLayer.RoadNet());
        }
        if (AMap.TileLayer.Traffic) {
          layers.push(
            new AMap.TileLayer.Traffic({
              autoRefresh: true,
              interval: 180
            })
          );
        }
        map.setLayers(layers);
      } else if (AMap.TileLayer) {
        const layers = [new AMap.TileLayer()];
        if (AMap.TileLayer.Traffic) {
          layers.push(
            new AMap.TileLayer.Traffic({
              autoRefresh: true,
              interval: 180
            })
          );
        }
        map.setLayers(layers);
      }
    }

    const overlays: Array<{ setMap?: (map: unknown) => void }> = [];
    props.features.forEach((feature) => {
      const marker = new AMap.Marker({
        position: feature.centroid,
        title: feature.name,
        label: {
          content: `<div class="amap-chip">${feature.name}</div>`,
          direction: "top"
        },
        cursor: "pointer"
      });
      marker.on?.("click", () => {
        const content = `
          <div class="amap-info-card">
            <strong>${feature.name}</strong>
            <p>${feature.description}</p>
          </div>
        `;
        infoWindowRef.current?.setContent?.(content);
        infoWindowRef.current?.open?.(map, feature.centroid);
        emitInteraction({
          title: `已选中 ${feature.name}`,
          detail: feature.description,
          source: "feature"
        });
      });
      marker.setMap?.(map);
      overlays.push(marker);
    });

    if (props.mapState.routeOverlay?.path.length) {
      const polyline = new AMap.Polyline({
        path: props.mapState.routeOverlay.path,
        strokeColor: "#1769c2",
        strokeWeight: 5,
        strokeOpacity: 0.95
      });
      polyline.setMap?.(map);
      overlays.push(polyline);
    }

    overlaysRef.current = overlays;

    if (overlays.length > 0) {
      map.setFitView(overlays);
      return;
    }

    if (isGeographicBounds(props.mapState.currentBounds) && map.setBounds && AMap.Bounds) {
      const [west, south, east, north] = props.mapState.currentBounds;
      map.setBounds(new AMap.Bounds([west, south], [east, north]));
    }
  }, [featureSignature, props.mapState.activeLayer, boundsSignature, routeSignature]);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    mapRef.current.setPitch?.(props.mapState.cameraPitch, false, 280);
    mapRef.current.setRotation?.(props.mapState.cameraRotation, false, 280);
  }, [props.mapState.cameraPitch, props.mapState.cameraRotation]);

  useEffect(() => {
    return () => {
      overlaysRef.current.forEach((overlay) => overlay.setMap?.(null));
      infoWindowRef.current?.close?.();
      infoWindowRef.current = null;
      mapRef.current?.destroy?.();
      mapRef.current = null;
      controlsInitializedRef.current = false;
    };
  }, []);

  if (mapError) {
    return (
      <div className="amap-stage amap-stage--error" role="alert">
        <p className="eyebrow">高德地图</p>
        <p>{mapError}</p>
      </div>
    );
  }

  return <div className="amap-stage" ref={containerRef} />;
}

const RealtimeAmapStage = memo(
  RealtimeAmapStageInner,
  (previousProps, nextProps) =>
    previousProps.amapConfig.key === nextProps.amapConfig.key &&
    previousProps.amapConfig.securityJsCode === nextProps.amapConfig.securityJsCode &&
    previousProps.amapConfig.serviceHost === nextProps.amapConfig.serviceHost &&
    previousProps.mapState.activeLayer === nextProps.mapState.activeLayer &&
    previousProps.mapState.currentBounds.join(",") === nextProps.mapState.currentBounds.join(",") &&
    buildRouteSignature(previousProps.mapState) === buildRouteSignature(nextProps.mapState) &&
    buildFeatureSignature(previousProps.features) === buildFeatureSignature(nextProps.features)
);

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

function formatIntentLabel(intent: AssistantTurnResult["classification"]["intent"]) {
  switch (intent) {
    case "focus_area":
      return "聚焦区域";
    case "route_overview":
      return "路线概览";
    case "layer_switch":
      return "图层切换";
    case "zoom_in":
      return "放大视图";
    case "zoom_out":
      return "缩小视图";
    case "reset_view":
      return "标准视角";
    case "tilt_view":
      return "3D 俯视";
    case "detail_follow_up":
      return "追问详情";
    case "multi_point_story":
      return "多点展示";
  }
}

function describeToolResult(result: AssistantTurnResult["toolResults"][number]) {
  if (result.tool === "poiSearch") {
    return result.features.length > 0
      ? `找到 ${result.features.length} 个地点，当前展示 ${result.features[0]?.name ?? "结果"}。`
      : `没有找到“${result.query}”的地点结果。`;
  }

  if (result.tool === "areaLookup") {
    return `已读取 ${result.feature.name} 的区域详情，共整理 ${result.keyPoints.length} 个重点信息。`;
  }

  return `已生成路线 ${result.name}，包含 ${result.landmarks.length} 个沿线节点。`;
}

function buildProcessSteps(
  transcriptText: string,
  result: AssistantTurnResult | null,
  trace: SafeTraceEvent[]
): ProcessStep[] {
  if (!result) {
    return [];
  }

  const steps: ProcessStep[] = [
    {
      title: "输入理解",
      detail: `收到请求“${transcriptText || "当前输入"}”，识别为 ${formatIntentLabel(result.classification.intent)}。`
    }
  ];

  if (result.steps.length > 0) {
    steps.push({
      title: "任务拆解",
      detail: `本轮请求被拆成 ${result.steps.length} 个步骤，并按顺序执行。`
    });
    result.steps.forEach((step, index) => {
      const details = [
        `识别为 ${formatIntentLabel(step.classification.intent)}`
      ];
      if (step.toolCalls.length > 0) {
        details.push(
          `调用 ${step.toolCalls
            .map((toolCall) => `${toolCall.toolName}(${Object.values(toolCall.arguments).join("，")})`)
            .join(" -> ")}`
        );
      }
      if (step.toolResults.length > 0) {
        details.push(step.toolResults.map((toolResult) => describeToolResult(toolResult)).join(" "));
      }
      if (step.mapActionPlan.actions.length > 0) {
        details.push(
          `生成 ${step.mapActionPlan.actions.length} 个地图动作：${step.mapActionPlan.actions
            .map((action) => action.type)
            .join("、")}`
        );
      }
      steps.push({
        title: `步骤 ${index + 1}`,
        detail: details.join("；") + "。"
      });
    });
  } else {
    if (result.toolCalls.length > 0) {
      steps.push({
        title: "工具计划",
        detail: result.toolCalls
          .map((toolCall) => `${toolCall.toolName}(${Object.values(toolCall.arguments).join("，")})`)
          .join(" -> ")
      });
    }

    if (result.toolResults.length > 0) {
      steps.push({
        title: "工具返回",
        detail: result.toolResults.map((toolResult) => describeToolResult(toolResult)).join(" ")
      });
    }

    if (result.mapActionPlan.actions.length > 0) {
      steps.push({
        title: "地图动作",
        detail: `已生成 ${result.mapActionPlan.actions.length} 个地图动作，包括 ${result.mapActionPlan.actions
          .map((action) => action.type)
          .join("、")}。`
      });
    }
  }

  if (trace.length > 0) {
    steps.push({
      title: "执行流程",
      detail: trace.map((event) => String(event.event)).join(" -> ")
    });
  }

  return steps;
}

function buildProcessArtifacts(
  result: AssistantTurnResult | null,
  trace: SafeTraceEvent[]
): ProcessArtifact[] {
  if (!result) {
    return [];
  }

  return [
    {
      title: "意图识别",
      payload: JSON.stringify(result.classification, null, 2)
    },
    {
      title: "步骤执行",
      payload: JSON.stringify(result.steps, null, 2)
    },
    {
      title: "工具调用",
      payload: JSON.stringify(result.toolCalls, null, 2)
    },
    {
      title: "工具返回",
      payload: JSON.stringify(result.toolResults, null, 2)
    },
    {
      title: "地图动作",
      payload: JSON.stringify(result.mapActionPlan, null, 2)
    },
    {
      title: "执行事件",
      payload: JSON.stringify(trace, null, 2)
    }
  ];
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
  const [llmPanelConfig, setLlmPanelConfig] = useState(createInitialLlmPanelConfig);
  const [providerBindings, setProviderBindings] = useState<ProviderBindingSummary[]>([]);
  const [providerWarnings, setProviderWarnings] = useState<string[]>([]);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [architectureSummary, setArchitectureSummary] = useState(
    "当前采用前端展示、Python 后端编排、AI 能力层、地图服务层和语音交互层协同运行。"
  );
  const [runtimeStack, setRuntimeStack] = useState<StackComponentSummary[]>([]);
  const [mapState, setMapState] = useState(() =>
    createInitialMapViewState(resolveMapPolicy(FALLBACK_RUNTIME))
  );
  const [mapViewportTelemetry, setMapViewportTelemetry] = useState<MapViewportTelemetry | null>(null);
  const [mapInteractionState, setMapInteractionState] = useState<MapInteractionState | null>(null);
  const [sessionId] = useState("web-session");
  const amapClientConfig = resolveAmapClientConfig();
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
        setRuntimeReady(true);
        setError((current) =>
          current && /API_KEY|provider|runtime config/i.test(current) ? null : current
        );
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
        setRuntimeReady(false);
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

  async function runTurn(text: string) {
    if (!runtimeReady) {
      setError("本地服务仍在连接中，请稍候再提交地图请求。");
      return;
    }

    const transcriptText = text.trim();
    if (!transcriptText) {
      inputRef.current?.focus();
      return;
    }

    tts.stop();
    asr.stop();
    setPartialTranscript("");
    setError(null);
    setMapInteractionState(null);
    setStatus("thinking");
    pulse();

    try {
      const turnResponse = await apiClient.handleTurn({
        runtime,
        sessionId,
        transcriptText,
        mapContext: {
          currentBounds: (mapViewportTelemetry?.bounds ?? mapState.currentBounds) as [
            number,
            number,
            number,
            number
          ],
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
      setStatus("idle");
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

  function handleMapViewportChange(nextTelemetry: MapViewportTelemetry) {
    setMapViewportTelemetry((current) => {
      if (
        current &&
        current.zoom === nextTelemetry.zoom &&
        current.center.join(",") === nextTelemetry.center.join(",") &&
        current.bounds.join(",") === nextTelemetry.bounds.join(",")
      ) {
        return current;
      }

      return nextTelemetry;
    });
  }

  function handleMapInteraction(nextState: MapInteractionState) {
    setMapInteractionState(nextState);
  }

  const currentLayer = latestResult?.classification.requestedLayer ?? mapState.activeLayer;
  const activeFeatureIds = getActiveFeatureIds(mapState);
  const hasInteraction = conversation.length > 0 || latestResult !== null;
  const isThinking = status === "thinking";
  const featureCatalog = getFeatureCatalog(latestResult?.toolResults ?? []);
  const highlightedFeatures = activeFeatureIds
    .map((featureId) => featureCatalog.get(featureId))
  .filter((feature): feature is MapFeature => Boolean(feature));
  const spotlightFeatures = activeFeatureIds
    .map((featureId) => featureCatalog.get(featureId))
    .filter((feature): feature is MapFeature => Boolean(feature));
  const amapViewport = buildAmapViewport(mapState, featureCatalog);
  const liveViewport = mapViewportTelemetry ?? {
    bounds: mapState.currentBounds,
    center: [amapViewport.longitude, amapViewport.latitude] as [number, number],
    zoom: 11
  };
  const latestSourceCards = latestResult?.mapActionPlan.sourceCards ?? [];
  const conversationEntries = [...conversation].reverse();
  const stageSummary = isThinking
    ? "正在调用 AI 与地图工具，请稍候。"
    : latestResult?.mapActionPlan.summary ?? "等待你的请求。";
  const latestNarration =
    isThinking
      ? "正在分析你的请求，并准备地图结果。"
      : latestResult?.narration.text ?? "系统会在这里显示最新一轮的地图结果摘要。";
  const liveTranscript = partialTranscript || draft || "等待语音输入或文本提交。";
  const focusTags = Array.from(new Set(spotlightFeatures.flatMap((feature) => feature.tags))).slice(0, 8);
  const systemStats = [
    { label: "Provider 绑定", value: String(providerBindings.length) },
    { label: "预警数", value: String(providerWarnings.length) },
    { label: "事件数", value: String(latestTrace.length) }
  ];
  const processSteps = buildProcessSteps(conversation[conversation.length - 1]?.user ?? "", latestResult, latestTrace);
  const processArtifacts = buildProcessArtifacts(latestResult, latestTrace);
  const llmBinding = getBindingByKind(providerBindings, "llm");
  const activeLlmMeta = LLM_PANEL_META[runtime.llmProvider];
  const activeLlmConfig = llmPanelConfig[runtime.llmProvider];
  const providerSpecificWarnings = providerWarnings.filter((warning) =>
    runtime.llmProvider === "openai"
      ? /OPENAI|LiteLLM|OpenAI-compatible/i.test(warning)
      : runtime.llmProvider === "anthropic"
        ? /ANTHROPIC/i.test(warning)
        : /GEMINI/i.test(warning)
  );
  const runtimeHealth: RuntimeHealthItem[] = [
    {
      label: "模型链路",
      value: formatBindingLabel(providerBindings, "llm"),
      tone: providerWarnings.length > 0 ? "warn" : "good"
    },
    {
      label: "地图链路",
      value: formatBindingLabel(providerBindings, "map"),
      tone: providerWarnings.some((warning) => warning.includes("map")) ? "warn" : "good"
    },
    {
      label: "运行告警",
      value: providerWarnings.length > 0 ? `${providerWarnings.length} 条` : "无",
      tone: providerWarnings.length > 0 ? "warn" : "neutral"
    }
  ];
  const topSections = page === "presenter" ? PRESENTER_TOP_SECTIONS : SYSTEM_TOP_SECTIONS;
  const sideSections = page === "presenter" ? PRESENTER_SIDE_SECTIONS : SYSTEM_SIDE_SECTIONS;

  return (
    <div className="app-shell">
      <header className="natural-topbar">
        <div className="brand-block">
          <p className="eyebrow">Voice Map OS</p>
          <h1>语音地图展示台</h1>
        </div>

        <nav className="top-nav" aria-label={page === "presenter" ? "展示页导航" : "系统页导航"}>
          {renderSectionButtons(topSections, (sectionId) => scrollToSection(sectionId))}
        </nav>

        <div className="top-actions">
          <StatusBadge status={status} />
          {page === "presenter" ? (
            <>
              <div className="page-switcher" aria-label="当前页面">
                <span aria-current="page" className="page-pill is-active">
                  展示页
                </span>
              </div>
              <button
                className="icon-button"
                disabled={!runtimeReady}
                onClick={() => void handleMicrophone()}
                type="button"
              >
                {status === "listening" ? "停止收音" : "收音"}
              </button>
            </>
          ) : (
            <>
              <div className="page-switcher" aria-label="页面切换">
                <button
                  className="page-pill"
                  onClick={() => navigateToPage("presenter")}
                  type="button"
                >
                  展示页
                </button>
                <span aria-current="page" className="page-pill is-active">
                  系统页
                </span>
              </div>
              <button
                className="icon-button"
                onClick={() => navigateToPage("presenter", "voice")}
                type="button"
              >
                返回展示页
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
        <main className="natural-main">
          <section className="workspace-outline">
            <div className="sidebar-intro">
              <p className="eyebrow">{page === "presenter" ? "当前展示" : "系统状态"}</p>
              <p className="muted-copy">
                {page === "presenter"
                  ? "地图是主工作面，输入、结果与历史收束在同一条操作侧栏。"
                  : "运行设置优先展示，绑定状态和诊断汇总在右侧健康区。"}
              </p>
            </div>
            <nav className="sidebar-nav" aria-label={page === "presenter" ? "展示页侧边导航" : "系统页侧边导航"}>
              {renderSectionButtons(sideSections, (sectionId) => scrollToSection(sectionId))}
            </nav>
          </section>

          {page === "presenter" ? (
            <>
              <section className="hero-panel workspace-header" id="overview">
                <div className="hero-copy">
                  <p className="eyebrow">Presenter Workspace</p>
                  <h2>{hasInteraction ? latestNarration : "地图主舞台已就绪，等待新的展示任务。"}</h2>
                  <p>
                    {hasInteraction
                      ? stageSummary
                      : "主舞台持续显示实时底图，右侧操作区集中处理输入、结果、过程说明和历史记录。"}
                  </p>
                  <div className="hero-chips">
                    <span>{formatModeLabel(runtime.mapMode)}</span>
                    <span>高德地图</span>
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
                    <p>当前模式</p>
                    <strong>{currentLayer === "satellite" ? "卫星浏览" : "标准浏览"}</strong>
                  </article>
                  <article>
                    <p>当前焦点</p>
                    <strong>{isThinking ? "处理中" : spotlightFeatures[0]?.name ?? "等待任务"}</strong>
                  </article>
                </div>
              </section>

              <div className="content-grid">
                <section className="stage-section" id="stage">
                  <section className="stage-shell stage-shell--osm">
                    <div className="stage-map-frame">
                      <RealtimeAmapStage
                        amapConfig={amapClientConfig}
                        features={highlightedFeatures}
                        mapState={mapState}
                        onInteraction={handleMapInteraction}
                        onViewportChange={handleMapViewportChange}
                      />
                    </div>
                    <div className="floating-summary">
                      <p className="eyebrow">{amapViewport.providerLabel}</p>
                      <h3>{isThinking ? "正在处理地图请求" : spotlightFeatures[0]?.name ?? amapViewport.headline}</h3>
                      <p>
                        {isThinking
                          ? "系统正在理解输入、调用工具并生成地图动作。"
                          : hasInteraction
                            ? amapViewport.summary
                            : "主舞台已就绪，等待你的地图请求。"}
                      </p>
                      <div className="inline-metrics">
                        <span>纬度 {liveViewport.center[1].toFixed(4)}°</span>
                        <span>经度 {liveViewport.center[0].toFixed(4)}°</span>
                        <span>缩放 {liveViewport.zoom.toFixed(1)}</span>
                        <span>{LAYER_LABELS[currentLayer]}</span>
                      </div>
                    </div>
                  </section>
                </section>

                <aside className="right-rail">
                  <div id="voice">
                    <SectionCard title="语音输入" subtitle="麦克风、文本输入与快捷控制集中在一处">
                      <div className="hero-chips session-chips">
                        <StatusBadge status={status} />
                        <span>{formatModeLabel(runtime.mapMode)}</span>
                        <span>{LAYER_LABELS[currentLayer]}</span>
                      </div>
                      <div className="control-row">
                        <button
                          className="primary-button"
                          disabled={!runtimeReady}
                          onClick={() => void handleMicrophone()}
                          type="button"
                        >
                          {status === "listening" ? "停止收音" : runtimeReady ? "开始收音" : "连接中"}
                        </button>
                        <button
                          className="secondary-button"
                          disabled={!runtimeReady}
                          onClick={() => {
                            asr.stop();
                            setPartialTranscript("");
                            setStatus("idle");
                          }}
                          type="button"
                        >
                          结束输入
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
                        <button className="primary-button" disabled={!runtimeReady} type="submit">
                          {runtimeReady ? (isThinking ? "处理中..." : "提交任务") : "正在连接服务"}
                        </button>
                      </form>
                      <div className="button-grid quick-action-grid">
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
                          onClick={() => {
                            focusInput();
                          }}
                          type="button"
                        >
                          聚焦输入
                        </button>
                      </div>
                      <div aria-live="polite" className="live-block">
                        <p className="eyebrow">实时转写</p>
                        <p>{liveTranscript}</p>
                      </div>
                      {error ? <p className="error-text">{error}</p> : null}
                    </SectionCard>
                  </div>

                  <SectionCard title="地图结果" subtitle="当前讲解、处理过程和高亮目标集中展示">
                    <div aria-live="polite" className="live-block">
                      <p className="eyebrow">当前结果</p>
                      <p>{latestNarration}</p>
                    </div>
                    {mapInteractionState ? (
                      <div className="live-block">
                        <p className="eyebrow">{mapInteractionState.title}</p>
                        <p>{mapInteractionState.detail}</p>
                      </div>
                    ) : null}
                    {isThinking ? (
                      <div className="live-block process-waiting">
                        <p className="eyebrow">处理中</p>
                        <p>已经收到请求，正在等待 Gemini 和高德工具返回结果。</p>
                      </div>
                    ) : null}
                    {processSteps.length > 0 ? (
                      <details className="process-panel">
                        <summary>展开 AI 处理过程</summary>
                        <div className="process-list">
                          {processSteps.map((step) => (
                            <article className="process-item" key={step.title}>
                              <p className="eyebrow">{step.title}</p>
                              <p>{step.detail}</p>
                            </article>
                          ))}
                        </div>
                        <div className="process-raw-list">
                          {processArtifacts.map((artifact) => (
                            <details className="process-raw-card" key={artifact.title}>
                              <summary>{artifact.title}</summary>
                              <pre>{artifact.payload}</pre>
                            </details>
                          ))}
                        </div>
                      </details>
                    ) : null}
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
                    <SectionCard title="请求记录" subtitle="保留最近几轮输入与返回结果，便于追溯上下文">
                      <div className="conversation-log">
                        {conversationEntries.length > 0 ? (
                          conversationEntries.map((entry) => (
                            <article className="conversation-entry" key={entry.id}>
                              <p className="conversation-user">用户：{entry.user}</p>
                              <p className="conversation-assistant">
                                结果：{entry.assistant}
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
                </aside>
              </div>

              <section className="panel-card compliance-strip" id="compliance">
                <div className="panel-heading compliance-strip-header">
                  <div>
                    <h2>来源与合规</h2>
                    <p>Provider、免责声明与审图号保持可见，不隐藏到折叠层级后面。</p>
                  </div>
                </div>
                <div className="compliance-strip-content">
                  <div className="compliance-primary">
                    <CompliancePanel policy={mapState.policy} />
                    <div className="live-block">
                      <p className="eyebrow">底图说明</p>
                      <p>当前展示底图固定为高德地图，地图主舞台和控制台结果会围绕同一套高德数据更新。</p>
                    </div>
                  </div>
                  <SourceCardList cards={latestSourceCards} />
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="hero-panel workspace-header system-hero" id="system-overview">
                <div className="hero-copy">
                  <p className="eyebrow">System Workspace</p>
                  <h2>运行设置优先，绑定状态与诊断集中到右侧健康区。</h2>
                  <p>
                    这里集中查看地图模式、模型切换、运行时架构摘要、告警和流程追踪，方便演示与排障。
                  </p>
                  <div className="hero-chips">
                    <span>{formatModeLabel(runtime.mapMode)}</span>
                    <span>amap</span>
                    <span>{runtime.llmProvider}</span>
                  </div>
                </div>
                <div className="hero-stats">
                  {runtimeHealth.map((metric) => (
                    <article key={metric.label}>
                      <p>{metric.label}</p>
                      <strong className={`health-${metric.tone}`}>{metric.value}</strong>
                    </article>
                  ))}
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
                      <div className="settings-grid">
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
                          <input id="map-provider-select" readOnly value="amap" />
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
                      </div>

                      <div className="config-cluster">
                        <div className="config-cluster-header">
                          <div>
                            <p className="eyebrow">LLM Runtime Profile</p>
                            <h3>{activeLlmMeta.providerLabel}</h3>
                          </div>
                          <div className="hero-chips">
                            <span>{runtime.llmProvider}</span>
                            <span>{activeLlmConfig.model || activeLlmMeta.defaultModel}</span>
                            <span>{llmBinding ? formatBindingLabel(providerBindings, "llm") : "待检测"}</span>
                          </div>
                        </div>

                        <div className="config-grid">
                          <label htmlFor="llm-model-select">
                            当前模型
                            <select
                              id="llm-model-select"
                              onChange={(event) =>
                                setLlmPanelConfig((current) => ({
                                  ...current,
                                  [runtime.llmProvider]: {
                                    ...current[runtime.llmProvider],
                                    model: event.target.value
                                  }
                                }))
                              }
                              value={activeLlmConfig.model || activeLlmMeta.defaultModel}
                            >
                              {activeLlmMeta.modelOptions.map((modelOption) => (
                                <option key={modelOption} value={modelOption}>
                                  {modelOption}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label htmlFor="llm-model-env">
                            模型环境变量
                            <input id="llm-model-env" readOnly value={activeLlmMeta.modelEnvVar} />
                          </label>

                          {activeLlmMeta.baseUrlEnvVar ? (
                            <>
                              <label htmlFor="llm-base-url">
                                兼容基地址
                                <input
                                  id="llm-base-url"
                                  onChange={(event) =>
                                    setLlmPanelConfig((current) => ({
                                      ...current,
                                      [runtime.llmProvider]: {
                                        ...current[runtime.llmProvider],
                                        baseUrl: event.target.value
                                      }
                                    }))
                                  }
                                  placeholder={activeLlmMeta.baseUrlPlaceholder}
                                  value={activeLlmConfig.baseUrl ?? ""}
                                />
                              </label>

                              <label htmlFor="llm-base-url-env">
                                基地址环境变量
                                <input
                                  id="llm-base-url-env"
                                  readOnly
                                  value={activeLlmMeta.baseUrlEnvVar}
                                />
                              </label>
                            </>
                          ) : null}

                          <label htmlFor="llm-credential-env">
                            凭证环境变量
                            <input
                              id="llm-credential-env"
                              readOnly
                              value={llmBinding?.credentialEnvVar ?? "由当前 provider 自动决定"}
                            />
                          </label>

                          <label htmlFor="llm-credential-status">
                            凭证状态
                            <input
                              id="llm-credential-status"
                              readOnly
                              value={
                                llmBinding?.adapterMode.includes("requires_configuration")
                                  ? "未就绪"
                                  : llmBinding
                                    ? "已检测到配置"
                                    : "待检测"
                              }
                            />
                          </label>
                        </div>

                        <div className="source-grid config-note-grid">
                          <article className="source-card">
                            <p className="source-provider">provider status</p>
                            <h3>{llmBinding?.adapterMode ?? "requires_configuration"}</h3>
                            <p>{llmBinding?.message ?? "运行时绑定信息加载后会显示在这里。"}</p>
                          </article>
                          <article className="source-card">
                            <p className="source-provider">官方对齐</p>
                            <h3>模型名与接入地址</h3>
                            <p>{activeLlmMeta.notes.join(" ")}</p>
                            {activeLlmMeta.docsLinks?.length ? (
                              <div className="doc-link-list">
                                {activeLlmMeta.docsLinks.map((item) => (
                                  <a href={item.href} key={item.href} rel="noreferrer" target="_blank">
                                    {item.label}
                                  </a>
                                ))}
                              </div>
                            ) : null}
                          </article>
                        </div>

                        {providerSpecificWarnings.length > 0 ? (
                          <div className="warning-list">
                            {providerSpecificWarnings.map((warning) => (
                              <p key={warning}>{warning}</p>
                            ))}
                          </div>
                        ) : (
                          <p className="muted-copy">当前 provider 没有额外模型链路告警。</p>
                        )}
                      </div>
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
                  <SectionCard title="运行健康" subtitle="将 provider 状态、告警和事件追踪集中到一处">
                    <div className="system-subsection" id="bindings">
                      <h3 className="subsection-heading">Provider 绑定</h3>
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
                    </div>
                    <div className="system-subsection" id="diagnostics">
                      <h3 className="subsection-heading">运行诊断</h3>
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
                    </div>
                  </SectionCard>
                </aside>
              </div>
            </>
          )}
        </main>
      </div>

    </div>
  );
}
