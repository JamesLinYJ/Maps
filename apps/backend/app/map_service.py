from __future__ import annotations

import os

from .amap_mcp import SOURCE_CARDS, AmapMcpClient
from .schemas import AreaKeyPoint, AreaLookupResult, MapFeature, RuntimeConfig


class MapService:
    def __init__(
        self,
        env: dict[str, str] | None = None,
        amap_client: AmapMcpClient | None = None,
    ) -> None:
        self._env = dict(os.environ if env is None else env)
        self._feature_cache: dict[str, MapFeature] = {}
        self._amap = amap_client

    def _get_amap(self) -> AmapMcpClient:
        if self._amap is None:
            self._amap = AmapMcpClient(self._env)
        return self._amap

    def poi_search(self, query: str, runtime: RuntimeConfig) -> dict[str, object]:
        del runtime
        result = self._get_amap().poi_search(query)
        self._remember_features(result)
        return result

    def area_lookup(self, feature_id_or_query: str, runtime: RuntimeConfig) -> dict[str, object]:
        del runtime
        cached_feature = self._feature_cache.get(feature_id_or_query)
        if cached_feature:
            return AreaLookupResult(
                feature=cached_feature,
                keyPoints=[
                    AreaKeyPoint(
                        title=f"重点 {index + 1}",
                        body=f"{cached_feature.name}：{bullet}",
                    )
                    for index, bullet in enumerate(
                        cached_feature.narrative_bullets[:3] or [cached_feature.description]
                    )
                ],
                sourceCards=SOURCE_CARDS,
            ).model_dump(by_alias=True)

        result = self._get_amap().area_lookup(feature_id_or_query)
        self._remember_features(result)
        return result

    def route_summary(
        self, start_query: str, end_query: str, runtime: RuntimeConfig
    ) -> dict[str, object]:
        del runtime
        result = self._get_amap().route_summary(start_query, end_query)
        self._remember_features(result)
        return result

    def run_tool_call(
        self, tool_call: dict[str, object], runtime: RuntimeConfig
    ) -> dict[str, object]:
        tool_name = tool_call["toolName"]
        arguments = tool_call["arguments"]
        if tool_name == "poiSearch":
            return self.poi_search(str(arguments["query"]), runtime)
        if tool_name == "areaLookup":
            return self.area_lookup(str(arguments["featureId"]), runtime)
        if tool_name == "routeSummary":
            return self.route_summary(str(arguments["from"]), str(arguments["to"]), runtime)
        raise ValueError(f"Unknown tool: {tool_name}")

    def _remember_features(self, result: dict[str, object]) -> None:
        if result.get("tool") == "poiSearch":
            for feature in result.get("features", []):
                self._feature_cache[feature["id"]] = MapFeature.model_validate(feature)
        elif result.get("tool") == "areaLookup":
            feature = result.get("feature")
            if feature:
                self._feature_cache[feature["id"]] = MapFeature.model_validate(feature)
        elif result.get("tool") == "routeSummary":
            if result.get("startFeature"):
                self._feature_cache[result["startFeature"]["id"]] = MapFeature.model_validate(
                    result["startFeature"]
                )
            if result.get("endFeature"):
                self._feature_cache[result["endFeature"]["id"]] = MapFeature.model_validate(
                    result["endFeature"]
                )
