# Provider Configuration

## Goal

Keep runtime provider selection behind a stable assembly layer so we can switch providers without rewriting orchestration logic.

For the recommended long-term stack, see `docs/architecture/recommended-stack.md`.

## Current behavior

- `apps/api/src/provider-config.ts` parses environment variables and resolves runtime defaults.
- `apps/backend/app/provider_config.py` now performs the same runtime assembly for the Python backend.
- The Python backend now exposes an explicit AI-agent route: Python orchestration, multi-LLM provider abstraction, voice capability metadata, and NL2SQL planning visibility.
- Default runtime targets `internal + osm + enableForeignMapExperiments=true` so local development does not boot straight into `china_public`.
- Missing credentials are surfaced as configuration gaps instead of placeholder adapters.
- `STRICT_PROVIDER_CONFIG=true` turns missing credentials into startup/runtime errors.
- Even when credentials are present, the current repository still uses placeholder adapters; the assembly layer is ready for real SDK wiring later.
- The `openai` route should be read as an `OpenAI-compatible` path, so it can later target either official OpenAI endpoints or compatible gateways that speak the same interface shape.
- The frontend reads runtime defaults and binding state from `GET /api/runtime`.
- `osm` is available as a foreign experimental provider and does not require a credential, but it must stay out of `china_public` mode.

## Recommended real integration direction

The current preferred replacement path for placeholder adapters is:

1. `PydanticAI` inside the Python backend for typed orchestration.
2. `LiteLLM` as the backend transport unification layer for `OpenAI-compatible`, `Anthropic`, and `Gemini`.
3. Existing HTTP contracts preserved so the React frontend does not need to change when the AI layer is upgraded.
4. `LiveKit Agents` introduced later when the project needs realtime voice sessions beyond browser-native fallback behavior.

This means the current environment variables remain useful, but the implementation goal is no longer a placeholder adapter path. The goal is to move these runtime selections onto real provider clients behind the same backend interface.

## Environment variables

- `MAP_MODE`
- `MAP_PROVIDER`
- `LLM_PROVIDER`
- `ENABLE_FOREIGN_MAP_EXPERIMENTS`
- `STRICT_PROVIDER_CONFIG`
- `TIANDITU_API_KEY`
- `AMAP_API_KEY`
- `MAPBOX_ACCESS_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_COMPAT_BASE_URL`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

`osm` currently uses public-access tiles and therefore does not require a dedicated API key. It should still be treated as experimental and non-production for China-facing public deployments.

Frontend builds may use the same values with `VITE_` prefixes.
Add `VITE_API_BASE_URL` when the frontend should target a non-default backend address.

## Integration path

1. Replace the placeholder logic inside `apps/backend/app/ai_layer.py` with a real provider-backed orchestration path.
2. Keep the HTTP response contracts stable so the frontend client does not need rewrites.
3. Preserve compliance checks in `resolveMapPolicy()` and provider gating in `describe_runtime_assembly()`.
4. Replace placeholder map and voice adapters incrementally instead of swapping all layers at once.
5. Add integration tests for each real adapter before enabling it by default.
