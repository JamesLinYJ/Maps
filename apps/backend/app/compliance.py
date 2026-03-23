from __future__ import annotations

from .schemas import MapPolicy, MapProvider, RuntimeConfig


MAP_PROVIDER_DESCRIPTORS = {
    # 这里的描述直接决定中国公开模式能否启用某个底图 provider。
    MapProvider.TIANDITU: {
        "display_name": "Tianditu",
        "domestic_compliant": True,
        "attribution_text": "地图数据通过天地图合规链路接入，正式上线时需使用真实授权服务。",
        "review_number": "审图号：GS(2024)1234号",
    },
    MapProvider.AMAP: {
        "display_name": "Amap",
        "domestic_compliant": True,
        "attribution_text": "地图数据通过国内商业地图链路接入，正式上线时需保留供应商版权信息。",
        "review_number": "审图号：GS(2024)5678号",
    },
    MapProvider.MAPBOX: {
        "display_name": "Mapbox",
        "domestic_compliant": False,
        "attribution_text": "仅限实验模式使用，不可作为中国公开发布默认底图。",
        "review_number": None,
    },
    MapProvider.OSM: {
        "display_name": "OpenStreetMap Experimental Surface",
        "domestic_compliant": False,
        "attribution_text": "Map data © OpenStreetMap contributors。仅限 internal 或 experimental 模式参考使用，不可作为中国公开发布默认底图。",
        "review_number": None,
    },
}


def list_map_providers(runtime: RuntimeConfig) -> list[dict[str, object]]:
    result = []
    for provider_id, descriptor in MAP_PROVIDER_DESCRIPTORS.items():
        enabled = (
            True
            if descriptor["domestic_compliant"]
            else runtime.map_mode != "china_public" and runtime.enable_foreign_map_experiments
        )
        reason = None
        if runtime.map_mode == "china_public" and not descriptor["domestic_compliant"]:
            reason = "china_public 模式下仅允许国内合规 provider。"
        elif not descriptor["domestic_compliant"] and not runtime.enable_foreign_map_experiments:
            reason = "需要显式开启 foreign map experiments。"
        result.append({"id": provider_id.value, **descriptor, "enabled": enabled, "reason": reason})
    return result


def resolve_map_policy(runtime: RuntimeConfig) -> MapPolicy:
    descriptor = MAP_PROVIDER_DESCRIPTORS[runtime.map_provider]
    if runtime.map_mode == "china_public":
        # 中国公开模式下，底图 provider 和实验开关都必须先通过合规校验。
        if not descriptor["domestic_compliant"]:
            raise ValueError(
                f'china_public mode requires a domestic compliant map provider, received "{runtime.map_provider.value}".'
            )
        if runtime.enable_foreign_map_experiments:
            raise ValueError("china_public mode cannot enable foreign map experiments.")

    if not descriptor["domestic_compliant"] and not runtime.enable_foreign_map_experiments:
        raise ValueError(
            f'Non-domestic provider "{runtime.map_provider.value}" requires enableForeignMapExperiments=true.'
        )

    return MapPolicy(
        mapMode=runtime.map_mode,
        baseMapProvider=runtime.map_provider,
        providerDisplayName=descriptor["display_name"],
        allowForeignProviders=runtime.map_mode != "china_public"
        and runtime.enable_foreign_map_experiments,
        requireAttributionDisplay=True,
        requireDomesticReviewNumber=runtime.map_mode == "china_public",
        reviewNumber=descriptor["review_number"] if runtime.map_mode == "china_public" else None,
        attributionText=descriptor["attribution_text"],
        disclaimerText=(
            "当前配置遵循中国公开地图展示的合规默认值，地图事实仍需以真实合规服务返回为准。"
            if runtime.map_mode == "china_public"
            else "当前为内部或实验模式，非公开发布配置不可直接用于中国公开地图产品。"
        ),
    )
