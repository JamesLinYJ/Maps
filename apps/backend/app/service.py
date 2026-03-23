from __future__ import annotations

from dataclasses import dataclass

from .ai_layer import LlmAgent
from .compliance import resolve_map_policy
from .map_service import MapService
from .provider_config import describe_runtime_assembly, resolve_runtime_defaults
from .schemas import (
    AssistantTurnResult,
    HandleTurnResponse,
    RuntimeConfig,
)
from .voice_layer import VoiceCapabilityRegistry


@dataclass
class PendingClarification:
    rewrite_prompt: callable


class AssistantService:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self._env = dict(env or {})
        self.default_runtime = resolve_runtime_defaults(self._env)
        self._pending: dict[str, PendingClarification] = {}
        self._maps = MapService()
        self._voice = VoiceCapabilityRegistry()

    def inspect_runtime(self, runtime: RuntimeConfig) -> dict[str, object]:
        return describe_runtime_assembly(runtime, self._env)

    def _create_agent(self, runtime: RuntimeConfig) -> LlmAgent:
        return LlmAgent(runtime.llm_provider.value, env=self._env)

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

        planning = agent.plan_turn(effective_text, highlighted_feature_ids)
        tool_results = [
            self._maps.run_tool_call(tool_call) for tool_call in planning.tool_calls
        ]
        clarification = agent.build_clarification(
            planning.classification,
            planning.tool_calls,
            tool_results,
        )
        policy = resolve_map_policy(runtime)

        if clarification:
            map_action_plan = {
                "summary": "Waiting for clarification.",
                "actions": (
                    [
                        {
                            "type": "set_layer",
                            "layer": planning.classification.requested_layer.value,
                        }
                    ]
                    if planning.classification.requested_layer
                    and planning.classification.requested_layer.value != active_layer
                    else [{"type": "clear_route"}]
                ),
                "sourceCards": [
                    card
                    for result in tool_results
                    for card in result.get("sourceCards", [])
                ],
            }
            narration = {
                "text": clarification.question,
                "language": "zh-CN",
                "grounding": [],
            }
        else:
            # 地图动作仍保持后端确定性生成，避免模型直接输出未经验证的地理指令。
            map_action_plan = agent.build_map_action_plan(
                planning.classification,
                tool_results,
                active_layer,
            )
            narration = agent.generate_narration(
                planning.classification,
                tool_results,
                map_action_plan=map_action_plan,
                transcript_text=effective_text,
            )

        if clarification:
            route_call = next(
                (
                    call
                    for call in planning.tool_calls
                    if call["toolName"] == "routeSummary"
                ),
                None,
            )
            if route_call:
                ambiguity = next(
                    (
                        item["ambiguity"]
                        for item in tool_results
                        if item.get("tool") == "routeSummary"
                        and item.get("ambiguity")
                    ),
                    None,
                )
                if ambiguity and ambiguity["field"] == "from":
                    self._pending[session_id] = PendingClarification(
                        lambda selection: (
                            f'展示从{selection}到{route_call["arguments"]["to"]}的大致路线，并说明沿线重点地标'
                        )
                    )
                elif ambiguity:
                    self._pending[session_id] = PendingClarification(
                        lambda selection: (
                            f'展示从{route_call["arguments"]["from"]}到{selection}的大致路线，并说明沿线重点地标'
                        )
                    )
            else:
                self._pending[session_id] = PendingClarification(
                    lambda selection: f"带我看看{selection}的重点区域"
                )
        else:
            self._pending.pop(session_id, None)

        trace = self._voice.build_trace_prefix(session_id)
        trace.extend(
            self._voice.build_trace_suffix(
                session_id=session_id,
                classification=planning.classification,
                tool_count=len(planning.tool_calls),
                action_count=len(map_action_plan["actions"]),
                used_nl2sql=planning.nl2sql_plan is not None,
            )
        )

        result = AssistantTurnResult(
            responseMode="clarification" if clarification else "answer",
            policy=policy,
            classification=planning.classification,
            toolCalls=planning.tool_calls,
            toolResults=tool_results,
            mapActionPlan=map_action_plan,
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
