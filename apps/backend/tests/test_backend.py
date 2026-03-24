from fastapi.testclient import TestClient

from apps.backend.app.ai_layer import (
    AgentPlanningResult,
    LlmAgent,
    PlannedToolCall,
    PlannedTurnStep,
    TurnStepPlan,
    _build_openai_model_settings,
)
from apps.backend.app.amap_mcp import MapToolExecutionError
from apps.backend.app.main import app
from apps.backend.app import main
from apps.backend.app.service import AssistantService
from apps.backend.app.schemas import IntentClassification, RuntimeConfig


client = TestClient(app)


def test_runtime_endpoint_returns_defaults() -> None:
    response = client.get("/api/runtime")
    assert response.status_code == 200
    payload = response.json()
    assert payload["runtime"]["mapMode"] == "internal"
    assert payload["runtime"]["mapProvider"] == "amap"
    assert payload["runtime"]["enableForeignMapExperiments"] is False
    assert len(payload["bindings"]) == 5
    assert "PydanticAI" in payload["architectureSummary"]
    assert any(
        item["stack"] == "Gemini / OpenAI-compatible / Anthropic / LiteLLM gateway"
        for item in payload["stack"]
    )
    assert any(binding["adapterMode"] == "requires_configuration" for binding in payload["bindings"])


def test_turn_endpoint_fails_gracefully_without_llm_credentials() -> None:
    response = client.post(
        "/api/turn",
        json={
            "runtime": {
                "mapMode": "china_public",
                "mapProvider": "tianditu",
                "llmProvider": "openai",
                "enableForeignMapExperiments": False,
            },
            "sessionId": "backend-session",
            "transcriptText": "带我看看浦东新区的重点区域",
            "mapContext": {
                "currentBounds": [0, 0, 100, 100],
                "activeLayer": "vector",
                "highlightedFeatureIds": [],
            },
        },
    )
    assert response.status_code == 503
    payload = response.json()
    assert "provider" in payload["detail"]


def test_runtime_endpoint_allows_osm_in_experimental_mode() -> None:
    response = client.post(
        "/api/turn",
        json={
            "runtime": {
                "mapMode": "experimental",
                "mapProvider": "osm",
                "llmProvider": "openai",
                "enableForeignMapExperiments": True,
            },
            "sessionId": "backend-session-3",
            "transcriptText": "带我看看浦东新区的重点区域",
            "mapContext": {
                "currentBounds": [0, 0, 100, 100],
                "activeLayer": "vector",
                "highlightedFeatureIds": [],
            },
        },
    )
    assert response.status_code == 503


def test_turn_endpoint_requires_real_credentials_for_gemini() -> None:
    response = client.post(
        "/api/turn",
        json={
            "runtime": {
                "mapMode": "internal",
                "mapProvider": "osm",
                "llmProvider": "gemini",
                "enableForeignMapExperiments": True,
            },
            "sessionId": "backend-session-4",
            "transcriptText": "统计浦东新区有哪些重点区域",
            "mapContext": {
                "currentBounds": [0, 0, 100, 100],
                "activeLayer": "vector",
                "highlightedFeatureIds": [],
            },
        },
    )
    assert response.status_code == 503
    payload = response.json()
    assert "Gemini" in payload["detail"] or "provider" in payload["detail"]


def test_assistant_service_uses_process_env_for_agent_creation(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("MAP_PROVIDER", "amap")
    monkeypatch.setenv("ENABLE_FOREIGN_MAP_EXPERIMENTS", "false")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")

    service = AssistantService()

    assert service.default_runtime.llm_provider.value == "gemini"
    inspection = service.inspect_runtime(service.default_runtime)
    assert any(
        binding.provider_id == "gemini" and "已提供" in binding.message
        for binding in inspection["bindings"]
    )


def test_turn_endpoint_returns_user_facing_error_for_amap_engine_data_error(monkeypatch) -> None:
    def raise_engine_error(*args, **kwargs):
        raise MapToolExecutionError(
            "高德 MCP 工具 maps_search_detail 调用失败：ENGINE_RESPONSE_DATA_ERROR，参数={'id': 'B001'}"
        )

    monkeypatch.setattr(main.service, "handle_turn", raise_engine_error)

    response = client.post(
        "/api/turn",
        json={
            "runtime": {
                "mapMode": "internal",
                "mapProvider": "amap",
                "llmProvider": "gemini",
                "enableForeignMapExperiments": False,
            },
            "sessionId": "backend-session-5",
            "transcriptText": "跳转到日本",
            "mapContext": {
                "currentBounds": [0, 0, 100, 100],
                "activeLayer": "vector",
                "highlightedFeatureIds": [],
            },
        },
    )

    assert response.status_code == 502
    payload = response.json()
    assert "无法解析该地点或区域" in payload["detail"]
    assert "ENGINE_RESPONSE_DATA_ERROR" in payload["detail"]


def test_assistant_service_executes_multi_step_plan_in_order(monkeypatch) -> None:
    class FakeAgent:
        def plan_turn(self, transcript_text: str, highlighted_feature_ids: list[str], active_layer: str):
            assert transcript_text == "先看浦东新区，再详细介绍"
            assert highlighted_feature_ids == []
            assert active_layer == "vector"
            return AgentPlanningResult(
                classification=IntentClassification(intent="detail_follow_up", confidence=0.92),
                steps=[
                    PlannedTurnStep(
                        id="step-1",
                        classification=IntentClassification(
                            intent="focus_area",
                            confidence=0.91,
                            focusQuery="浦东新区",
                        ),
                        tool_calls=[],
                    ),
                    PlannedTurnStep(
                        id="step-2",
                        classification=IntentClassification(
                            intent="detail_follow_up",
                            confidence=0.88,
                        ),
                        tool_calls=[],
                    ),
                ],
                nl2sql_plan=None,
            )

        def plan_tool_calls(
            self,
            classification: IntentClassification,
            highlighted_feature_ids: list[str],
        ) -> list[dict[str, object]]:
            if classification.intent == "focus_area":
                return [
                    {
                        "toolName": "poiSearch",
                        "arguments": {"query": classification.focus_query},
                    }
                ]
            if classification.intent == "detail_follow_up":
                return [
                    {
                        "toolName": "areaLookup",
                        "arguments": {"featureId": highlighted_feature_ids[0]},
                    }
                ]
            return []

        def build_clarification(self, classification, tool_calls, tool_results):
            del classification, tool_calls, tool_results
            return None

        def build_map_action_plan(self, classification, tool_results, active_layer):
            del active_layer
            if classification.intent == "focus_area":
                feature_id = tool_results[0]["features"][0]["id"]
                return {
                    "summary": "已生成地图聚焦展示视图。",
                    "actions": [
                        {
                            "type": "highlight_features",
                            "featureIds": [feature_id],
                            "style": "primary",
                        }
                    ],
                    "sourceCards": [],
                }
            return {
                "summary": "已生成地图聚焦展示视图。",
                "actions": [
                    {
                        "type": "show_callouts",
                        "items": [
                            {
                                "featureId": tool_results[0]["feature"]["id"],
                                "title": "重点 1",
                                "body": "浦东新区详情",
                                "index": 1,
                            }
                        ],
                    }
                ],
                "sourceCards": [],
            }

        def generate_narration(self, classification, tool_results, map_action_plan, transcript_text):
            del classification, tool_results, map_action_plan, transcript_text
            return {"text": "已依次完成地图聚焦和详情展示。", "language": "zh-CN", "grounding": []}

    class FakeMaps:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def run_tool_call(self, tool_call: dict[str, object], runtime: RuntimeConfig) -> dict[str, object]:
            del runtime
            self.calls.append(tool_call)
            if tool_call["toolName"] == "poiSearch":
                return {
                    "tool": "poiSearch",
                    "query": "浦东新区",
                    "isAmbiguous": False,
                    "features": [
                        {
                            "id": "amap-poi-pudong",
                            "name": "浦东新区",
                            "aliases": [],
                            "kind": "district",
                            "description": "上海市浦东新区",
                            "bbox": [121.49, 31.17, 121.59, 31.27],
                            "centroid": [121.54, 31.22],
                            "tags": ["district"],
                            "narrativeBullets": ["浦东新区"],
                        }
                    ],
                    "sourceCards": [],
                }
            return {
                "tool": "areaLookup",
                "feature": {
                    "id": tool_call["arguments"]["featureId"],
                    "name": "浦东新区",
                    "aliases": [],
                    "kind": "district",
                    "description": "上海市浦东新区",
                    "bbox": [121.49, 31.17, 121.59, 31.27],
                    "centroid": [121.54, 31.22],
                    "tags": ["district"],
                    "narrativeBullets": ["浦东新区"],
                },
                "keyPoints": [{"title": "重点 1", "body": "浦东新区详情"}],
                "sourceCards": [],
            }

    service = AssistantService(env={})
    fake_maps = FakeMaps()
    service._maps = fake_maps
    monkeypatch.setattr(service, "_create_agent", lambda runtime: FakeAgent())

    response = service.handle_turn(
        runtime=RuntimeConfig(
            mapMode="internal",
            mapProvider="amap",
            llmProvider="gemini",
            enableForeignMapExperiments=False,
        ),
        session_id="multi-step-session",
        transcript_text="先看浦东新区，再详细介绍",
        map_context={
            "currentBounds": [121.49, 31.17, 121.59, 31.27],
            "activeLayer": "vector",
            "highlightedFeatureIds": [],
        },
    )

    assert [step.id for step in response.result.steps] == ["step-1", "step-2"]
    assert response.result.steps[0].tool_calls[0].tool_name == "poiSearch"
    assert response.result.steps[1].tool_calls[0].tool_name == "areaLookup"
    assert response.result.steps[1].tool_calls[0].arguments["featureId"] == "amap-poi-pudong"
    assert [call["toolName"] for call in fake_maps.calls] == ["poiSearch", "areaLookup"]
    assert response.result.map_action_plan.summary == "已按顺序执行 2 个地图步骤。"


def test_qwen_dashscope_path_disables_thinking_mode_for_structured_output() -> None:
    settings = _build_openai_model_settings(
        "qwen3.5-flash",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )

    assert settings is not None
    assert settings["extra_body"]["enable_thinking"] is False

    other_settings = _build_openai_model_settings(
        "gpt-5-mini",
        "https://api.openai.com/v1",
    )
    assert other_settings is None


def test_invalid_model_planned_tool_call_is_filtered() -> None:
    agent = object.__new__(LlmAgent)
    invalid_step = TurnStepPlan(
        classification=IntentClassification(intent="focus_area", confidence=0.8, focusQuery="浦东新区"),
        toolCalls=[PlannedToolCall(toolName="poiSearch", arguments={"locale": "zh-CN"})],
    )

    normalized = agent._normalize_tool_calls(invalid_step.tool_calls)

    assert normalized == []


def test_assistant_service_prefers_model_planned_tool_calls(monkeypatch) -> None:
    class FakeAgent:
        def plan_turn(self, transcript_text: str, highlighted_feature_ids: list[str], active_layer: str):
            assert transcript_text == "切到卫星图并看看浦东新区"
            assert highlighted_feature_ids == []
            assert active_layer == "vector"
            return AgentPlanningResult(
                classification=IntentClassification(intent="focus_area", confidence=0.9),
                steps=[
                    PlannedTurnStep(
                        id="step-1",
                        classification=IntentClassification(
                            intent="focus_area",
                            confidence=0.9,
                            requestedLayer="satellite",
                            focusQuery="浦东新区",
                        ),
                        tool_calls=[
                            {
                                "toolName": "poiSearch",
                                "arguments": {"query": "浦东新区", "locale": "zh-CN"},
                            }
                        ],
                    )
                ],
                nl2sql_plan=None,
            )

        def plan_tool_calls(self, classification, highlighted_feature_ids):
            del classification, highlighted_feature_ids
            raise AssertionError("fallback tool planning should not run when model already planned tools")

        def build_clarification(self, classification, tool_calls, tool_results):
            del classification, tool_calls, tool_results
            return None

        def build_map_action_plan(self, classification, tool_results, active_layer):
            del active_layer
            feature_id = tool_results[0]["features"][0]["id"]
            return {
                "summary": "已生成地图聚焦展示视图。",
                "actions": [
                    {"type": "set_layer", "layer": classification.requested_layer.value},
                    {
                        "type": "highlight_features",
                        "featureIds": [feature_id],
                        "style": "primary",
                    },
                ],
                "sourceCards": [],
            }

        def generate_narration(self, classification, tool_results, map_action_plan, transcript_text):
            del classification, tool_results, map_action_plan, transcript_text
            return {"text": "已切到卫星图并聚焦浦东新区。", "language": "zh-CN", "grounding": []}

    class FakeMaps:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def run_tool_call(self, tool_call: dict[str, object], runtime: RuntimeConfig) -> dict[str, object]:
            del runtime
            self.calls.append(tool_call)
            return {
                "tool": "poiSearch",
                "query": tool_call["arguments"]["query"],
                "isAmbiguous": False,
                "features": [
                    {
                        "id": "amap-poi-pudong",
                        "name": "浦东新区",
                        "aliases": [],
                        "kind": "district",
                        "description": "上海市浦东新区",
                        "bbox": [121.49, 31.17, 121.59, 31.27],
                        "centroid": [121.54, 31.22],
                        "tags": ["district"],
                        "narrativeBullets": ["浦东新区"],
                    }
                ],
                "sourceCards": [],
            }

    service = AssistantService(env={})
    fake_maps = FakeMaps()
    service._maps = fake_maps
    monkeypatch.setattr(service, "_create_agent", lambda runtime: FakeAgent())

    response = service.handle_turn(
        runtime=RuntimeConfig(
            mapMode="internal",
            mapProvider="amap",
            llmProvider="openai",
            enableForeignMapExperiments=False,
        ),
        session_id="planned-tool-call-session",
        transcript_text="切到卫星图并看看浦东新区",
        map_context={
            "currentBounds": [121.49, 31.17, 121.59, 31.27],
            "activeLayer": "vector",
            "highlightedFeatureIds": [],
        },
    )

    assert [call["toolName"] for call in fake_maps.calls] == ["poiSearch"]
    assert fake_maps.calls[0]["arguments"]["locale"] == "zh-CN"
    assert response.result.steps[0].tool_calls[0].tool_name == "poiSearch"
    assert response.result.map_action_plan.actions[0].type == "set_layer"
