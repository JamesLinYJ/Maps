from __future__ import annotations

import json
import os
from dataclasses import dataclass

from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.litellm import LiteLLMProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.settings import ModelSettings
from .nl2sql import Nl2SqlPlan, Nl2SqlPlanner
from .schemas import (
    Clarification,
    ClarificationOption,
    IntentClassification,
    IntentKind,
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
2. 根据用户请求决定是否拆成多步执行；能 1 步完成就不要拆多步。
3. steps 必须按执行顺序返回，最多 4 步，至少 1 步。
4. 每一步输出一个 intent，并自行判断是否需要 toolCalls。
5. toolCalls 仅可使用 poiSearch、areaLookup、routeSummary；如果只是镜头、图层、俯仰、旋转、清理类动作，通常不需要工具。
6. 涉及地点事实、区域边界、路线、沿线地标时，优先调用工具，不要靠想象补地理信息。
7. 如果用户是在当前高亮对象基础上追问“详细一点”“这里”“这个园区”，可以使用 detail_follow_up，也可以结合上下文决定 focus_area。
8. confidence 返回 0 到 1 之间的数值。

可选 intent 包括：
- focus_area
- route_overview
- layer_switch
- zoom_in
- zoom_out
- reset_view
- tilt_view
- rotate_view
- clear_overlays
- detail_follow_up
- multi_point_story

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
class PlannedTurnStep:
    id: str
    classification: IntentClassification
    tool_calls: list[dict[str, object]]


@dataclass
class AgentPlanningResult:
    classification: IntentClassification
    steps: list[PlannedTurnStep]
    nl2sql_plan: Nl2SqlPlan | None


@dataclass(frozen=True)
class ProviderRuntime:
    provider_id: str
    model_name: str
    transport_mode: str


class IntentExecutionPlan(BaseModel):
    steps: list["TurnStepPlan"] = Field(min_length=1, max_length=4)


class PlannedToolCall(BaseModel):
    tool_name: str = Field(alias="toolName")
    arguments: dict[str, object] = Field(default_factory=dict)


class TurnStepPlan(BaseModel):
    classification: IntentClassification
    tool_calls: list[PlannedToolCall] = Field(default_factory=list, alias="toolCalls")


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


def _is_dashscope_qwen_compatible(model_name: str, base_url: str | None) -> bool:
    normalized_model = model_name.strip().lower()
    normalized_base_url = (base_url or "").strip().lower()
    return normalized_model.startswith("qwen") and "dashscope.aliyuncs.com" in normalized_base_url


def _build_openai_model_settings(model_name: str, base_url: str | None) -> ModelSettings | None:
    if _is_dashscope_qwen_compatible(model_name, base_url):
        # 千问官方文档建议显式传 enable_thinking，避免默认思考模式与结构化输出冲突。
        return ModelSettings(extra_body={"enable_thinking": False})
    return None


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
        self._model = self._create_model()
        self._intent_agent = Agent(
            model=self._model,
            output_type=IntentExecutionPlan,
            instructions=INTENT_AGENT_INSTRUCTIONS,
            retries=2,
        )
        self._narration_agent = Agent(
            model=self._model,
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
            return OpenAIChatModel(
                self._runtime.model_name,
                provider=provider,
                settings=_build_openai_model_settings(self._runtime.model_name, base_url),
            )

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
        active_layer: str,
    ) -> AgentPlanningResult:
        planned_steps = self.plan_steps(
            transcript_text, highlighted_feature_ids, active_layer
        )
        classification = self._pick_primary_classification(
            [step.classification for step in planned_steps]
        )
        return AgentPlanningResult(
            classification=classification,
            steps=planned_steps,
            nl2sql_plan=self._nl2sql.maybe_plan(transcript_text, classification),
        )

    def plan_steps(
        self,
        text: str,
        highlighted_feature_ids: list[str],
        active_layer: str,
    ) -> list[PlannedTurnStep]:
        # 任务拆解交给真实模型完成，但后续地图动作与地图事实仍会走代码侧受控链路，
        # 避免让模型直接决定路线、边界或高亮结果。
        prompt = (
            "请分析下面这条地图讲解请求，并输出结构化步骤计划。\n\n"
            f"用户请求:\n{text}\n\n"
            f"当前高亮对象 IDs:\n{json.dumps(highlighted_feature_ids, ensure_ascii=False)}\n"
            f"当前图层:\n{active_layer}\n"
        )

        try:
            result = self._intent_agent.run_sync(prompt)
        except Exception as error:
            raise self._wrap_provider_error("意图识别与步骤拆解", error) from error

        raw_steps = result.output.steps
        return [
            PlannedTurnStep(
                id=f"step-{index + 1}",
                classification=self._normalize_classification(
                    planned_step.classification,
                    text,
                    highlighted_feature_ids,
                    allow_layer_inference=(
                        len(raw_steps) == 1
                        or planned_step.classification.intent == IntentKind.LAYER_SWITCH
                    ),
                ),
                tool_calls=self._normalize_tool_calls(planned_step.tool_calls),
            )
            for index, planned_step in enumerate(raw_steps)
        ]

    def _normalize_tool_calls(
        self,
        tool_calls: list[PlannedToolCall],
    ) -> list[dict[str, object]]:
        normalized: list[dict[str, object]] = []
        required_arguments = {
            "poiSearch": {"query"},
            "areaLookup": {"featureId"},
            "routeSummary": {"from", "to"},
        }
        for tool_call in tool_calls:
            if tool_call.tool_name not in {"poiSearch", "areaLookup", "routeSummary"}:
                continue
            arguments = {
                key: value
                for key, value in tool_call.arguments.items()
                if isinstance(key, str)
            }
            if not required_arguments[tool_call.tool_name].issubset(arguments.keys()):
                continue
            normalized.append(
                {
                    "toolName": tool_call.tool_name,
                    "arguments": arguments,
                }
            )
        return normalized

    def _normalize_classification(
        self,
        classification: IntentClassification,
        text: str,
        highlighted_feature_ids: list[str],
        allow_layer_inference: bool,
    ) -> IntentClassification:
        # “这里/这个园区” 这种指代如果模型没补全，就安全地回落到当前高亮对象。
        if (
            highlighted_feature_ids
            and classification.intent in (IntentKind.FOCUS_AREA, IntentKind.DETAIL_FOLLOW_UP)
            and not classification.focus_query
            and ("这个园区" in text or "这里" in text)
        ):
            classification.focus_query = highlighted_feature_ids[0]

        if allow_layer_inference and "卫星" in text and classification.requested_layer is None:
            classification.requested_layer = Layer.SATELLITE
        if (
            allow_layer_inference
            and ("矢量" in text or "普通" in text)
            and classification.requested_layer is None
        ):
            classification.requested_layer = Layer.VECTOR

        return classification

    def _pick_primary_classification(
        self,
        classifications: list[IntentClassification],
    ) -> IntentClassification:
        priority = {
            "route_overview": 5,
            "multi_point_story": 4,
            "detail_follow_up": 3,
            "focus_area": 2,
            "layer_switch": 1,
            "zoom_in": 1,
            "zoom_out": 1,
            "reset_view": 1,
            "tilt_view": 1,
            "rotate_view": 1,
            "clear_overlays": 1,
        }
        return max(
            classifications,
            key=lambda item: (
                priority.get(item.intent.value, 0),
                item.confidence,
            ),
        )

    def plan_tool_calls(
        self,
        classification: IntentClassification,
        highlighted_feature_ids: list[str],
    ) -> list[dict[str, object]]:
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
        if classification.intent == "multi_point_story":
            return [
                {"toolName": "poiSearch", "arguments": {"query": query}}
                for query in (classification.point_queries or [])
            ]
        if classification.intent == "detail_follow_up":
            if highlighted_feature_ids:
                return [
                    {
                        "toolName": "areaLookup",
                        "arguments": {"featureId": highlighted_feature_ids[0]},
                    }
                ]
            if classification.focus_query:
                return [
                    {
                        "toolName": "areaLookup",
                        "arguments": {"featureId": classification.focus_query},
                    }
                ]
            return []
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
                    f'当前没有找到“{empty_poi["query"]}”的可用地点结果，'
                    "你可以换一个更具体的地点名称，或者补充城市、区域、园区等限定信息。"
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
                    "reason": "放大当前展示区域",
                }
            )
            return MapActionPlan(
                summary="已放大当前地图视图。",
                actions=actions,
                sourceCards=source_cards,
            ).model_dump(by_alias=True, exclude_none=True)

        if classification.intent == "zoom_out":
            actions.append(
                {
                    "type": "adjust_zoom",
                    "factor": 0.72,
                    "reason": "缩小当前展示区域，扩大观察范围",
                }
            )
            return MapActionPlan(
                summary="已拉远当前地图视图。",
                actions=actions,
                sourceCards=source_cards,
            ).model_dump(by_alias=True, exclude_none=True)

        if classification.intent == "reset_view":
            actions.append(
                {
                    "type": "set_camera",
                    "pitch": 0,
                    "rotation": 0,
                    "reason": "恢复标准视角并回正地图朝向",
                }
            )
            return MapActionPlan(
                summary="已恢复到标准地图视角。",
                actions=actions,
                sourceCards=source_cards,
            ).model_dump(by_alias=True, exclude_none=True)

        if classification.intent == "tilt_view":
            actions.append(
                {
                    "type": "set_camera",
                    "pitch": 50,
                    "rotation": 0,
                    "reason": "切换到更有空间感的 3D 俯视视角",
                }
            )
            return MapActionPlan(
                summary="已切换到 3D 俯视视角。",
                actions=actions,
                sourceCards=source_cards,
            ).model_dump(by_alias=True, exclude_none=True)

        if classification.intent == "rotate_view":
            actions.append(
                {
                    "type": "set_camera",
                    "rotation": 90,
                    "reason": "旋转地图视角以观察不同朝向",
                }
            )
            return MapActionPlan(
                summary="已旋转地图视角。",
                actions=actions,
                sourceCards=source_cards,
            ).model_dump(by_alias=True, exclude_none=True)

        if classification.intent == "clear_overlays":
            actions.extend(
                [
                    {"type": "clear_route"},
                    {"type": "clear_highlights"},
                    {"type": "clear_callouts"},
                ]
            )
            return MapActionPlan(
                summary="已清除当前路线、高亮和讲解标注。",
                actions=actions,
                sourceCards=source_cards,
            ).model_dump(by_alias=True, exclude_none=True)

        if classification.intent == IntentKind.LAYER_SWITCH:
            summary = (
                f"已切换到{'卫星' if classification.requested_layer == Layer.SATELLITE else '标准'}图层。"
                if classification.requested_layer
                else "已调整地图图层。"
            )
            return MapActionPlan(
                summary=summary,
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
            "已生成路线展示视图。"
            if classification.intent == "route_overview"
            else "已生成多点顺序展示视图。"
            if classification.intent == "multi_point_story"
            else "已生成地图聚焦展示视图。"
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
