from __future__ import annotations

import anyio
import os
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode

from pydantic_ai.mcp import MCPServerStreamableHTTP

from .schemas import (
    AreaKeyPoint,
    AreaLookupResult,
    MapFeature,
    PoiSearchResult,
    RouteAmbiguity,
    RouteLandmark,
    RouteSummaryResult,
    SourceCard,
)


SOURCE_CARDS = [
    SourceCard(
        id="source-amap-mcp",
        title="高德官方 MCP 工具链",
        provider="AMap MCP",
        note="地点搜索、地理编码与路线摘要来自高德官方 MCP Server 的真实返回。",
    ),
    SourceCard(
        id="source-amap-normalized",
        title="结构化结果归一化",
        provider="Maps Backend",
        note="后端把 MCP 返回结果整理为稳定的前端消费契约。",
    ),
]


class AmapMcpError(RuntimeError):
    """Raised when the official AMap MCP tools cannot be configured or executed."""


class MapToolConfigurationError(AmapMcpError):
    """Raised when MCP tooling is not configured correctly."""


class MapToolExecutionError(AmapMcpError):
    """Raised when MCP tooling fails at runtime."""


def _env_value(env: dict[str, str] | None, key: str) -> str | None:
    value = (env or os.environ).get(key)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def inspect_map_tool_runtime(env: dict[str, str] | None = None) -> dict[str, object]:
    api_key = _env_value(env, "AMAP_API_KEY")
    base_url = _env_value(env, "AMAP_MCP_SERVER_URL") or "https://mcp.amap.com/mcp"
    if not api_key:
        return {
            "backend": "amap_mcp",
            "ready": False,
            "adapterMode": "requires_configuration",
            "message": "高德 MCP 工具链未启用，缺少 AMAP_API_KEY。",
            "warnings": ["AMAP_API_KEY 未配置，真实高德 MCP tools 当前不可用。"],
        }

    return {
        "backend": "amap_mcp",
        "ready": True,
        "adapterMode": "amap_official_mcp",
        "message": f"当前地图工具层通过高德官方 MCP Server 接入，目标为 {base_url}。",
        "warnings": [],
    }


@dataclass(frozen=True)
class AmapMcpRuntime:
    server_url: str
    api_key: str
    timeout_seconds: float

    @property
    def request_url(self) -> str:
        separator = "&" if "?" in self.server_url else "?"
        return f"{self.server_url}{separator}{urlencode({'key': self.api_key})}"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "AmapMcpRuntime":
        api_key = _env_value(env, "AMAP_API_KEY")
        if not api_key:
            raise MapToolConfigurationError("AMAP_API_KEY 未配置，当前无法调用高德官方 MCP tools。")
        server_url = _env_value(env, "AMAP_MCP_SERVER_URL") or "https://mcp.amap.com/mcp"
        timeout_raw = _env_value(env, "AMAP_MCP_TIMEOUT_SECONDS") or "20"
        try:
            timeout_seconds = float(timeout_raw)
        except ValueError as error:
            raise MapToolConfigurationError("AMAP_MCP_TIMEOUT_SECONDS 必须是数字。") from error
        return cls(server_url=server_url.rstrip("?"), api_key=api_key, timeout_seconds=timeout_seconds)


def create_amap_mcp_server(env: dict[str, str] | None = None) -> MCPServerStreamableHTTP:
    runtime = AmapMcpRuntime.from_env(env)
    return MCPServerStreamableHTTP(
        url=runtime.request_url,
        timeout=runtime.timeout_seconds,
        read_timeout=runtime.timeout_seconds,
    )


@dataclass(frozen=True)
class McpToolExchange:
    tool_name: str
    arguments: dict[str, Any]
    result: dict[str, Any]
    tool_call_id: str | None = None


def _normalize_text(text: str) -> str:
    return text.strip().lower().replace(" ", "")


def _is_strong_match(query: str, candidate: str) -> bool:
    normalized_query = _normalize_text(query)
    normalized_candidate = _normalize_text(candidate)
    return (
        normalized_query == normalized_candidate
        or normalized_query in normalized_candidate
        or normalized_candidate in normalized_query
    )


def _parse_location(raw: str | None) -> tuple[float, float] | None:
    if not raw or "," not in raw:
        return None
    longitude, latitude = raw.split(",", 1)
    return (float(longitude), float(latitude))


def _bbox_for_centroid(point: tuple[float, float], size: float = 0.05) -> tuple[float, float, float, float]:
    longitude, latitude = point
    return (
        round(longitude - size, 6),
        round(latitude - size, 6),
        round(longitude + size, 6),
        round(latitude + size, 6),
    )


def _feature_kind_from_text(text: str) -> str:
    if any(keyword in text for keyword in ("新区", "城区", "区", "县", "镇")):
        return "district"
    if any(keyword in text for keyword in ("园区", "科学城", "产业园", "开发区")):
        return "campus"
    if any(keyword in text for keyword in ("机场", "火车站", "高铁站", "码头", "枢纽")):
        return "hub"
    if any(keyword in text for keyword in ("会展", "中心", "广场", "馆")):
        return "venue"
    return "landmark"


def _bounds_for_points(points: list[tuple[float, float]]) -> tuple[float, float, float, float] | None:
    if not points:
        return None
    longitudes = [item[0] for item in points]
    latitudes = [item[1] for item in points]
    return (
        round(min(longitudes), 6),
        round(min(latitudes), 6),
        round(max(longitudes), 6),
        round(max(latitudes), 6),
    )


def _feature_from_poi_detail(record: dict[str, Any], fallback_name: str, index: int) -> MapFeature | None:
    point = _parse_location(record.get("location"))
    if point is None:
        return None
    name = str(record.get("name") or fallback_name)
    description = str(record.get("address") or record.get("type") or name)
    tags = [item for item in (record.get("type"), record.get("city"), record.get("business_area")) if item]
    aliases = [item for item in (record.get("alias"), record.get("city")) if item]
    kind = _feature_kind_from_text(" ".join([name, description, *[str(item) for item in tags]]))
    feature_id = f"amap-poi-{record.get('id') or index}"
    return MapFeature(
        id=feature_id,
        name=name,
        aliases=[str(item) for item in aliases if str(item).strip()],
        kind=kind,
        description=description,
        bbox=_bbox_for_centroid(point),
        centroid=point,
        tags=[str(item) for item in tags],
        narrativeBullets=[description],
    )


def _is_engine_response_data_error(error: Exception) -> bool:
    return "ENGINE_RESPONSE_DATA_ERROR" in str(error)


def _feature_from_geo(record: dict[str, Any], query: str, index: int) -> MapFeature | None:
    point = _parse_location(record.get("location"))
    if point is None:
        return None
    city = record.get("city")
    district = record.get("district")
    province = record.get("province")
    name = str(query)
    description = " ".join(str(item) for item in (province, city, district) if item) or name
    kind = _feature_kind_from_text(f"{query} {description}")
    return MapFeature(
        id=f"amap-geo-{index}-{query}",
        name=name,
        aliases=[str(item) for item in (city, district) if item],
        kind=kind,
        description=description,
        bbox=_bbox_for_centroid(point),
        centroid=point,
        tags=[str(item) for item in (province, city, district) if item],
        narrativeBullets=[description],
    )


def _features_from_payloads(
    query: str,
    text_payload: dict[str, Any] | None,
    detail_payloads: dict[str, dict[str, Any]],
    geo_payload: dict[str, Any] | None,
) -> list[MapFeature]:
    pois = (text_payload or {}).get("pois") or []
    features: list[MapFeature] = []
    for index, poi in enumerate(pois[:5]):
        poi_id = poi.get("id")
        if not poi_id:
            continue
        detail = detail_payloads.get(str(poi_id))
        if not detail:
            continue
        feature = _feature_from_poi_detail(detail, str(poi.get("name") or query), index + 1)
        if feature is not None:
            features.append(feature)

    if features:
        return features

    results = (geo_payload or {}).get("results") or []
    return [
        feature
        for index, record in enumerate(results[:5])
        if (feature := _feature_from_geo(record, query, index + 1)) is not None
    ]


def normalize_poi_search_payloads(
    query: str,
    text_payload: dict[str, Any] | None,
    detail_payloads: dict[str, dict[str, Any]],
    geo_payload: dict[str, Any] | None,
) -> dict[str, object]:
    features = _features_from_payloads(query, text_payload, detail_payloads, geo_payload)
    exact_matches = [feature for feature in features if _is_strong_match(query, feature.name)]
    if exact_matches:
        features = exact_matches[:1]
    return PoiSearchResult(
        query=query,
        isAmbiguous=len(features) > 1,
        features=features[:5],
        sourceCards=SOURCE_CARDS,
    ).model_dump(by_alias=True)


def normalize_area_lookup_payloads(
    query_or_id: str,
    text_payload: dict[str, Any] | None,
    detail_payloads: dict[str, dict[str, Any]],
    geo_payload: dict[str, Any] | None,
) -> dict[str, object]:
    candidates = _features_from_payloads(query_or_id, text_payload, detail_payloads, geo_payload)
    if not candidates:
        raise MapToolExecutionError(f'高德 MCP 未找到“{query_or_id}”的区域信息。')
    feature = candidates[0]
    bullets = feature.narrative_bullets[:3] or [feature.description]
    key_points = [
        AreaKeyPoint(title=f"重点 {index + 1}", body=f"{feature.name}：{bullet}")
        for index, bullet in enumerate(bullets)
    ]
    return AreaLookupResult(
        feature=feature,
        keyPoints=key_points,
        sourceCards=SOURCE_CARDS,
    ).model_dump(by_alias=True)


def normalize_route_summary_payloads(
    start_query: str,
    end_query: str,
    start_candidates: list[MapFeature],
    end_candidates: list[MapFeature],
    route_payload: dict[str, Any] | None,
) -> dict[str, object]:
    exact_start = [item for item in start_candidates if _is_strong_match(start_query, item.name)]
    exact_end = [item for item in end_candidates if _is_strong_match(end_query, item.name)]
    if exact_start:
        start_candidates = exact_start[:1]
    if exact_end:
        end_candidates = exact_end[:1]

    if len(start_candidates) > 1:
        return RouteSummaryResult(
            routeId="route-ambiguity-from",
            name="Ambiguous Route Request",
            summary="需要先澄清出发点。",
            ambiguity=RouteAmbiguity(field="from", query=start_query, options=start_candidates[:5]),
            sourceCards=SOURCE_CARDS,
        ).model_dump(by_alias=True)
    if len(end_candidates) > 1:
        return RouteSummaryResult(
            routeId="route-ambiguity-to",
            name="Ambiguous Route Request",
            summary="需要先澄清终点。",
            ambiguity=RouteAmbiguity(field="to", query=end_query, options=end_candidates[:5]),
            sourceCards=SOURCE_CARDS,
        ).model_dump(by_alias=True)
    if not start_candidates or not end_candidates:
        raise MapToolExecutionError(f'高德 MCP 无法完成“{start_query} -> {end_query}”的路线规划。')

    start_feature = start_candidates[0]
    end_feature = end_candidates[0]
    paths = (route_payload or {}).get("paths") or []
    if not paths:
        raise MapToolExecutionError(f'高德 MCP 未返回“{start_query} -> {end_query}”的可用路线。')

    selected_path = paths[0]
    path_points = [start_feature.centroid, end_feature.centroid]
    landmarks = []
    for index, step in enumerate((selected_path.get("steps") or [])[:3]):
        landmarks.append(
            RouteLandmark(
                featureId=f"route-step-{index + 1}",
                name=f"路线节点 {index + 1}",
                summary=str(step.get("instruction") or "沿当前道路继续前进"),
                point=end_feature.centroid if index == 2 else start_feature.centroid,
            )
        )

    summary_parts = []
    if selected_path.get("distance"):
        summary_parts.append(f"全程约 {selected_path['distance']} 米")
    if selected_path.get("duration"):
        summary_parts.append(f"预计耗时约 {selected_path['duration']} 秒")
    summary_parts.append(f"展示从 {start_feature.name} 到 {end_feature.name} 的路线概览")

    return RouteSummaryResult(
        routeId=f"route-{start_feature.id}-{end_feature.id}",
        name=f"{start_feature.name} 到 {end_feature.name}",
        startFeature=start_feature,
        endFeature=end_feature,
        bounds=_bounds_for_points(path_points),
        path=path_points,
        landmarks=landmarks,
        summary="，".join(summary_parts),
        cautions=["该结果用于讲解展示，不承诺逐弯道导航与实时交通准确性。"],
        sourceCards=SOURCE_CARDS,
    ).model_dump(by_alias=True)


def _find_exchange(
    exchanges: list[McpToolExchange],
    tool_name: str,
    matcher: Callable[[McpToolExchange], bool],
) -> McpToolExchange | None:
    for exchange in exchanges:
        if exchange.tool_name == tool_name and matcher(exchange):
            return exchange
    return None


def _detail_payloads_for_query(
    query: str,
    exchanges: list[McpToolExchange],
) -> tuple[dict[str, Any] | None, dict[str, dict[str, Any]], dict[str, Any] | None]:
    text_exchange = _find_exchange(
        exchanges,
        "maps_text_search",
        lambda exchange: str(exchange.arguments.get("keywords", "")).strip() == query,
    )
    text_payload = text_exchange.result if text_exchange else None
    poi_ids = {
        str(poi.get("id"))
        for poi in (text_payload or {}).get("pois", [])
        if poi.get("id") is not None
    }
    detail_payloads = {
        str(exchange.arguments.get("id")): exchange.result
        for exchange in exchanges
        if exchange.tool_name == "maps_search_detail"
        and str(exchange.arguments.get("id")) in poi_ids
    }
    geo_exchange = _find_exchange(
        exchanges,
        "maps_geo",
        lambda exchange: str(exchange.arguments.get("address", "")).strip() == query,
    )
    geo_payload = geo_exchange.result if geo_exchange else None
    return text_payload, detail_payloads, geo_payload


def normalize_poi_search_from_exchanges(
    query: str,
    exchanges: list[McpToolExchange],
) -> dict[str, object]:
    text_payload, detail_payloads, geo_payload = _detail_payloads_for_query(query, exchanges)
    return normalize_poi_search_payloads(query, text_payload, detail_payloads, geo_payload)


def normalize_area_lookup_from_exchanges(
    query_or_id: str,
    exchanges: list[McpToolExchange],
) -> dict[str, object]:
    text_payload, detail_payloads, geo_payload = _detail_payloads_for_query(query_or_id, exchanges)
    return normalize_area_lookup_payloads(query_or_id, text_payload, detail_payloads, geo_payload)


def normalize_route_summary_from_exchanges(
    start_query: str,
    end_query: str,
    exchanges: list[McpToolExchange],
) -> dict[str, object]:
    start_text_payload, start_detail_payloads, start_geo_payload = _detail_payloads_for_query(
        start_query, exchanges
    )
    end_text_payload, end_detail_payloads, end_geo_payload = _detail_payloads_for_query(
        end_query, exchanges
    )
    start_candidates = _features_from_payloads(
        start_query, start_text_payload, start_detail_payloads, start_geo_payload
    )
    end_candidates = _features_from_payloads(
        end_query, end_text_payload, end_detail_payloads, end_geo_payload
    )
    route_exchange = _find_exchange(
        exchanges,
        "maps_direction_driving",
        lambda exchange: True,
    )
    route_payload = route_exchange.result if route_exchange else None
    return normalize_route_summary_payloads(
        start_query,
        end_query,
        start_candidates,
        end_candidates,
        route_payload,
    )


class AmapMcpClient:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self._runtime = AmapMcpRuntime.from_env(env)

    def poi_search(self, query: str) -> dict[str, object]:
        features = self._resolve_place_candidates(query)
        exact_matches = [
            feature for feature in features if _is_strong_match(query, feature.name)
        ]
        if exact_matches:
            features = exact_matches[:1]
        return PoiSearchResult(
            query=query,
            isAmbiguous=len(features) > 1,
            features=features[:5],
            sourceCards=SOURCE_CARDS,
        ).model_dump(by_alias=True)

    def area_lookup(self, query_or_id: str) -> dict[str, object]:
        candidates = self._resolve_place_candidates(query_or_id)
        if not candidates:
            raise MapToolExecutionError(f'高德 MCP 未找到“{query_or_id}”的区域信息。')
        feature = candidates[0]
        bullets = feature.narrative_bullets[:3] or [feature.description]
        key_points = [
            AreaKeyPoint(title=f"重点 {index + 1}", body=f"{feature.name}：{bullet}")
            for index, bullet in enumerate(bullets)
        ]
        return AreaLookupResult(
            feature=feature,
            keyPoints=key_points,
            sourceCards=SOURCE_CARDS,
        ).model_dump(by_alias=True)

    def route_summary(self, start_query: str, end_query: str) -> dict[str, object]:
        start_candidates = self._resolve_place_candidates(start_query)
        end_candidates = self._resolve_place_candidates(end_query)
        exact_start = [item for item in start_candidates if _is_strong_match(start_query, item.name)]
        exact_end = [item for item in end_candidates if _is_strong_match(end_query, item.name)]
        if exact_start:
            start_candidates = exact_start[:1]
        if exact_end:
            end_candidates = exact_end[:1]

        if len(start_candidates) > 1:
            return RouteSummaryResult(
                routeId="route-ambiguity-from",
                name="Ambiguous Route Request",
                summary="需要先澄清出发点。",
                ambiguity=RouteAmbiguity(field="from", query=start_query, options=start_candidates[:5]),
                sourceCards=SOURCE_CARDS,
            ).model_dump(by_alias=True)
        if len(end_candidates) > 1:
            return RouteSummaryResult(
                routeId="route-ambiguity-to",
                name="Ambiguous Route Request",
                summary="需要先澄清终点。",
                ambiguity=RouteAmbiguity(field="to", query=end_query, options=end_candidates[:5]),
                sourceCards=SOURCE_CARDS,
            ).model_dump(by_alias=True)
        if not start_candidates or not end_candidates:
            raise MapToolExecutionError(f'高德 MCP 无法完成“{start_query} -> {end_query}”的路线规划。')

        start_feature = start_candidates[0]
        end_feature = end_candidates[0]
        route_payload = self._call_tool(
            "maps_direction_driving",
            {
                "origin": f"{start_feature.centroid[0]},{start_feature.centroid[1]}",
                "destination": f"{end_feature.centroid[0]},{end_feature.centroid[1]}",
            },
        )
        paths = route_payload.get("paths") or []
        if not paths:
            raise MapToolExecutionError(
                f'高德 MCP 未返回“{start_query} -> {end_query}”的可用路线。'
            )

        selected_path = paths[0]
        path_points = [start_feature.centroid, end_feature.centroid]
        landmarks = []
        for index, step in enumerate((selected_path.get("steps") or [])[:3]):
            landmarks.append(
                RouteLandmark(
                    featureId=f"route-step-{index + 1}",
                    name=f"路线节点 {index + 1}",
                    summary=str(step.get("instruction") or "沿当前道路继续前进"),
                    point=end_feature.centroid if index == 2 else start_feature.centroid,
                )
            )

        summary_parts = []
        if selected_path.get("distance"):
            summary_parts.append(f"全程约 {selected_path['distance']} 米")
        if selected_path.get("duration"):
            summary_parts.append(f"预计耗时约 {selected_path['duration']} 秒")
        summary_parts.append(f"展示从 {start_feature.name} 到 {end_feature.name} 的路线概览")

        return RouteSummaryResult(
            routeId=f"route-{start_feature.id}-{end_feature.id}",
            name=f"{start_feature.name} 到 {end_feature.name}",
            startFeature=start_feature,
            endFeature=end_feature,
            bounds=_bounds_for_points(path_points),
            path=path_points,
            landmarks=landmarks,
            summary="，".join(summary_parts),
            cautions=["该结果用于讲解展示，不承诺逐弯道导航与实时交通准确性。"],
            sourceCards=SOURCE_CARDS,
        ).model_dump(by_alias=True)

    def _resolve_place_candidates(self, query: str) -> list[MapFeature]:
        text_payload = self._call_tool("maps_text_search", {"keywords": query})
        pois = text_payload.get("pois") or []
        features: list[MapFeature] = []
        for index, poi in enumerate(pois[:5]):
            poi_id = poi.get("id")
            if not poi_id:
                continue
            detail = self._call_tool("maps_search_detail", {"id": poi_id})
            feature = _feature_from_poi_detail(detail, str(poi.get("name") or query), index + 1)
            if feature is not None:
                features.append(feature)

        if features:
            return features

        geo_payload = self._call_tool("maps_geo", {"address": query})
        results = geo_payload.get("results") or []
        return [
            feature
            for index, record in enumerate(results[:5])
            if (feature := _feature_from_geo(record, query, index + 1)) is not None
        ]

    def _call_tool(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            result = anyio.run(self._call_tool_async, tool_name, args)
        except Exception as error:
            if _is_engine_response_data_error(error):
                raise MapToolExecutionError(
                    f"高德 MCP 工具 {tool_name} 调用失败：ENGINE_RESPONSE_DATA_ERROR，参数={args}"
                ) from error
            raise MapToolExecutionError(
                f"高德 MCP 工具 {tool_name} 调用失败：{error}，参数={args}"
            ) from error
        if not isinstance(result, dict):
            raise MapToolExecutionError(f"高德 MCP 工具 {tool_name} 返回了不可识别的数据结构。")
        return result

    async def _call_tool_async(self, tool_name: str, args: dict[str, Any]) -> Any:
        server = MCPServerStreamableHTTP(
            url=self._runtime.request_url,
            timeout=self._runtime.timeout_seconds,
            read_timeout=self._runtime.timeout_seconds,
        )
        return await server.direct_call_tool(tool_name, args)


AmapMcpMapService = AmapMcpClient
