# MVP Implementation Plan

## Current direction update: recommended reusable framework stack

The repository should avoid rebuilding infrastructure that already exists in strong upstream tools. The preferred stack is documented in `docs/architecture/recommended-stack.md`.

Current preferred direction:

- `PydanticAI` for Python agent orchestration
- `LiteLLM` for multi-model backend access across `OpenAI-compatible`, `Anthropic`, and `Gemini`
- `LiveKit Agents` for future realtime voice sessions beyond browser-native demo behavior
- `Vercel AI SDK` only where it improves frontend streaming UX
- `MCP`-style tool boundaries as the tool surface expands
- `MapLibre GL JS` for rendering, paired with `Tianditu` or another approved domestic provider path for China-facing public deployment

This update changes the interpretation of placeholder layers in the current repo:

- `apps/backend/app/ai_layer.py` should be treated as transitional and scheduled for replacement by a real typed agent path
- `apps/backend/app/voice_layer.py` should remain a thin abstraction until a real realtime voice transport is integrated
- the compliance layer remains the source of truth for provider gating and legal display requirements

## Current extension: AI-agent route with Python orchestration, Gemini/OpenAI-compatible, ASR/TTS, and NL2SQL

### Task goal

Realign the prototype around the intended agent-style architecture: a Python backend that orchestrates AI capabilities, a presentation-first React frontend, and explicit runtime visibility for LLM, ASR, TTS, and NL2SQL paths. The goal is to keep the existing map presentation experience while making the stack reflect the intended technical route instead of a single monolithic service file.

### Files likely to change

- `docs/architecture/initial-bootstrap-plan.md`
- `apps/backend/app/schemas.py`
- `apps/backend/app/provider_config.py`
- `apps/backend/app/service.py`
- `apps/backend/app/main.py`
- `apps/backend/app/ai_layer.py`
- `apps/backend/app/map_service.py`
- `apps/backend/app/voice_layer.py`
- `apps/backend/app/nl2sql.py`
- `apps/backend/tests/test_backend.py`
- `packages/schemas/src/index.ts`
- `apps/web/src/api-client.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/app.test.tsx`

### Assumptions

- The current experience should remain usable while the backend is restructured.
- `Gemini`, `OpenAI-compatible`, and `Anthropic` should be exposed as provider options even if some still run through placeholder adapters until credentials are supplied.
- ASR and TTS should be modeled as explicit AI capabilities in the runtime inspection output, even when the current path uses browser-native adapters on the frontend.
- NL2SQL is a near-term capability for structured geographic/data queries, so it should be represented in the architecture and runtime before a production query engine is wired in.

### Risks

- A schema change on runtime inspection can break the frontend if the Python and TypeScript contracts drift.
- Adding Gemini and extra capability metadata can create inconsistent provider handling if defaults and UI controls are not updated together.
- Refactoring the monolithic backend service could accidentally change clarification or narration behavior if tests are not expanded first.

### Validation steps

- Run `python -m pytest apps/backend/tests`.
- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.
- Verify that `/api/runtime` exposes the AI architecture summary plus LLM/ASR/TTS/NL2SQL capability metadata.
- Verify that `Gemini` and the `OpenAI-compatible` route appear as LLM provider options and degrade safely without credentials.

## Current extension: redesigned presentation UI plus gated OSM integration

### Task goal

Redesign the presentation page so it feels like a polished presentation console instead of a placeholder dashboard, while integrating OpenStreetMap as an explicitly gated experimental provider. The OSM path must remain unavailable for `china_public` mode and must not weaken attribution, disclaimer, or provider-abstraction boundaries.

### Files likely to change

- `docs/architecture/initial-bootstrap-plan.md`
- `apps/web/src/App.tsx`
- `apps/web/src/app.test.tsx`
- `apps/web/src/styles.css`
- `packages/schemas/src/index.ts`
- `packages/compliance/src/index.ts`
- `apps/api/src/provider-config.ts`
- `apps/backend/app/schemas.py`
- `apps/backend/app/compliance.py`
- `apps/backend/app/provider_config.py`
- `.env.example`

### Assumptions

- The current stage still uses curated geometry and narration data, so OSM will be introduced as an experimental base-map surface rather than as the source of truth for tool outputs.
- The frontend can embed OSM tiles directly for visual presentation as long as attribution remains visible.
- China-facing public mode remains available for release hardening, but normal development flows may default to a non-`china_public` runtime.

### Risks

- OSM attribution could be lost during the redesign if the new layout buries or conditionally hides provider notices.
- Experimental OSM mode could be accidentally exposed in `china_public` mode if the schema, compliance logic, and UI controls drift out of sync.
- The current coordinates are synthetic, so the OSM surface must be visually framed as an experimental reference layer rather than a perfectly aligned production map.

### Validation steps

- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.
- Verify that `china_public` mode disables the OSM provider.
- Verify that experimental or internal mode can select OSM and still shows attribution plus a non-production disclaimer.

## Task goal

Create a runnable MVP for the China-compliant voice-driven map presentation assistant. The MVP should preserve provider abstraction, default to China-public compliant map behavior, support voice and text interactions, render a presentation-first map stage, and demonstrate the full flow from transcript to grounded narration. The current implementation may use a Python backend while keeping the frontend and browser contracts in TypeScript.

## Files likely to change

- `package.json`
- `tsconfig.json`
- `vite.config.ts`
- `vitest.config.ts`
- `docs/architecture/initial-bootstrap-plan.md`
- `docs/architecture/manual-qa-checklist.md`
- `apps/api/src/orchestrator.ts`
- `apps/api/src/service.ts`
- `apps/backend/app/main.py`
- `apps/backend/app/service.py`
- `apps/api/src/orchestrator.test.ts`
- `apps/web/index.html`
- `apps/web/src/App.tsx`
- `apps/web/src/app.test.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/test-setup.ts`
- `packages/schemas/src/index.ts`
- `packages/compliance/src/index.ts`
- `packages/llm-core/src/index.ts`
- `packages/map-core/src/index.ts`
- `packages/observability/src/index.ts`
- `packages/tools/src/index.ts`
- `packages/tools/src/scenario-data.ts`
- `packages/ui/src/index.tsx`
- `packages/voice-core/src/index.ts`

## Assumptions

- The repository is being bootstrapped from an empty starting point.
- TypeScript is the default implementation language for the initial MVP.
- The first full deliverable should be a runnable application, not just a core skeleton.
- Public China-facing deployment should default to compliant map provider settings and disable foreign experiments unless explicitly enabled.
- Real production provider credentials are not available yet, so placeholder providers and browser-native voice APIs will be used behind the same abstractions.
- A Python backend is acceptable and may replace the TypeScript backend path if it keeps provider abstraction and compliance controls intact.

## Risks

- Browser speech APIs are not uniformly supported, so the app must degrade gracefully to text-first interaction.
- Routing and POI search are intentionally curated and must not be presented as authoritative navigation.
- Early abstractions may become too broad if we model too many vendor-specific capabilities up front.
- The empty repository means build tooling choices made now will influence all future packages.

## Validation steps

- Run TypeScript type checking.
- Run unit and integration tests covering compliance defaults, provider swap behavior, ambiguity handling, and the voice-to-map orchestration flow.
- Run UI tests covering transcript display, compliance rendering, and interactive presentation updates.
- Run a production web build.
- Verify that malformed or incomplete tool outputs cannot be used without schema validation.
