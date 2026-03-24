from apps.backend.app.amap_mcp import (
    AmapMcpClient,
    AmapMcpError,
    MapToolExecutionError,
    McpToolExchange,
    normalize_poi_search_from_exchanges,
    normalize_route_summary_from_exchanges,
)
from apps.backend.app.map_service import MapService
from apps.backend.app.schemas import RuntimeConfig


class FakeAmapClient:
    def poi_search(self, query: str) -> dict[str, object]:
        return {
            "tool": "poiSearch",
            "query": query,
            "isAmbiguous": False,
            "features": [
                {
                    "id": "amap-feature-1",
                    "name": query,
                    "aliases": ["浦东"],
                    "kind": "district",
                    "description": "上海市浦东新区",
                    "bbox": (121.48, 31.18, 121.92, 31.36),
                    "centroid": (121.70, 31.27),
                    "tags": ["district"],
                    "narrativeBullets": ["位置说明"],
                }
            ],
            "sourceCards": [
                {
                    "id": "source-amap-mcp",
                    "title": "高德地图 MCP 工具链",
                    "provider": "AMap MCP",
                    "note": "地图查询与路线摘要优先通过高德官方 MCP Server 获取。",
                }
            ],
        }

    def area_lookup(self, query: str) -> dict[str, object]:
        return {
            "tool": "areaLookup",
            "feature": {
                "id": "amap-feature-1",
                "name": query,
                "aliases": [],
                "kind": "district",
                "description": "上海市浦东新区",
                "bbox": (121.48, 31.18, 121.92, 31.36),
                "centroid": (121.70, 31.27),
                "tags": ["district"],
                "narrativeBullets": ["位置说明"],
            },
            "keyPoints": [{"title": "位置说明", "body": "上海市浦东新区"}],
            "sourceCards": [
                {
                    "id": "source-amap-mcp",
                    "title": "高德地图 MCP 工具链",
                    "provider": "AMap MCP",
                    "note": "地图查询与路线摘要优先通过高德官方 MCP Server 获取。",
                }
            ],
        }

    def route_summary(self, start_query: str, end_query: str) -> dict[str, object]:
        return {
            "tool": "routeSummary",
            "routeId": "route-1",
            "name": f"{start_query} 到 {end_query}",
            "startFeature": {
                "id": "start-1",
                "name": start_query,
                "aliases": [],
                "kind": "origin",
                "description": "路线起点",
                "bbox": (121.80, 31.15, 121.82, 31.17),
                "centroid": (121.81, 31.16),
                "tags": ["route", "origin"],
                "narrativeBullets": ["路线起点"],
            },
            "endFeature": {
                "id": "end-1",
                "name": end_query,
                "aliases": [],
                "kind": "destination",
                "description": "路线终点",
                "bbox": (121.30, 31.18, 121.32, 31.20),
                "centroid": (121.31, 31.19),
                "tags": ["route", "destination"],
                "narrativeBullets": ["路线终点"],
            },
            "bounds": (121.30, 31.15, 121.82, 31.20),
            "path": [(121.81, 31.16), (121.55, 31.17), (121.31, 31.19)],
            "landmarks": [
                {
                    "featureId": "landmark-1",
                    "name": "路线节点 1",
                    "summary": "由高德 MCP 路线结果提取的关键路径节点。",
                    "point": (121.81, 31.16),
                }
            ],
            "summary": "通过高德 MCP 生成路线概览。",
            "cautions": ["该结果用于讲解展示，不承诺实时导航时效性。"],
            "sourceCards": [
                {
                    "id": "source-amap-mcp",
                    "title": "高德地图 MCP 工具链",
                    "provider": "AMap MCP",
                    "note": "地图查询与路线摘要优先通过高德官方 MCP Server 获取。",
                }
            ],
        }


def test_map_service_uses_amap_mcp_results() -> None:
    service = MapService(env={"AMAP_API_KEY": "test-key"}, amap_client=FakeAmapClient())
    runtime = RuntimeConfig(
        mapMode="china_public",
        mapProvider="amap",
        llmProvider="openai",
        enableForeignMapExperiments=False,
    )

    poi = service.run_tool_call(
        {"toolName": "poiSearch", "arguments": {"query": "浦东新区"}},
        runtime,
    )
    assert poi["tool"] == "poiSearch"
    assert poi["features"][0]["name"] == "浦东新区"

    area = service.run_tool_call(
        {"toolName": "areaLookup", "arguments": {"featureId": "浦东新区"}},
        runtime,
    )
    assert area["tool"] == "areaLookup"
    assert area["feature"]["name"] == "浦东新区"

    route = service.run_tool_call(
        {"toolName": "routeSummary", "arguments": {"from": "浦东机场", "to": "国家会展中心"}},
        runtime,
    )
    assert route["tool"] == "routeSummary"
    assert len(route["path"]) == 3


def test_map_service_requires_amap_key() -> None:
    service = MapService(env={})
    runtime = RuntimeConfig(
        mapMode="china_public",
        mapProvider="amap",
        llmProvider="openai",
        enableForeignMapExperiments=False,
    )

    try:
        service.run_tool_call(
            {"toolName": "poiSearch", "arguments": {"query": "浦东新区"}},
            runtime,
        )
    except AmapMcpError as error:
        assert "AMAP_API_KEY" in str(error)
    else:
        raise AssertionError("Expected AmapMcpError when AMAP_API_KEY is missing")


class EngineErrorAmapClient(AmapMcpClient):
    def __init__(self) -> None:
        self._runtime = None  # type: ignore[assignment]

    async def _call_tool_async(self, tool_name: str, args: dict[str, object]) -> dict[str, object]:
        if tool_name == "maps_text_search":
            return {
                "pois": [
                    {
                        "id": "B001",
                        "name": "浦东新区",
                        "location": "121.544346,31.221461",
                        "address": "浦东新区",
                        "type": "地名地址信息;普通地名;区县级地名",
                        "cityname": "上海市",
                        "adname": "浦东新区",
                    }
                ]
            }
        if tool_name == "maps_search_detail":
            raise MapToolExecutionError("API 调用失败：ENGINE_RESPONSE_DATA_ERROR")
        if tool_name == "maps_direction_driving":
            raise MapToolExecutionError("API 调用失败：ENGINE_RESPONSE_DATA_ERROR")
        raise AssertionError(f"Unexpected tool call: {tool_name} {args}")


class RouteEngineErrorAmapClient(AmapMcpClient):
    def __init__(self) -> None:
        self._runtime = None  # type: ignore[assignment]

    async def _call_tool_async(self, tool_name: str, args: dict[str, object]) -> dict[str, object]:
        if tool_name == "maps_text_search":
            return {
                "pois": [
                    {
                        "id": "B001",
                        "name": "浦东新区",
                        "location": "121.544346,31.221461",
                        "address": "浦东新区",
                        "type": "地名地址信息;普通地名;区县级地名",
                        "cityname": "上海市",
                        "adname": "浦东新区",
                    }
                ]
            }
        if tool_name == "maps_search_detail":
            return {
                "id": "B001",
                "name": "浦东新区",
                "location": "121.544346,31.221461",
                "address": "浦东新区",
                "type": "地名地址信息;普通地名;区县级地名",
                "city": "上海市",
                "business_area": "浦东新区",
            }
        if tool_name == "maps_direction_driving":
            raise MapToolExecutionError("API 调用失败：ENGINE_RESPONSE_DATA_ERROR")
        raise AssertionError(f"Unexpected tool call: {tool_name} {args}")


def test_amap_client_raises_clear_error_when_detail_returns_engine_data_error() -> None:
    client = EngineErrorAmapClient()

    try:
        client.poi_search("浦东新区")
    except MapToolExecutionError as error:
        assert "maps_search_detail" in str(error)
        assert "ENGINE_RESPONSE_DATA_ERROR" in str(error)
    else:
        raise AssertionError("Expected MapToolExecutionError when maps_search_detail fails")


def test_amap_client_raises_clear_error_when_route_engine_returns_data_error() -> None:
    client = RouteEngineErrorAmapClient()

    try:
        client.route_summary("浦东新区", "浦东新区")
    except MapToolExecutionError as error:
        assert "maps_direction_driving" in str(error)
        assert "ENGINE_RESPONSE_DATA_ERROR" in str(error)
    else:
        raise AssertionError("Expected MapToolExecutionError when maps_direction_driving fails")


def test_normalize_poi_search_from_agent_mcp_exchanges() -> None:
    result = normalize_poi_search_from_exchanges(
        "浦东新区",
        [
            McpToolExchange(
                tool_name="maps_text_search",
                arguments={"keywords": "浦东新区"},
                result={
                    "pois": [
                        {
                            "id": "B001",
                            "name": "浦东新区",
                        }
                    ]
                },
            ),
            McpToolExchange(
                tool_name="maps_search_detail",
                arguments={"id": "B001"},
                result={
                    "id": "B001",
                    "name": "浦东新区",
                    "location": "121.544346,31.221461",
                    "address": "上海市浦东新区",
                    "type": "地名地址信息;普通地名;区县级地名",
                    "city": "上海市",
                    "business_area": "浦东新区",
                },
            ),
        ],
    )

    assert result["tool"] == "poiSearch"
    assert result["features"][0]["name"] == "浦东新区"
    assert result["features"][0]["centroid"] == (121.544346, 31.221461)


def test_normalize_route_summary_from_agent_mcp_exchanges() -> None:
    result = normalize_route_summary_from_exchanges(
        "浦东机场",
        "国家会展中心",
        [
            McpToolExchange(
                tool_name="maps_text_search",
                arguments={"keywords": "浦东机场"},
                result={"pois": [{"id": "S001", "name": "浦东机场"}]},
            ),
            McpToolExchange(
                tool_name="maps_search_detail",
                arguments={"id": "S001"},
                result={
                    "id": "S001",
                    "name": "浦东机场",
                    "location": "121.7998,31.1517",
                    "address": "上海浦东国际机场",
                    "type": "交通设施服务;机场相关",
                    "city": "上海市",
                },
            ),
            McpToolExchange(
                tool_name="maps_text_search",
                arguments={"keywords": "国家会展中心"},
                result={"pois": [{"id": "E001", "name": "国家会展中心"}]},
            ),
            McpToolExchange(
                tool_name="maps_search_detail",
                arguments={"id": "E001"},
                result={
                    "id": "E001",
                    "name": "国家会展中心",
                    "location": "121.2991,31.1924",
                    "address": "国家会展中心（上海）",
                    "type": "商务住宅;楼宇;会展中心",
                    "city": "上海市",
                },
            ),
            McpToolExchange(
                tool_name="maps_direction_driving",
                arguments={
                    "origin": "121.7998,31.1517",
                    "destination": "121.2991,31.1924",
                },
                result={
                    "paths": [
                        {
                            "distance": "45678",
                            "duration": "3200",
                            "steps": [
                                {"instruction": "从机场出发驶入迎宾高速"},
                                {"instruction": "继续向西行驶"},
                                {"instruction": "到达国家会展中心"},
                            ],
                        }
                    ]
                },
            ),
        ],
    )

    assert result["tool"] == "routeSummary"
    assert result["startFeature"]["name"] == "浦东机场"
    assert result["endFeature"]["name"] == "国家会展中心"
    assert result["path"] == [(121.7998, 31.1517), (121.2991, 31.1924)]
