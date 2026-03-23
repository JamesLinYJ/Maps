# Recommended Stack

## Goal

Capture the preferred reusable framework stack for this repository so we do not rebuild capabilities that already exist in mature tooling. These recommendations are aligned with the current product direction:

- voice input
- LLM understanding and agent-style task planning
- map tool calling
- grounded narration
- China-compliant public map deployment constraints

This document is intentionally opinionated. It is not a list of every possible framework. It is the current recommended path for turning the prototype into a real, usable system.

## Recommended core stack

### Python orchestration: PydanticAI

Use `PydanticAI` as the preferred backend agent framework for the Python orchestration layer.

Why it fits this repository:

- It matches the existing `FastAPI + Pydantic` backend direction.
- It provides structured output, typed tools, validation, retries, and dependency wiring without forcing a large new abstraction model onto the codebase.
- It is a strong fit for replacing the current rule-based logic in `apps/backend/app/ai_layer.py` while keeping the HTTP contract stable.
- It helps keep tool outputs typed before they are allowed to drive map actions.

Recommended usage here:

- Define one typed agent for transcript cleanup, intent classification, tool planning, and narration generation.
- Keep map tools as explicit backend functions rather than hiding geography inside prompts.
- Preserve `apps/backend/app/service.py` as the orchestration entrypoint and swap the internal planning layer first.

### Multi-model access: LiteLLM

Use `LiteLLM` to unify access to `OpenAI-compatible`, `Anthropic`, and `Gemini` models.

Why it fits this repository:

- The product explicitly wants multi-provider experimentation without scattering provider-specific conditionals through the codebase.
- LiteLLM reduces per-provider request/response plumbing and makes failover and gateway-style deployment easier later.
- It lets the `openai` runtime option continue to mean `OpenAI-compatible`, which fits the current repo vocabulary and env naming.

Recommended usage here:

- Put LiteLLM behind the Python AI layer, not directly in the frontend.
- Keep provider credentials in environment variables and keep the runtime inspection output explicit about which provider is active.
- Treat LiteLLM as transport unification, not as the source of truth for tool schemas or compliance rules.

### Realtime voice pipeline: LiveKit Agents

Use `LiveKit Agents` when the project moves from push-to-talk demo behavior toward a production-grade realtime voice session.

Why it fits this repository:

- The product requires ASR -> LLM -> tool call -> narration -> TTS coordination.
- It supports interruption, streaming, and realtime audio session management better than stitching browser-native audio features together ad hoc.
- It is a better long-term fit than continuing to depend only on browser-native ASR and TTS for serious voice interaction.

Recommended usage here:

- Keep the current browser-native path as a temporary development fallback.
- Introduce LiveKit when we begin implementing true continuous session behavior, barge-in, and transport-level session management.
- Keep the `voice_layer` abstraction so the frontend and backend do not become tightly coupled to one vendor transport.

### Frontend AI interaction: Vercel AI SDK

Use `Vercel AI SDK` selectively for frontend streaming and agent-event UI, not as a replacement for the Python backend.

Why it fits this repository:

- It can improve streaming narration display, tool-event rendering, and conversational UI patterns.
- The current frontend is already React-based, so the integration path is straightforward if we want richer incremental UI updates.
- It should complement the backend, not replace the backend orchestration and compliance gates.

Recommended usage here:

- Use it only for client UX improvements such as streaming assistant output and richer event rendering.
- Keep tool execution, compliance logic, and provider assembly in the backend.
- Avoid moving core product logic into browser-only AI flows.

### Tool protocol: Model Context Protocol

Adopt `MCP` conventions for tool boundaries as the tool layer becomes more complex.

Why it fits this repository:

- The roadmap already includes map search, POI lookup, route summary, area lookup, and NL2SQL.
- MCP gives us a stable way to expose tool capabilities without hardwiring the system to a single LLM vendor SDK.
- It supports the long-term goal of provider independence.

Recommended usage here:

- Keep internal tool contracts typed in repository schemas.
- Design the tool layer so it can later be exposed through MCP-compatible boundaries.
- Do not let MCP replace normal internal function calls where local in-process tools are simpler today.

### Map rendering and public deployment path

Use `MapLibre GL JS` for rendering and keep China-facing public map data on `Tianditu` or another approved domestic provider path.

Why it fits this repository:

- The project is presentation-first, so map rendering flexibility matters.
- MapLibre is a strong rendering layer, but it should not be confused with a compliant public data source.
- The repo already enforces the correct idea: rendering and compliance are separate from LLM behavior.

Recommended usage here:

- Continue to treat `osm` as experimental only.
- Build real `Tianditu` and domestic-provider adapters behind the map service layer.
- Keep attribution, review number display, and provider gating owned by the compliance layer.

## Recommended stack by layer

| Layer | Recommended choice | Notes |
| --- | --- | --- |
| Frontend presentation | React + TypeScript + Vite | Already in place and sufficient for the current stage. |
| Frontend AI UX | Vercel AI SDK | Optional enhancement for streaming and agent-event UI. |
| Backend API | FastAPI + Pydantic | Already in place and should remain the core HTTP layer. |
| Agent orchestration | PydanticAI | Preferred replacement for the current rule-driven AI layer. |
| Multi-model connectivity | LiteLLM | Preferred unification path for OpenAI-compatible, Anthropic, and Gemini. |
| Voice session transport | LiveKit Agents | Preferred when moving beyond browser-native demo voice. |
| Map renderer | MapLibre GL JS | Rendering only, not a compliance shortcut. |
| China public map services | Tianditu or approved domestic provider | Required for public-facing deployment. |
| Tool protocol evolution | MCP-style boundaries | Use as the tool surface expands. |
| Observability | Existing safe trace model plus Langfuse or equivalent later | Add only when the real provider path is active. |

## What not to overbuild right now

- Do not build a custom agent framework if PydanticAI already covers the orchestration needs.
- Do not hand-maintain three separate provider clients if LiteLLM can unify most of the transport layer.
- Do not build a custom realtime voice transport before validating whether LiveKit already fits the target interaction model.
- Do not use OSM or other foreign public tiles as the default China-facing public path.
- Do not let LLM output directly define geographic truth, boundaries, or compliance decisions.

## Recommended migration order for this repo

1. Replace the placeholder logic in `apps/backend/app/ai_layer.py` with a real typed agent path using `PydanticAI`.
2. Put `LiteLLM` behind the Python AI layer so `OpenAI-compatible`, `Anthropic`, and `Gemini` can be exercised through one backend abstraction.
3. Keep the existing frontend API contract stable while backend internals are swapped from placeholder logic to real providers.
4. Replace placeholder map adapters with real domestic-provider integrations for public mode.
5. Introduce `LiveKit Agents` when the product moves from push-to-talk prototype behavior to realtime conversational voice sessions.
6. Evolve the tool surface toward `MCP`-compatible boundaries as NL2SQL and external data sources mature.

## Current repository alignment

Today the repository is only partially aligned with this stack:

- `FastAPI`, `Pydantic`, and the React frontend are already present.
- Multi-provider runtime selection already exists at the configuration level.
- `apps/backend/app/ai_layer.py` is still placeholder logic and should be treated as transitional.
- Browser-native ASR and TTS are still a development fallback, not the target long-term voice architecture.
- `osm` is correctly treated as experimental, but real domestic-provider adapters still need to be implemented.

## Implementation note

Adding every recommended dependency immediately would create churn without improving product reliability. The intended use of this document is:

- select the preferred stack now
- wire the components incrementally
- preserve contracts and compliance rules while swapping internals

That means the repository should adopt these tools in phases rather than install everything at once.
