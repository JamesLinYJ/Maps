from __future__ import annotations

from .schemas import IntentClassification, ProviderBindingSummary


class VoiceCapabilityRegistry:
    def describe_bindings(self) -> list[ProviderBindingSummary]:
        return [
            ProviderBindingSummary(
                kind="asr",
                providerId="browser_speech_api",
                adapterMode="browser_native",
                credentialEnvVar=None,
                message="当前语音识别链路按浏览器原生 ASR 能力接入，后续可切换到云端或本地 ASR provider。",
            ),
            ProviderBindingSummary(
                kind="tts",
                providerId="browser_speech_synthesis",
                adapterMode="browser_native",
                credentialEnvVar=None,
                message="当前语音播报链路按浏览器原生 TTS 能力接入，后续可替换为 AI TTS provider。",
            ),
        ]

    def build_trace_prefix(self, session_id: str) -> list[dict[str, object]]:
        # 前缀只记录稳定的会话起点，方便前端和日志对齐一次语音轮次。
        return [
            {"event": "voice_session_started", "sessionId": session_id},
            {
                "event": "asr_transcript_received",
                "sessionId": session_id,
                "metadata": {"language": "zh-CN"},
            },
        ]

    def build_trace_suffix(
        self,
        session_id: str,
        classification: IntentClassification,
        tool_count: int,
        action_count: int,
        used_nl2sql: bool,
    ) -> list[dict[str, object]]:
        trace = [
            {
                "event": "intent_classified",
                "sessionId": session_id,
                "metadata": {"intent": classification.intent},
            },
            {
                "event": "tool_calls_completed",
                "sessionId": session_id,
                "metadata": {"toolCount": tool_count},
            },
        ]
        if used_nl2sql:
            # 只有当本轮真的生成了结构化查询计划时，才把 NL2SQL 事件写进 trace。
            trace.append(
                {
                    "event": "nl2sql_plan_generated",
                    "sessionId": session_id,
                    "metadata": {"mode": "structured_lookup"},
                }
            )
        trace.extend(
            [
                {
                    "event": "map_action_plan_generated",
                    "sessionId": session_id,
                    "metadata": {"actionCount": action_count},
                },
                {"event": "narration_generated", "sessionId": session_id},
            ]
        )
        return trace
