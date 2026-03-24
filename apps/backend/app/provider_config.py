from __future__ import annotations

import os

from .amap_mcp import inspect_map_tool_runtime
from .compliance import list_map_providers
from .schemas import ProviderBindingSummary, RuntimeConfig, StackComponentSummary


MAP_CREDENTIAL_ENV = {
    "tianditu": "TIANDITU_API_KEY",
    "amap": "AMAP_API_KEY",
    "mapbox": "MAPBOX_ACCESS_TOKEN",
    "osm": None,
}

LLM_CREDENTIAL_ENV = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
}

LLM_BASE_URL_ENV = {
    "openai": "OPENAI_COMPAT_BASE_URL",
    "anthropic": None,
    "gemini": None,
}

LLM_MODEL_ENV = {
    "openai": "OPENAI_MODEL",
    "anthropic": "ANTHROPIC_MODEL",
    "gemini": "GEMINI_MODEL",
}

DEFAULT_LLM_MODEL = {
    "openai": "gpt-5-mini",
    "anthropic": "claude-sonnet-4-20250514",
    "gemini": "gemini-2.5-flash",
}


def _env_value(env: dict[str, str] | None, *keys: str) -> str | None:
    source = env or os.environ
    for key in keys:
        value = source.get(key)
        if value:
            return value
    return None


def _parse_bool(value: str | None, fallback: bool = False) -> bool:
    if value is None:
        return fallback
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return fallback


def resolve_runtime_defaults(env: dict[str, str] | None = None) -> RuntimeConfig:
    return RuntimeConfig(
        mapMode=_env_value(env, "MAP_MODE", "VITE_MAP_MODE") or "internal",
        mapProvider=_env_value(env, "MAP_PROVIDER", "VITE_MAP_PROVIDER") or "amap",
        llmProvider=_env_value(env, "LLM_PROVIDER", "VITE_LLM_PROVIDER") or "openai",
        enableForeignMapExperiments=_parse_bool(
            _env_value(
                env,
                "ENABLE_FOREIGN_MAP_EXPERIMENTS",
                "VITE_ENABLE_FOREIGN_MAP_EXPERIMENTS",
            ),
            False,
        ),
    )


def describe_runtime_assembly(
    runtime: RuntimeConfig, env: dict[str, str] | None = None
) -> dict[str, object]:
    source = env or os.environ
    strict = _parse_bool(
        _env_value(source, "STRICT_PROVIDER_CONFIG", "VITE_STRICT_PROVIDER_CONFIG"),
        False,
    )

    llm_key = LLM_CREDENTIAL_ENV[runtime.llm_provider.value]
    llm_base_url_key = LLM_BASE_URL_ENV[runtime.llm_provider.value]
    llm_model_key = LLM_MODEL_ENV[runtime.llm_provider.value]
    map_key = MAP_CREDENTIAL_ENV[runtime.map_provider.value]
    llm_model = source.get(llm_model_key) or DEFAULT_LLM_MODEL[runtime.llm_provider.value]
    llm_ready = bool(source.get(llm_key))
    map_ready = True if map_key is None else bool(source.get(map_key))
    litellm_base_url = source.get("LITELLM_BASE_URL")
    litellm_api_key = source.get("LITELLM_API_KEY")
    tool_runtime = inspect_map_tool_runtime(source)

    # 这里把“直连 provider”和“统一走 LiteLLM 网关”都视为真实可调用路径。
    effective_llm_ready = llm_ready or bool(litellm_base_url)

    if strict and not effective_llm_ready:
        raise ValueError(
            f'Strict provider config requires {llm_key} for LLM provider "{runtime.llm_provider.value}".'
        )
    if strict and not map_ready:
        raise ValueError(
            f'Strict provider config requires {map_key} for map provider "{runtime.map_provider.value}".'
        )

    bindings = [
        ProviderBindingSummary(
            kind="llm",
            providerId=runtime.llm_provider.value,
            adapterMode=(
                "pydanticai_litellm_gateway"
                if litellm_base_url
                else "pydanticai_openai_compatible"
                if runtime.llm_provider.value == "openai" and source.get(llm_base_url_key or "")
                else "pydanticai_direct"
                if effective_llm_ready
                else "requires_configuration"
            ),
            credentialEnvVar=llm_key,
            message=(
                (
                    f'LITELLM_BASE_URL 已配置，当前通过 PydanticAI + LiteLLM 网关调用 {runtime.llm_provider.value}，模型为 {llm_model}。'
                    if litellm_base_url
                    else f"{llm_key} 已提供。当前通过 PydanticAI 直接调用 OpenAI-compatible 路线，模型为 {llm_model}。"
                    if runtime.llm_provider.value == "openai"
                    else f"{llm_key} 已提供。当前通过 PydanticAI 直接调用 {runtime.llm_provider.value}，模型为 {llm_model}。"
                )
                if effective_llm_ready
                else (
                    f"{llm_key} 未提供，OpenAI-compatible LLM 路线当前无法发起真实调用。默认模型为 {llm_model}。"
                    if runtime.llm_provider.value == "openai"
                    else f"{llm_key} 未提供，当前无法调用 {runtime.llm_provider.value} provider。默认模型为 {llm_model}。"
                )
            ),
        ),
        ProviderBindingSummary(
            kind="map",
            providerId=runtime.map_provider.value,
            adapterMode=(
                tool_runtime["adapterMode"]
                if tool_runtime["backend"] == "amap_mcp"
                else "public_access"
                if runtime.map_provider.value == "osm"
                else "credential_ready_placeholder"
                if map_ready
                else "requires_configuration"
            ),
            credentialEnvVar=map_key,
            message=(
                f'{tool_runtime["message"]} 当前展示底图 provider 为 {runtime.map_provider.value}。'
                if tool_runtime["backend"] == "amap_mcp"
                else "OpenStreetMap 当前按公开访问方式接入，仅在 internal 或 experimental 模式下作为实验参考底图开放。"
                if runtime.map_provider.value == "osm"
                else f"{map_key} 已提供，地图服务可按当前 provider 抽象接入。"
                if map_ready
                else f"{map_key} 未提供，当前 map provider 需要补充真实服务配置。"
            ),
        ),
    ]
    bindings.extend(
        [
            ProviderBindingSummary(
                kind="asr",
                providerId="browser_speech_api",
                adapterMode="browser_native",
                credentialEnvVar=None,
                message="当前原型使用浏览器原生 ASR，后续可切换到云端或本地语音识别服务。",
            ),
            ProviderBindingSummary(
                kind="tts",
                providerId="browser_speech_synthesis",
                adapterMode="browser_native",
                credentialEnvVar=None,
                message="当前语音播报使用浏览器原生 TTS 能力。",
            ),
            ProviderBindingSummary(
                kind="nl2sql",
                providerId="llm_sql_planner",
                adapterMode="agent_planned",
                credentialEnvVar=None,
                message="当前请求链路已纳入 NL2SQL 规划能力，用于结构化查询衔接。",
            ),
        ]
    )

    warnings: list[str] = []
    # runtime inspection 要把“能否真实调用”说清楚，而不是继续沿用 placeholder 语义。
    if not effective_llm_ready:
        warnings.append(f"{llm_key} 未配置，LLM provider 当前不可用。")
    if litellm_base_url and not litellm_api_key:
        warnings.append("LITELLM_BASE_URL 已配置但 LITELLM_API_KEY 未提供，将按网关是否允许匿名访问决定是否可用。")
    if runtime.llm_provider.value == "openai" and llm_base_url_key and source.get(
        llm_base_url_key
    ):
        warnings.append(
            f"{llm_base_url_key} 已配置，openai provider 当前按 OpenAI-compatible endpoint 语义解释。"
        )
    if not map_ready and map_key is not None:
        warnings.append(f"{map_key} 未配置，当前 map provider 不可用。")
    warnings.extend(str(item) for item in tool_runtime["warnings"])

    provider_option = next(
        (item for item in list_map_providers(runtime) if item["id"] == runtime.map_provider.value),
        None,
    )
    if provider_option and not provider_option["enabled"]:
        warnings.append(str(provider_option["reason"]))

    stack = [
        StackComponentSummary(
            category="frontend",
            stack="React + TypeScript + Vite",
            detail="负责语音/文本输入、地图展示、讲解结果与来源信息呈现。",
        ),
        StackComponentSummary(
            category="backend",
            stack="Python + FastAPI + PydanticAI",
            detail="负责请求接收、运行时配置、智能体编排、结构化输出校验与安全失败处理。",
        ),
        StackComponentSummary(
            category="llm",
            stack="Gemini / OpenAI-compatible / Anthropic / LiteLLM gateway",
            detail=f'当前运行时优先使用 {runtime.llm_provider.value} provider，模型为 {llm_model}，并保留 LiteLLM 统一接入路径。',
        ),
        StackComponentSummary(
            category="voice",
            stack="ASR + LLM + TTS",
            detail="按语音识别、意图理解、讲解生成、语音播报链路组织语音交互。",
        ),
        StackComponentSummary(
            category="maps",
            stack="AMap MCP / OpenStreetMap / domestic-compliant providers",
            detail=f'当前地图工具层为 {tool_runtime["backend"]}，展示底图 provider 为 {runtime.map_provider.value}，公开模式仍保留国内合规约束。',
        ),
        StackComponentSummary(
            category="data",
            stack="NL2SQL planning",
            detail="已纳入智能体路线，用于后续自然语言到结构化查询的衔接。",
        ),
    ]

    return {
        "runtime": runtime,
        "strictProviderConfig": strict,
        "bindings": bindings,
        "warnings": warnings,
        "architectureSummary": "当前原型采用前端展示 + Python 后端编排 + PydanticAI 智能体层 + 多模型 provider 接入层 + 高德 MCP 工具层 + 语音交互层的技术架构，并保留 OpenAI-compatible 与 LiteLLM 网关路径。",
        "stack": stack,
    }
