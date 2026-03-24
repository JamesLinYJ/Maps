from __future__ import annotations

import os
from dataclasses import dataclass

from .ai_layer import LlmAgent
from .compliance import resolve_map_policy
from .map_service import MapService
from .provider_config import describe_runtime_assembly, resolve_runtime_defaults
from .schemas import (
    AssistantTurnResult,
    AssistantTurnStep,
    HandleTurnResponse,
    RuntimeConfig,
)
from .voice_layer import VoiceCapabilityRegistry


@dataclass
class PendingClarification:
    rewrite_prompt: callable


class AssistantService:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self._env = dict(os.environ if env is None else env)
        self.default_runtime = resolve_runtime_defaults(self._env)
        self._pending: dict[str, PendingClarification] = {}
        self._maps = MapService(env=self._env)
        self._voice = VoiceCapabilityRegistry()

    def inspect_runtime(self, runtime: RuntimeConfig) -> dict[str, object]:
        return describe_runtime_assembly(runtime, self._env)

    def _create_agent(self, runtime: RuntimeConfig) -> LlmAgent:
        return LlmAgent(runtime.llm_provider.value, env=self._env)

    def _merge_source_cards(self, step_results: list[AssistantTurnStep]) -> list[dict[str, object]]:
        cards_by_id: dict[str, dict[str, object]] = {}
        for step in step_results:
            for card in step.map_action_plan.source_cards:
                cards_by_id[card.id] = card.model_dump(by_alias=True)
        return list(cards_by_id.values())

    def _merge_map_action_plan(
        self,
        step_results: list[AssistantTurnStep],
        clarification: bool,
    ) -> dict[str, object]:
        if not step_results:
            return {"summary": "等待执行地图步骤。", "actions": [], "sourceCards": []}

        actions = [
            action.model_dump(by_alias=True, exclude_none=True)
            for step in step_results
            for action in step.map_action_plan.actions
        ]
        source_cards = self._merge_source_cards(step_results)
        if clarification:
            summary = (
                "等待补充信息。"
                if len(step_results) == 1
                else f"已完成 {len(step_results) - 1} 个步骤，当前等待补充信息。"
            )
        elif len(step_results) == 1:
            summary = step_results[0].map_action_plan.summary
        else:
            summary = f"已按顺序执行 {len(step_results)} 个地图步骤。"
        return {"summary": summary, "actions": actions, "sourceCards": source_cards}

    def _next_active_layer(
        self,
        active_layer: str,
        map_action_plan: dict[str, object],
    ) -> str:
        next_layer = active_layer
        for action in map_action_plan.get("actions", []):
            if action.get("type") == "set_layer" and action.get("layer"):
                next_layer = str(action["layer"])
        return next_layer

    def _next_highlighted_feature_ids(
        self,
        current_ids: list[str],
        map_action_plan: dict[str, object],
    ) -> list[str]:
        for action in reversed(map_action_plan.get("actions", [])):
            if action.get("type") == "highlight_features":
                return list(action.get("featureIds", []))
        return current_ids

    def _resolve_step_tool_calls(
        self,
        agent: LlmAgent,
        planned_step,
        current_highlighted_feature_ids: list[str],
    ) -> list[dict[str, object]]:
        if planned_step.tool_calls:
            return planned_step.tool_calls
        return agent.plan_tool_calls(
            planned_step.classification,
            current_highlighted_feature_ids,
        )

    def handle_turn(
        self,
        runtime: RuntimeConfig,
        session_id: str,
        transcript_text: str,
        map_context: dict[str, object],
    ) -> HandleTurnResponse:
        assembly = self.inspect_runtime(runtime)
        # 澄清态改写只保留在服务层，避免前端需要理解“上一轮未完成的路线/点位槽位”。
        effective_text = (
            self._pending[session_id].rewrite_prompt(transcript_text)
            if session_id in self._pending
            else transcript_text
        )
        highlighted_feature_ids = list(map_context.get("highlightedFeatureIds", []))
        active_layer = str(map_context.get("activeLayer", "vector"))
        agent = self._create_agent(runtime)

        planning = agent.plan_turn(
            effective_text,
            highlighted_feature_ids,
            active_layer,
        )
        policy = resolve_map_policy(runtime)
        current_highlighted_feature_ids = list(highlighted_feature_ids)
        current_active_layer = active_layer
        step_results: list[AssistantTurnStep] = []
        clarification = None
        clarification_tool_calls: list[dict[str, object]] = []
        clarification_tool_results: list[dict[str, object]] = []
        clarification_classification = planning.classification

        for planned_step in planning.steps:
            step_tool_calls = self._resolve_step_tool_calls(
                agent,
                planned_step,
                current_highlighted_feature_ids,
            )
            step_tool_results = [
                self._maps.run_tool_call(tool_call, runtime)
                for tool_call in step_tool_calls
            ]
            step_clarification = agent.build_clarification(
                planned_step.classification,
                step_tool_calls,
                step_tool_results,
            )

            if step_clarification:
                clarification = step_clarification
                clarification_tool_calls = step_tool_calls
                clarification_tool_results = step_tool_results
                clarification_classification = planned_step.classification
                step_map_action_plan = {
                    "summary": "等待补充信息。",
                    "actions": (
                        [
                            {
                                "type": "set_layer",
                                "layer": planned_step.classification.requested_layer.value,
                            }
                        ]
                        if planned_step.classification.requested_layer
                        and planned_step.classification.requested_layer.value
                        != current_active_layer
                        else [{"type": "clear_route"}]
                    ),
                    "sourceCards": [
                        card
                        for result in step_tool_results
                        for card in result.get("sourceCards", [])
                    ],
                }
                step_results.append(
                    AssistantTurnStep(
                        id=planned_step.id,
                        classification=planned_step.classification,
                        toolCalls=step_tool_calls,
                        toolResults=step_tool_results,
                        mapActionPlan=step_map_action_plan,
                    )
                )
                break

            step_map_action_plan = agent.build_map_action_plan(
                planned_step.classification,
                step_tool_results,
                current_active_layer,
            )
            step_results.append(
                AssistantTurnStep(
                    id=planned_step.id,
                    classification=planned_step.classification,
                    toolCalls=step_tool_calls,
                    toolResults=step_tool_results,
                    mapActionPlan=step_map_action_plan,
                )
            )
            current_active_layer = self._next_active_layer(
                current_active_layer,
                step_map_action_plan,
            )
            current_highlighted_feature_ids = self._next_highlighted_feature_ids(
                current_highlighted_feature_ids,
                step_map_action_plan,
            )

        if clarification:
            map_action_plan = self._merge_map_action_plan(step_results, clarification=True)
            narration = {
                "text": clarification.question,
                "language": "zh-CN",
                "grounding": [],
            }
        else:
            map_action_plan = self._merge_map_action_plan(step_results, clarification=False)
            narration = agent.generate_narration(
                planning.classification,
                [tool_result for step in step_results for tool_result in step.tool_results],
                map_action_plan=map_action_plan,
                transcript_text=effective_text,
            )

        if clarification:
            route_call = next(
                (
                    call
                    for call in clarification_tool_calls
                    if call["toolName"] == "routeSummary"
                ),
                None,
            )
            if route_call:
                ambiguity = next(
                    (
                        item["ambiguity"]
                        for item in clarification_tool_results
                        if item.get("tool") == "routeSummary"
                        and item.get("ambiguity")
                    ),
                    None,
                )
                if ambiguity and ambiguity["field"] == "from":
                    _to = route_call["arguments"]["to"]
                    self._pending[session_id] = PendingClarification(
                        lambda selection, _to=_to: (
                            f'展示从{selection}到{_to}的大致路线，并说明沿线重点地标'
                        )
                    )
                elif ambiguity:
                    _from = route_call["arguments"]["from"]
                    self._pending[session_id] = PendingClarification(
                        lambda selection, _from=_from: (
                            f'展示从{_from}到{selection}的大致路线，并说明沿线重点地标'
                        )
                    )
            else:
                self._pending[session_id] = PendingClarification(
                    lambda selection: f"带我看看{selection}的重点区域"
                )
        else:
            self._pending.pop(session_id, None)

        aggregated_tool_calls = [
            tool_call for step in step_results for tool_call in step.tool_calls
        ]
        aggregated_tool_results = [
            tool_result for step in step_results for tool_result in step.tool_results
        ]
        trace = self._voice.build_trace_prefix(session_id)
        trace.extend(
            self._voice.build_trace_suffix(
                session_id=session_id,
                classification=planning.classification,
                tool_count=len(aggregated_tool_calls),
                action_count=len(map_action_plan["actions"]),
                used_nl2sql=planning.nl2sql_plan is not None,
            )
        )

        result = AssistantTurnResult(
            responseMode="clarification" if clarification else "answer",
            policy=policy,
            classification=planning.classification,
            toolCalls=aggregated_tool_calls,
            toolResults=aggregated_tool_results,
            mapActionPlan=map_action_plan,
            steps=step_results,
            narration=narration,
            clarification=clarification,
        )
        return HandleTurnResponse(
            result=result,
            trace=trace,
            bindings=assembly["bindings"],
            warnings=assembly["warnings"],
            architectureSummary=assembly["architectureSummary"],
            stack=assembly["stack"],
        )
