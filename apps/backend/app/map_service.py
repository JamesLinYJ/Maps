from __future__ import annotations

from .scenario_data import (
    FEATURES,
    SOURCE_CARDS,
    ROUTE_LANDMARKS_BY_ID,
    ROUTE_PATHS_BY_ID,
)
from .schemas import (
    AreaKeyPoint,
    AreaLookupResult,
    MapFeature,
    PoiSearchResult,
    RouteAmbiguity,
    RouteSummaryResult,
)


def _normalize(text: str) -> str:
    return text.strip().lower()


class MapService:
    def search_features(self, query: str) -> list[MapFeature]:
        normalized = _normalize(query)
        return [
            feature
            for feature in FEATURES
            if normalized in feature.id.lower()
            or normalized in feature.name.lower()
            or any(normalized in alias.lower() for alias in feature.aliases)
        ]

    def feature_by_id(self, feature_id: str) -> MapFeature | None:
        return next((feature for feature in FEATURES if feature.id == feature_id), None)

    def poi_search(self, query: str) -> dict[str, object]:
        matches = self.search_features(query)
        return PoiSearchResult(
            query=query,
            isAmbiguous=len(matches) > 1,
            features=matches,
            sourceCards=SOURCE_CARDS,
        ).model_dump(by_alias=True)

    def area_lookup(self, feature_id: str) -> dict[str, object]:
        feature = self.feature_by_id(feature_id)
        if not feature:
            raise ValueError(f'Unknown featureId "{feature_id}"')

        return AreaLookupResult(
            feature=feature,
            keyPoints=[
                AreaKeyPoint(
                    title=bullet,
                    body=f"{feature.name}演示视图中的重点讲解方向：{bullet}。",
                )
                for bullet in feature.narrative_bullets
            ],
            sourceCards=SOURCE_CARDS,
        ).model_dump(by_alias=True)

    def route_summary(self, start_query: str, end_query: str) -> dict[str, object]:
        start_matches = self.search_features(start_query)
        end_matches = self.search_features(end_query)

        if len(start_matches) > 1:
            # 路线服务优先返回澄清信息，避免把歧义地点直接当成确定路线。
            return RouteSummaryResult(
                routeId="route-ambiguity-from",
                name="Ambiguous Route Request",
                summary="需要先澄清出发点。",
                ambiguity=RouteAmbiguity(
                    field="from",
                    query=start_query,
                    options=start_matches,
                ),
                sourceCards=SOURCE_CARDS,
            ).model_dump(by_alias=True)

        if len(end_matches) > 1:
            # 终点同样先澄清，再进入路线概览，保证讲解结果可解释。
            return RouteSummaryResult(
                routeId="route-ambiguity-to",
                name="Ambiguous Route Request",
                summary="需要先澄清终点。",
                ambiguity=RouteAmbiguity(
                    field="to",
                    query=end_query,
                    options=end_matches,
                ),
                sourceCards=SOURCE_CARDS,
            ).model_dump(by_alias=True)

        start_feature = start_matches[0] if start_matches else None
        end_feature = end_matches[0] if end_matches else None
        if not start_feature or not end_feature:
            raise ValueError(
                f'Unable to summarize route from "{start_query}" to "{end_query}"'
            )

        # 这里返回的是演示路线的概览 ID，不是实时导航计算结果。
        route_id = (
            "route-pvg-necc"
            if start_feature.id == "hub-pudong-airport"
            else "route-hq-necc"
        )
        return RouteSummaryResult(
            routeId=route_id,
            name=f"{start_feature.name} 到 {end_feature.name}",
            startFeature=start_feature,
            endFeature=end_feature,
            bounds=(
                min(start_feature.bbox[0], end_feature.bbox[0]),
                min(start_feature.bbox[1], end_feature.bbox[1]),
                max(start_feature.bbox[2], end_feature.bbox[2]),
                max(start_feature.bbox[3], end_feature.bbox[3]),
            ),
            path=ROUTE_PATHS_BY_ID[route_id],
            landmarks=ROUTE_LANDMARKS_BY_ID[route_id],
            summary=f"展示从{start_feature.name}到{end_feature.name}的路线概览。",
            # 明确声明这是讲解型路线摘要，不提供导航级别承诺。
            cautions=["该路线为概览摘要，不提供精确导航与实时交通判断。"],
            sourceCards=SOURCE_CARDS,
        ).model_dump(by_alias=True)

    def run_tool_call(self, tool_call: dict[str, object]) -> dict[str, object]:
        tool_name = tool_call["toolName"]
        arguments = tool_call["arguments"]
        if tool_name == "poiSearch":
            return self.poi_search(str(arguments["query"]))
        if tool_name == "areaLookup":
            return self.area_lookup(str(arguments["featureId"]))
        if tool_name == "routeSummary":
            return self.route_summary(str(arguments["from"]), str(arguments["to"]))
        raise ValueError(f"Unknown tool: {tool_name}")
