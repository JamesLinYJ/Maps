# AGENTS.md

This file gives Codex project-specific instructions for building and maintaining a **China-compliant voice-driven map presentation assistant**.

The product is a **presentation-first** system: users speak naturally, the system interprets the request with an LLM, updates a compliant map view, highlights relevant entities or areas, and narrates the result back to the user.

## 1. Project mission

Build a multimodal map assistant that:

- accepts **voice input** in Mandarin Chinese first, with optional English support
- interprets user intent with an LLM such as **Claude, Gemini, or OpenAI models** through a provider abstraction
- renders map results using a **PRC-compliant map source and service chain**
- emphasizes **visual presentation and guided explanation**, not autonomous navigation
- supports **public-facing demos** and can be hardened for production

The assistant should excel at requests like:

- “带我看看浦东新区的重点区域”
- “放大到这个园区，并讲解它的产业分布”
- “展示从机场到会展中心的大致路线，并说明沿线重点地标”
- “切换到卫星图层，标出这几个点，并逐个讲解”

The product is **not** a turn-by-turn driving assistant. It is a **guided map explanation and visual storytelling system**.

---

## 2. Non-negotiable legal and compliance requirements

This repository must be developed as if it may be used for **public map display within the People’s Republic of China**.

### 2.1 Map compliance rules

Treat these as hard requirements:

- Use **PRC-compliant map sources** for any public-facing deployment.
- Prefer **Tianditu** or other **domestically compliant commercial map services**.
- Do **not** assume that open map data or foreign public tile services are sufficient for production deployment in China.
- Do **not** use a foreign map tile source as the default production base map for China-facing public products.
- Preserve required **审图号**, copyright notices, attribution, and provider display obligations.
- Do not introduce or modify boundary, territorial, island, or administrative-region depictions unless the source and presentation are compliant.
- Do not build features that encourage users to bypass PRC map regulations.

### 2.2 Engineering implications

Codex must preserve this architectural separation:

- **LLM layer**: understands requests, plans tool usage, generates narration
- **Map service layer**: supplies compliant tiles, POI search, geocoding, route summaries, overlays
- **Presentation layer**: renders the returned data and disclosures as required

The LLM must **never** be treated as the source of truth for geography, borders, coordinates, routing legality, or map compliance.

### 2.3 Safe defaults

When in doubt:

- default local development and internal demos to a **non-`china_public` mode** unless the task is explicitly about public-release hardening
- keep **Tianditu-compatible** or approved domestic provider abstractions ready for any China-facing public deployment path
- keep foreign map integrations behind **experimental or non-production flags**
- require explicit config gates for any foreign or non-production map mode

---

## 3. Product principles

### 3.1 Presentation-first UX

Optimize for:

- camera movement and viewport transitions
- POI highlighting and annotations
- narrated explanation
- layer switching for storytelling
- spatial comparison and guided exploration

Do not optimize first for:

- fleet dispatch
- fully autonomous route optimization
- high-frequency live operations dashboards
- logistics control loops

### 3.2 Voice-first interaction

Voice interaction is a primary interface, not a bolt-on.

The system should support:

- push-to-talk and continuous voice session modes
- ASR -> intent understanding -> tool call -> map update -> TTS response
- interruption handling
- short follow-ups like “放大一点”, “切到卫星图”, “再说详细一点”

### 3.3 Provider independence

Support multiple LLM providers through a stable interface.

Expected providers:

- Anthropic Claude
- Google Gemini
- OpenAI models
- optional local or enterprise-hosted providers later

Never hardcode project logic to a single provider’s SDK or response format.

---

## 4. Target architecture

Use a modular architecture with clear boundaries.

### 4.1 Core modules

Recommended top-level structure:

```text
apps/
  web/                  # presentation UI
  api/                  # backend API / orchestration
packages/
  ui/                   # shared UI components
  map-core/             # viewport, layers, feature rendering, provider adapters
  voice-core/           # ASR/TTS abstractions, session state
  llm-core/             # provider abstraction, prompts, tool calling
  tools/                # geocoding, POI search, route summary, area lookup
  compliance/           # provider rules, attribution,审图号, deployment guards
  schemas/              # shared types and validation
  observability/        # logging, metrics, tracing helpers
infra/
  docker/
  scripts/
docs/
  architecture/
  compliance/
  api/
```

### 4.2 Frontend

Frontend responsibilities:

- render the map viewport
- support layer toggles, annotations, and camera animation
- display narration text and source cards when available
- show attribution, provider notices, and compliance UI elements
- manage microphone state and realtime transcript UI

Preferred technologies:

- TypeScript
- React / Next.js or equivalent modern web stack
- MapLibre GL JS or Cesium for rendering
- a domestic compliant provider adapter for production map data

### 4.3 Backend / orchestration

Backend responsibilities:

- authenticate users and manage sessions
- receive transcript and structured interaction events
- call the selected LLM provider
- expose tools for geocoding, POI lookup, route summary, area lookup, and feature retrieval
- normalize all tool outputs to internal schemas
- enforce compliance and deployment gating
- log safely without leaking sensitive user content

### 4.4 Voice pipeline

Abstract the voice layer so the stack can swap components.

Interfaces should support:

- ASR providers: Whisper, Vosk, platform-native ASR, vendor APIs
- TTS providers: Piper, platform-native TTS, vendor APIs
- realtime session transport: WebSocket or WebRTC

### 4.5 LLM pipeline

The LLM pipeline should support:

- transcript cleanup
- intent classification
- slot extraction
- tool selection
- grounded response generation
- map action planning

Typical flow:

1. user speaks
2. ASR emits transcript
3. LLM decides whether to ask a clarifying question or call tools
4. tool layer returns structured geographic information
5. backend generates map actions
6. frontend animates map and highlights results
7. LLM generates grounded narration
8. TTS speaks the response

---

## 5. Recommended tech decisions

These are defaults unless a task explicitly changes them.

### 5.1 Languages

- Prefer **TypeScript** for frontend, API gateway, and orchestration logic
- **Python is allowed as the primary backend implementation** for orchestration, provider integration, and API transport when it improves backend maintainability or future model/audio integration
- TypeScript remains preferred for frontend and shared browser-facing contracts
- Avoid mixing multiple backend languages without a strong reason, but a staged migration from TypeScript backend code to Python is acceptable when documented

### 5.2 Contracts and validation

- Define all cross-module contracts in shared schemas
- Prefer Zod or equivalent runtime validation in TypeScript
- Every tool response must be validated before use
- Never trust raw LLM output without schema validation

### 5.3 Mapping provider strategy

Create adapters, not provider-specific business logic.

Suggested adapter categories:

- `BaseMapProvider`
- `GeocodingProvider`
- `PoiSearchProvider`
- `RoutingProvider`
- `OverlayProvider`
- `ComplianceDisplayProvider`

Production implementation should prioritize PRC-compliant providers.

### 5.4 LLM provider strategy

Create a provider interface such as:

- `chat()`
- `streamChat()`
- `classifyIntent()`
- `callTools()`
- `generateNarration()`

Support capability flags, for example:

- function calling available
- realtime audio available
- multimodal image support
- structured output available

Never scatter provider-specific conditionals across product logic.

---

## 6. Coding standards

### 6.1 General

- Keep modules small and composable
- Favor explicit, typed contracts over “clever” abstractions
- Make side effects visible and localized
- Prefer readability over framework tricks
- Avoid premature generalization

### 6.2 Naming

- Use descriptive names
- Name adapters and services by domain responsibility, not by current vendor
- Example: `MapSearchService`, not `AmapHelper`

### 6.3 Comments

Write comments for:

- legal/compliance constraints
- non-obvious architectural decisions
- provider-specific edge cases
- fallback behavior

Do not add noise comments that merely restate code.

### 6.4 Configuration

All sensitive or environment-specific behavior must be behind config.

Examples:

- `MAP_PROVIDER`
- `MAP_MODE=china_public | internal_demo | experimental`
- `LLM_PROVIDER`
- `ASR_PROVIDER`
- `TTS_PROVIDER`
- `ENABLE_FOREIGN_MAP_EXPERIMENTS=false`

Never hardcode API keys or provider credentials.

---

## 7. User experience requirements

Any UI changes should respect these rules.

### 7.1 Mandatory product behaviors

- transcript must be visible during or after voice input
- current system state must be understandable to the user
- map actions should feel deliberate and explainable
- narration should be concise, grounded, and consistent with what is shown on the map
- the user must be able to interrupt narration or ask a follow-up quickly

### 7.2 Presentation behaviors

Support these map behaviors where feasible:

- fly to point, bounding box, line, polygon
- highlight selected entities
- number or sequence stops when explaining multiple places
- switch style/layer in a controlled way
- show callouts or side cards for key points

### 7.3 Accessibility

- keyboard-accessible microphone and controls
- clear microphone state indicator
- captions or transcript display for audio output
- color choices and overlays should remain legible over maps

---

## 8. Data and privacy rules

Treat voice and location data as sensitive.

- Minimize retention of raw audio
- Do not log precise user location unless necessary and approved
- Redact secrets, tokens, and personally identifying details from logs
- Separate analytics events from raw transcript storage
- Prefer aggregated telemetry over raw content capture
- If saving transcripts for debugging, gate behind explicit development config

Codex should be conservative with logging changes.

---

## 9. Testing requirements

Do not ship significant changes without tests unless the task explicitly requests a prototype-only change.

### 9.1 Required test layers

- unit tests for schema validation, tool normalization, and provider adapters
- integration tests for LLM tool-calling orchestration
- UI tests for key presentation flows
- regression tests for compliance-related UI rendering and configuration gating

### 9.2 High-priority scenarios

Always add or update tests for these kinds of flows when touched:

- voice request -> tool call -> map update -> narration
- provider swap does not break product behavior
- domestic compliant map mode hides or disables experimental providers
- missing provider credentials fail gracefully
- malformed LLM output is rejected safely
- ambiguous location requests trigger clarification or safe fallback

### 9.3 Manual QA checklist

When relevant, include manual verification notes for:

- microphone permissions
- mobile viewport behavior
- map attribution visibility
- narration timing and interruption
- degraded network conditions

---

## 10. Observability and debugging

Implement observability that helps engineers without exposing sensitive data.

Recommended tracing checkpoints:

- voice session started / ended
- ASR transcript received
- intent classification result
- tool call start / success / failure
- map action plan generated
- narration generated
- TTS playback start / complete

Never dump full secrets or unrestricted raw provider payloads into logs.

---

## 11. How Codex should work in this repository

### 11.1 Before making changes

Codex should:

1. read this `AGENTS.md`
2. inspect the relevant package boundaries
3. identify whether the requested change touches compliance, provider abstraction, or public UX behavior
4. produce a short plan when work spans multiple files or subsystems
5. avoid changing unrelated files

### 11.2 Execution plan requirement

For tasks that are multi-step, risky, or architecture-affecting, create or update a plan document before broad edits.

Use a plan when any of the following is true:

- more than 2 files will change
- a shared schema changes
- a provider abstraction changes
- compliance-related behavior changes
- voice session behavior changes
- new dependencies are introduced

The plan should include:

- task goal
- files likely to change
- assumptions
- risks
- validation steps

### 11.3 Editing rules

Codex must:

- preserve existing architecture unless there is clear reason to improve it
- prefer minimal, reversible changes
- keep public APIs stable when possible
- update docs when behavior changes
- update tests with code changes

Codex must not:

- silently replace compliant providers with non-compliant defaults
- hardcode vendor APIs into generic modules
- remove required compliance displays
- add large dependencies casually
- rewrite major areas without necessity

### 11.4 Review guidelines

Treat the following as high-severity review issues:

- any change that weakens PRC map compliance assumptions
- any missing attribution or required legal display after UI changes
- any leakage of raw audio, secrets, or sensitive location data into logs
- any hardcoded single-vendor dependency in shared core layers
- any unvalidated LLM output used directly for map actions

Treat the following as medium-severity review issues:

- poor fallback UX when providers fail
- narration inconsistent with visible map content
- fragile tests tied to vendor response shapes
- low-observability flows without trace points

---

## 12. Implementation preferences by area

### 12.1 Frontend preferences

- prefer server-safe and client-safe separation
- keep map state isolated in a predictable store
- model camera actions as explicit commands
- use composable UI primitives
- ensure loading and failure states are visible

### 12.2 Backend preferences

- separate transport controllers from domain logic
- make tool handlers deterministic where possible
- normalize all provider payloads before returning them upstream
- use retries sparingly and intentionally

### 12.3 Voice preferences

- keep the realtime transport swappable
- design for partial transcripts and late corrections
- support barge-in or interruption where possible

### 12.4 Prompting preferences

Prompts should:

- request concise grounded narration
- instruct the model to call tools for facts instead of guessing
- separate hidden reasoning from user-visible explanation
- produce structured outputs where possible

Do not let prompts encourage hallucinated POIs, distances, or legal judgments.

---

## 13. Definition of done

A change is not done unless all applicable items are satisfied:

- code builds
- tests added or updated
- changed behavior documented
- compliance displays preserved or improved
- provider abstraction remains intact
- no new sensitive logging introduced
- UX remains coherent for voice + map presentation flow

---

## 14. Initial MVP scope

If the repository is still in early stage, default MVP should include:

- one web app
- one backend orchestrator
- one compliant map provider path for China-facing demo mode
- one experimental provider path behind flags
- one LLM provider abstraction with at least two provider implementations
- one voice input path and one TTS output path
- a small curated demo scenario library

Suggested MVP user stories:

- user can ask to focus on a place and hear a short introduction
- user can ask to show several places and get sequential narration
- user can switch layers and zoom by voice
- user can ask follow-up questions about the currently highlighted region

---

## 15. Out-of-scope unless explicitly requested

Do not expand into these areas unless the task specifically asks for them:

- turn-by-turn navigation engine
- large-scale fleet dispatch
- unrestricted live surveillance features
- full GIS editing suite
- custom base map generation pipeline
- broad data scraping of map content

---

## 16. If requirements are ambiguous

When a request is ambiguous, Codex should prefer the interpretation that:

- keeps China-facing public map compliance intact
- preserves provider abstraction
- improves the presentation-first user experience
- minimizes irreversible architectural churn

When needed, implement the smallest useful slice and document assumptions.

---

## 17. Short project summary for agent context

This project is a **voice-driven map presentation assistant** for China-facing scenarios. It uses an LLM to interpret spoken requests, call map tools, animate a compliant map UI, and narrate what is shown. The map layer must remain PRC-compliant for public use. The architecture must remain modular so Claude, Gemini, OpenAI, or other providers can be swapped without rewriting product logic.
