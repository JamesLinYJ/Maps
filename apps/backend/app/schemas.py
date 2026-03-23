from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class MapMode(str, Enum):
    CHINA_PUBLIC = "china_public"
    INTERNAL = "internal"
    EXPERIMENTAL = "experimental"


class MapProvider(str, Enum):
    TIANDITU = "tianditu"
    AMAP = "amap"
    MAPBOX = "mapbox"
    OSM = "osm"


class LlmProviderId(str, Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"


class Layer(str, Enum):
    VECTOR = "vector"
    SATELLITE = "satellite"


class RuntimeConfig(BaseModel):
    # 对外接口继续使用 camelCase，保证前端和后端共享同一份 JSON 契约。
    map_mode: MapMode = Field(default=MapMode.INTERNAL, alias="mapMode")
    map_provider: MapProvider = Field(default=MapProvider.OSM, alias="mapProvider")
    llm_provider: LlmProviderId = Field(default=LlmProviderId.OPENAI, alias="llmProvider")
    enable_foreign_map_experiments: bool = Field(default=True, alias="enableForeignMapExperiments")


class MapContext(BaseModel):
    current_bounds: tuple[float, float, float, float] = Field(
        default=(0.0, 0.0, 100.0, 100.0), alias="currentBounds"
    )
    active_layer: Layer = Field(default=Layer.VECTOR, alias="activeLayer")
    highlighted_feature_ids: list[str] = Field(default_factory=list, alias="highlightedFeatureIds")


class SourceCard(BaseModel):
    id: str
    title: str
    provider: str
    note: str


class MapFeature(BaseModel):
    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    kind: str
    description: str
    bbox: tuple[float, float, float, float]
    centroid: tuple[float, float]
    tags: list[str] = Field(default_factory=list)
    narrative_bullets: list[str] = Field(default_factory=list, alias="narrativeBullets")


class RouteLandmark(BaseModel):
    feature_id: str = Field(alias="featureId")
    name: str
    summary: str
    point: tuple[float, float]


class ToolCall(BaseModel):
    tool_name: str = Field(alias="toolName")
    arguments: dict[str, object]


class IntentClassification(BaseModel):
    intent: str
    confidence: float
    requested_layer: Layer | None = Field(default=None, alias="requestedLayer")
    focus_query: str | None = Field(default=None, alias="focusQuery")
    route: dict[str, str] | None = None
    point_queries: list[str] | None = Field(default=None, alias="pointQueries")


class PoiSearchResult(BaseModel):
    tool: str = "poiSearch"
    query: str
    is_ambiguous: bool = Field(default=False, alias="isAmbiguous")
    features: list[MapFeature]
    source_cards: list[SourceCard] = Field(alias="sourceCards")


class AreaKeyPoint(BaseModel):
    title: str
    body: str


class AreaLookupResult(BaseModel):
    tool: str = "areaLookup"
    feature: MapFeature
    key_points: list[AreaKeyPoint] = Field(alias="keyPoints")
    source_cards: list[SourceCard] = Field(alias="sourceCards")


class RouteAmbiguity(BaseModel):
    field: str
    query: str
    options: list[MapFeature]


class RouteSummaryResult(BaseModel):
    tool: str = "routeSummary"
    route_id: str = Field(alias="routeId")
    name: str
    start_feature: MapFeature | None = Field(default=None, alias="startFeature")
    end_feature: MapFeature | None = Field(default=None, alias="endFeature")
    bounds: tuple[float, float, float, float] | None = None
    path: list[tuple[float, float]] = Field(default_factory=list)
    landmarks: list[RouteLandmark] = Field(default_factory=list)
    summary: str
    cautions: list[str] = Field(default_factory=list)
    ambiguity: RouteAmbiguity | None = None
    source_cards: list[SourceCard] = Field(alias="sourceCards")


class CalloutItem(BaseModel):
    feature_id: str = Field(alias="featureId")
    title: str
    body: str
    index: int | None = None


class MapAction(BaseModel):
    type: str
    bounds: tuple[float, float, float, float] | None = None
    reason: str | None = None
    factor: float | None = None
    layer: Layer | None = None
    feature_ids: list[str] | None = Field(default=None, alias="featureIds")
    style: str | None = None
    path: list[tuple[float, float]] | None = None
    landmark_feature_ids: list[str] | None = Field(default=None, alias="landmarkFeatureIds")
    summary: str | None = None
    items: list[CalloutItem] | None = None


class MapActionPlan(BaseModel):
    summary: str
    actions: list[MapAction]
    source_cards: list[SourceCard] = Field(alias="sourceCards")


class ClarificationOption(BaseModel):
    id: str
    label: str
    resolved_value: str = Field(alias="resolvedValue")


class Clarification(BaseModel):
    question: str
    options: list[ClarificationOption]


class Narration(BaseModel):
    text: str
    language: str
    grounding: list[str] = Field(default_factory=list)


class MapPolicy(BaseModel):
    # 合规相关字段全部显式输出，便于前端直接渲染审图号、声明和供应商信息。
    map_mode: MapMode = Field(alias="mapMode")
    base_map_provider: MapProvider = Field(alias="baseMapProvider")
    provider_display_name: str = Field(alias="providerDisplayName")
    allow_foreign_providers: bool = Field(alias="allowForeignProviders")
    require_attribution_display: bool = Field(alias="requireAttributionDisplay")
    require_domestic_review_number: bool = Field(alias="requireDomesticReviewNumber")
    review_number: str | None = Field(default=None, alias="reviewNumber")
    attribution_text: str = Field(alias="attributionText")
    disclaimer_text: str = Field(alias="disclaimerText")


class AssistantTurnResult(BaseModel):
    response_mode: str = Field(alias="responseMode")
    policy: MapPolicy
    classification: IntentClassification
    tool_calls: list[ToolCall] = Field(alias="toolCalls")
    # toolResults 保留宽类型，后端先完成校验后再统一回传给前端。
    tool_results: list[object] = Field(alias="toolResults")
    map_action_plan: MapActionPlan = Field(alias="mapActionPlan")
    narration: Narration
    clarification: Clarification | None = None


class ProviderBindingSummary(BaseModel):
    kind: str
    provider_id: str = Field(alias="providerId")
    adapter_mode: str = Field(alias="adapterMode")
    credential_env_var: str | None = Field(default=None, alias="credentialEnvVar")
    message: str


class StackComponentSummary(BaseModel):
    category: str
    stack: str
    detail: str


class HandleTurnRequest(BaseModel):
    runtime: RuntimeConfig
    session_id: str = Field(alias="sessionId")
    transcript_text: str = Field(alias="transcriptText")
    map_context: MapContext = Field(alias="mapContext")


class HandleTurnResponse(BaseModel):
    result: AssistantTurnResult
    trace: list[dict[str, object]]
    bindings: list[ProviderBindingSummary]
    warnings: list[str]
    architecture_summary: str = Field(alias="architectureSummary")
    stack: list[StackComponentSummary]


class RuntimeConfigResponse(BaseModel):
    runtime: RuntimeConfig
    bindings: list[ProviderBindingSummary]
    warnings: list[str]
    architecture_summary: str = Field(alias="architectureSummary")
    stack: list[StackComponentSummary]
