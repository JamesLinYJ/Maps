from __future__ import annotations

import json
import os
from dataclasses import dataclass

from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.litellm import LiteLLMProvider
from pydantic_ai.providers.openai import OpenAIProvider

from .nl2sql import Nl2SqlPlan, Nl2SqlPlanner
from .schemas import (
    Clarification,
    ClarificationOption,
    IntentClassification,
    Layer,
    MapActionPlan,
    Narration,
)


PROVIDER_MODEL_ENV = {
    "openai": "OPENAI_MODEL",
    "anthropic": "ANTHROPIC_MODEL",
    "gemini": "GEMINI_MODEL",
}

DEFAULT_PROVIDER_MODELS = {
    "openai": "gpt-5-mini",
    "anthropic": "claude-sonnet-4-20250514",
    "gemini": "gemini-2.5-flash",
}

LITELLM_PROVIDER_PREFIX = {
    "openai": "openai",
    "anthropic": "anthropic",
    "gemini": "google",
}

INTENT_AGENT_INSTRUCTIONS = """
你是一个中文地图讲解助手的意图理解与任务拆解模块。

你的职责：
1. 只从用户话语和当前地图上下文中提取意图，不要编造地理事实。
2. 只输出允许的 intent 枚举值。
3. 如果用户说“卫星图”或类似表达，requestedLayer 应为 satellite。
4. 如果用户在讲路线，提取 route.from 和 route.to。
5. 如果用户在请求多个点位的顺序讲解，使用 multi_point_story，并尽量补全 pointQueries。
6. 如果用户是在当前高亮对象基础上追问“详细一点”“这里”“这个园区”，优先识别为 detail_follow_up 或 focus_area。
7. confidence 返回 0 到 1 之间的数值。

不要输出解释文字，只返回结构化结果。
""".strip()

NARRATION_AGENT_INSTRUCTIONS = """
你是一个中文地图讲解助手的讲解生成模块。

硬约束：
1. 讲解内容只能基于提供的 transcript、classification、toolResults 和 mapActionPlan。
2. 不要补充工具结果中没有出现的 POI、距离、路线、法规或地理事实。
3. 语言保持简洁、自然、适合口播。
4. grounding 只能填写实际出现在工具结果中的 featureId。
5. language 默认使用 zh-CN。

只返回结构化 narration，不要输出额外说明。
""".strip()


class ProviderConfigurationError(RuntimeError):
    """Raised when the selected provider cannot be called with the current env."""


class UpstreamProviderError(RuntimeError):
    """Raised when the upstream model provider returns an unexpected error."""


@dataclass
class AgentPlanningResult:
    classification: IntentClassification
    tool_calls: list[dict[str, object]]
    nl2sql_plan: Nl2SqlPlan | None


@dataclass(frozen=True)
class ProviderRuntime:
    provider_id: str
    model_name: str
    transport_mode: str


def _env_value(env: dict[str, str], key: str) -> str | None:
    value = env.get(key)
    return value.strip() if value else None


def _build_grounding_ids(tool_results: list[dict[str, object]]) -> list[str]:
    grounded_ids: list[str] = []
    for result in tool_results:
        if result.get("tool") == "poiSearch":
            grounded_ids.extend(item["id"] for item in result.get("features", []))
        elif result.get("tool") == "areaLookup":
            grounded_ids.append(result["feature"]["id"])
        elif result.get("tool") == "routeSummary":
            grounded_ids.extend(item["featureId"] for item in result.get("landmarks", []))
            if result.get("startFeature"):
                grounded_ids.append(result["startFeature"]["id"])
            if result.get("endFeature"):
                grounded_ids.append(result["endFeature"]["id"])
    return list(dict.fromkeys(grounded_ids))


class LlmAgent:
    def __init__(
        self,
        provider_id: str,
        env: dict[str, str] | None = None,
        nl2sql_planner: Nl2SqlPlanner | None = None,
    ) -> None:
        self._provider_id = provider_id
        self._env = dict(os.environ if env is None else env)
        self._nl2sql = nl2sql_planner or Nl2SqlPlanner()
        self._runtime = self._resolve_provider_runtime()
        model = self._create_model()
        self._intent_agent = Agent(
            model=model,
            output_type=IntentClassification,
            instructions=INTENT_AGENT_INSTRUCTIONS,
            retries=2,
        )
        self._narration_agent = Agent(
            model=model,
            output_type=Narration,
            instructions=NARRATION_AGENT_INSTRUCTIONS,
            retries=2,
        )

    def _resolve_provider_runtime(self) -> ProviderRuntime:
        model_env = PROVIDER_MODEL_ENV[self._provider_id]
        configured_model = _env_value(self._env, model_env)
        model_name = configured_model or DEFAULT_PROVIDER_MODELS[self._provider_id]
        litellm_base_url = _env_value(self._env, "LITELLM_BASE_URL")

        if litellm_base_url:
            return ProviderRuntime(
                provider_id=self._provider_id,
                model_name=f'{LITELLM_PROVIDER_PREFIX[self._provider_id]}/{model_name}',
                transport_mode="pydanticai_litellm_gateway",
            )

        if self._provider_id == "openai":
            return ProviderRuntime(
                provider_id=self._provider_id,
                model_name=model_name,
                transport_mode=(
                    "pydanticai_openai_compatible"
                    if _env_value(self._env, "OPENAI_COMPAT_BASE_URL")
                    else "pydanticai_direct"
                ),
            )

        return ProviderRuntime(
            provider_id=self._provider_id,
            model_name=model_name,
            transport_mode="pydanticai_direct",
        )

    def _create_model(self):
        if self._runtime.transport_mode == "pydanticai_litellm_gateway":
            provider = LiteLLMProvider(
                api_base=_env_value(self._env, "LITELLM_BASE_URL"),
                api_key=_env_value(self._env, "LITELLM_API_KEY"),
            )
            return OpenAIChatModel(self._runtime.model_name, provider=provider)

        if self._provider_id == "openai":
            api_key = _env_value(self._env, "OPENAI_API_KEY")
            base_url = _env_value(self._env, "OPENAI_COMPAT_BASE_URL")
            if not api_key and not base_url:
                raise ProviderConfigurationError(
                    "OPENAI_API_KEY 未配置，当前无法调用 OpenAI-compatible provider。"
                )
            provider = OpenAIProvider(base_url=base_url, api_key=api_key)
            return OpenAIChatModel(self._runtime.model_name, provider=provider)

        if self._provider_id == "anthropic":
            api_key = _env_value(self._env, "ANTHROPIC_API_KEY")
            if not api_key:
                raise ProviderConfigurationError(
                    "ANTHROPIC_API_KEY 未配置，当前无法调用 Anthropic provider。"
                )
            provider = AnthropicProvider(api_key=api_key)
            return AnthropicModel(self._runtime.model_name, provider=provider)

        if self._provider_id == "gemini":
            api_key = _env_value(self._env, "GEMINI_API_KEY")
            if not api_key:
                raise ProviderConfigurationError(
                    "GEMINI_API_KEY 未配置，当前无法调用 Gemini provider。"
                )
            provider = GoogleProvider(api_key=api_key, vertexai=False)
            return GoogleModel(self._runtime.model_name, provider=provider)

        raise ProviderConfigurationError(f'Unsupported provider "{self._provider_id}".')

    def plan_turn(
        self,
        transcript_text: str,
        highlighted_feature_ids: list[str],
    ) -> AgentPlanningResult:
        classification = self.classify_intent(transcript_text, highlighted_feature_ids)
        return AgentPlanningResult(
            classification=classification,
            tool_calls=self.plan_tool_calls(classification, highlighted_feature_ids),
            nl2sql_plan=self._nl2sql.maybe_plan(transcript_text, classification),
        )

    def classify_intent(
        self,
        text: str,
        highlighted_feature_ids: list[str],
    ) -> IntentClassification:
        # 意图理解交给真实模型完成，但后续地图动作仍会走代码侧受控链路，
        # 避免让模型直接决定路线、边界或高亮结果。
        prompt = (
            "请分析下面这条地图讲解请求，并输出结构化意图。\n\n"
            f"用户请求:\n{text}\n\n"
            f"当前高亮对象 IDs:\n{json.dumps(highlighted_feature_ids, ensure_ascii=False)}\n"
        )

        try:
            result = self._intent_agent.run_sync(prompt)
        except Exception as error:
            raise self._wrap_provider_error("意图识别", error) from error

        classification = result.output

        # “这里/这个园区” 这种指代如果模型没补全，就安全地回落到当前高亮对象。
        if (
            highlighted_feature_ids
            and classification.intent == "focus_area"
            and not classification.focus_query
            and ("这个园区" in text or "这里" in text)
        ):
            classification.focus_query = highlighted_feature_ids[0]

        if "卫星" in text and classification.requested_layer is None:
            classification.requested_layer = Layer.SATELLITE
        if ("矢量" in text or "普通" in text) and classification.requested_layer is None:
            classification.requested_layer = Layer.VECTOR

        return classification

    def plan_tool_calls(
        self,
        classification: IntentClassification,
        highlighted_feature_ids: list[str],
    ) -> list[dict[str, object]]:
        # 工具调用组织保持后端显式控制，这样可以把“模型理解”和“工具执行”
        # 分离开，避免共享层被某一家 SDK 的 tool calling 细节绑死。
        if classification.intent == "route_overview" and classification.route:
            return [
                {
                    "toolName": "routeSummary",
                    "arguments": {
                        "from": classification.route["from"],
                        "to": classification.route["to"],
                    },
                }
            ]
        if classification.intent == "detail_follow_up" and highlighted_feature_ids:
            return [
                {
                    "toolName": "areaLookup",
                    "arguments": {"featureId": highlighted_feature_ids[0]},
                }
            ]
        if classification.intent == "multi_point_story":
            return [
                {"toolName": "poiSearch", "arguments": {"query": query}}
                for query in (classification.point_queries or [])
            ]
        if classification.intent == "focus_area" and classification.focus_query:
            return [
                {
                    "toolName": "poiSearch",
                    "arguments": {"query": classification.focus_query},
                }
            ]
        return []

    def build_clarification(
        self,
        classification: IntentClassification,
        tool_calls: list[dict[str, object]],
        tool_results: list[dict[str, object]],
    ) -> Clarification | None:
        ambiguous_poi = next(
            (
                item
                for item in tool_results
                if item.get("tool") == "poiSearch" and item.get("isAmbiguous")
            ),
            None,
        )
        if ambiguous_poi:
            return Clarification(
                question=f'你想看{"还是".join(item["name"] for item in ambiguous_poi["features"])}？',
                options=[
                    ClarificationOption(
                        id=item["id"],
                        label=item["name"],
                        resolvedValue=item["name"],
                    )
                    for item in ambiguous_poi["features"]
                ],
            )

        empty_poi = next(
            (
                item
                for item in tool_results
                if item.get("tool") == "poiSearch" and len(item.get("features", [])) == 0
            ),
            None,
        )
        if empty_poi:
            return Clarification(
                question=(
                    f'当前演示场景里还没有“{empty_poi["query"]}”的内置数据，'
                    "你可以试试浦东新区、陆家嘴、张江科学城或国家会展中心。"
                ),
                options=[],
            )

        ambiguous_route = next(
            (
                item
                for item in tool_results
                if item.get("tool") == "routeSummary" and item.get("ambiguity")
            ),
            None,
        )
        if ambiguous_route:
            ambiguity = ambiguous_route["ambiguity"]
            target = "出发点" if ambiguity["field"] == "from" else "终点"
            return Clarification(
                question=(
                    f'我需要先确认{target}，你想说的是'
                    f'{"还是".join(item["name"] for item in ambiguity["options"])}？'
                ),
                options=[
                    ClarificationOption(
                        id=item["id"],
                        label=item["name"],
                        resolvedValue=item["name"],
                    )
                    for item in ambiguity["options"]
                ],
            )

        if classification.intent == "multi_point_story" and not tool_calls:
            return Clarification(question="请告诉我需要标注的具体地点名称。", options=[])
        return None

    def build_map_action_plan(
        self,
        classification: IntentClassification,
        tool_results: list[dict[str, object]],
        active_layer: str,
    ) -> dict[str, object]:
        actions: list[dict[str, object]] = []
        source_cards = [card for result in tool_results for card in result.get("sourceCards", [])]
        if classification.requested_layer and classification.requested_layer.value != active_layer:
            actions.append(
                {"type": "set_layer", "layer": classification.requested_layer.value}
            )
        if classification.intent == "zoom_in":
            actions.append(
                {
                    "type": "adjust_zoom",
                    "factor": 1.35,
                    "reason": "Zoom in on the current presentation area",
                }
            )
            return MapActionPlan(
                summary="Zoomed into the current focus region.",
                actions=actions,
                sourceCards=source_cards,
            ).model_dump(by_alias=True, exclude_none=True)

        matched_features = []
        for result in tool_results:
            if result.get("tool") == "poiSearch":
                matched_features.extend(result.get("features", []))
            elif result.get("tool") == "areaLookup":
                matched_features.append(result["feature"])
            elif result.get("tool") == "routeSummary":
                if result.get("startFeature"):
                    matched_features.append(result["startFeature"])
                if result.get("endFeature"):
                    matched_features.append(result["endFeature"])

        if matched_features:
            actions.append(
                {
                    "type": "fly_to_bounds",
                    "bounds": matched_features[0]["bbox"],
                    "reason": f'Focus on {matched_features[0]["name"]}',
                }
            )
            actions.append(
                {
                    "type": "highlight_features",
                    "featureIds": [feature["id"] for feature in matched_features],
                    "style": "secondary" if len(matched_features) > 1 else "primary",
                }
            )

        route_result = next(
            (item for item in tool_results if item.get("tool") == "routeSummary"), None
        )
        callout_items = []
        if route_result and route_result.get("path") and route_result.get("bounds"):
            actions.append(
                {
                    "type": "fly_to_bounds",
                    "bounds": route_result["bounds"],
                    "reason": route_result["summary"],
                }
            )
            actions.append(
                {
                    "type": "draw_route",
                    "path": route_result["path"],
                    "landmarkFeatureIds": [
                        item["featureId"] for item in route_result.get("landmarks", [])
                    ],
                    "summary": route_result["summary"],
                }
            )
            callout_items = [
                {
                    "featureId": item["featureId"],
                    "title": item["name"],
                    "body": item["summary"],
                    "index": index + 1,
                }
                for index, item in enumerate(route_result.get("landmarks", []))
            ]
        else:
            actions.append({"type": "clear_route"})
            for result in tool_results:
                if result.get("tool") == "areaLookup":
                    callout_items.extend(
                        [
                            {
                                "featureId": result["feature"]["id"],
                                "title": item["title"],
                                "body": item["body"],
                                "index": index + 1,
                            }
                            for index, item in enumerate(result.get("keyPoints", []))
                        ]
                    )
                if result.get("tool") == "poiSearch":
                    callout_items.extend(
                        [
                            {
                                "featureId": item["id"],
                                "title": item["name"],
                                "body": item["description"],
                                "index": index + 1 if len(matched_features) > 1 else None,
                            }
                            for index, item in enumerate(result.get("features", []))
                        ]
                    )

        if callout_items:
            actions.append({"type": "show_callouts", "items": callout_items})

        summary = (
            "Generated a presentation route overview."
            if classification.intent == "route_overview"
            else "Prepared a sequential point-by-point presentation."
            if classification.intent == "multi_point_story"
            else "Prepared a focused presentation view."
        )
        return MapActionPlan(
            summary=summary,
            actions=actions,
            sourceCards=source_cards,
        ).model_dump(by_alias=True, exclude_none=True)

    def generate_narration(
        self,
        classification: IntentClassification,
        tool_results: list[dict[str, object]],
        map_action_plan: dict[str, object] | None = None,
        transcript_text: str | None = None,
    ) -> dict[str, object]:
        # 讲解生成允许由模型完成，但 grounding 必须在代码侧二次裁剪，
        # 确保口播引用的 featureId 真正来自当前工具结果。
        prompt_payload = {
            "transcript": transcript_text or "",
            "classification": classification.model_dump(by_alias=True, exclude_none=True),
            "toolResults": tool_results,
            "mapActionPlan": map_action_plan or {},
        }

        try:
            result = self._narration_agent.run_sync(
                json.dumps(prompt_payload, ensure_ascii=False, indent=2)
            )
        except Exception as error:
            raise self._wrap_provider_error("讲解生成", error) from error

        narration = result.output
        allowed_grounding = set(_build_grounding_ids(tool_results))
        narration.grounding = [
            feature_id for feature_id in narration.grounding if feature_id in allowed_grounding
        ]
        if not narration.language:
            narration.language = "zh-CN"
        return narration.model_dump()

    def _wrap_provider_error(
        self,
        operation: str,
        error: Exception,
    ) -> RuntimeError:
        message = str(error)
        if "api key" in message.lower() or "authentication" in message.lower():
            return ProviderConfigurationError(
                f"{operation}失败：当前 provider 凭据不可用或未正确配置。"
            )
        return UpstreamProviderError(
            f"{operation}失败：{self._provider_id} provider 调用异常。"
        )
