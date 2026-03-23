import {
  mapPolicySchema,
  runtimeConfigSchema,
  type MapPolicy,
  type MapProvider,
  type RuntimeConfig
} from "@maps/schemas";

export interface MapProviderDescriptor {
  id: MapProvider;
  displayName: string;
  domesticCompliant: boolean;
  attributionText: string;
  defaultReviewNumber: string | null;
}

const MAP_PROVIDER_DESCRIPTORS: Record<MapProvider, MapProviderDescriptor> = {
  tianditu: {
    id: "tianditu",
    displayName: "Tianditu",
    domesticCompliant: true,
    attributionText: "地图数据通过天地图合规链路接入，正式上线时需使用真实授权服务。",
    defaultReviewNumber: "审图号：GS(2024)1234号"
  },
  amap: {
    id: "amap",
    displayName: "Amap",
    domesticCompliant: true,
    attributionText: "地图数据通过国内商业地图链路接入，正式上线时需保留供应商版权信息。",
    defaultReviewNumber: "审图号：GS(2024)5678号"
  },
  mapbox: {
    id: "mapbox",
    displayName: "Mapbox",
    domesticCompliant: false,
    attributionText: "仅限实验模式使用，不可作为中国公开发布默认底图。",
    defaultReviewNumber: null
  },
  osm: {
    id: "osm",
    displayName: "OpenStreetMap Experimental Surface",
    domesticCompliant: false,
    attributionText:
      "Map data © OpenStreetMap contributors。仅限 internal 或 experimental 模式参考使用，不可作为中国公开发布默认底图。",
    defaultReviewNumber: null
  }
};

export function listMapProviders(runtime?: Partial<RuntimeConfig>) {
  const normalizedRuntime = runtimeConfigSchema.parse(runtime ?? {});

  return Object.values(MAP_PROVIDER_DESCRIPTORS).map((descriptor) => ({
    ...descriptor,
    enabled: descriptor.domesticCompliant
      ? true
      : normalizedRuntime.mapMode !== "china_public" &&
        normalizedRuntime.enableForeignMapExperiments,
    reason:
      normalizedRuntime.mapMode === "china_public" && !descriptor.domesticCompliant
        ? "china_public 模式下仅允许国内合规 provider。"
        : !descriptor.domesticCompliant && !normalizedRuntime.enableForeignMapExperiments
          ? "需要显式开启 foreign map experiments。"
          : undefined
  }));
}

/**
 * China-facing public mode must prefer domestic compliant providers and keep
 * legal display requirements enabled by default.
 */
export function resolveMapPolicy(rawConfig: RuntimeConfig): MapPolicy {
  const config = runtimeConfigSchema.parse(rawConfig);
  const descriptor = MAP_PROVIDER_DESCRIPTORS[config.mapProvider];

  if (config.mapMode === "china_public") {
    if (!descriptor.domesticCompliant) {
      throw new Error(
        `china_public mode requires a domestic compliant map provider, received "${config.mapProvider}".`
      );
    }

    if (config.enableForeignMapExperiments) {
      throw new Error("china_public mode cannot enable foreign map experiments.");
    }
  }

  if (!descriptor.domesticCompliant && !config.enableForeignMapExperiments) {
    throw new Error(
      `Non-domestic provider "${config.mapProvider}" requires enableForeignMapExperiments=true.`
    );
  }

  return mapPolicySchema.parse({
    mapMode: config.mapMode,
    baseMapProvider: config.mapProvider,
    providerDisplayName: descriptor.displayName,
    allowForeignProviders:
      config.mapMode !== "china_public" && config.enableForeignMapExperiments,
    requireAttributionDisplay: true,
    requireDomesticReviewNumber: config.mapMode === "china_public",
    reviewNumber: config.mapMode === "china_public" ? descriptor.defaultReviewNumber : null,
    attributionText: descriptor.attributionText,
    disclaimerText:
      config.mapMode === "china_public"
        ? "当前配置遵循中国公开地图展示的合规默认值，地图事实仍需以真实合规服务返回为准。"
        : "当前为内部或实验模式，非公开发布配置不可直接用于中国公开地图产品。"
  });
}
