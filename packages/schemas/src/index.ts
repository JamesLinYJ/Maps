import { z } from "zod";

export const pointSchema = z.tuple([z.number(), z.number()]);
export type Point = z.infer<typeof pointSchema>;

export const boundsSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Bounds = z.infer<typeof boundsSchema>;

export const mapModeSchema = z.enum(["china_public", "internal", "experimental"]);
export type MapMode = z.infer<typeof mapModeSchema>;

export const mapProviderSchema = z.enum(["tianditu", "amap", "mapbox", "osm"]);
export type MapProvider = z.infer<typeof mapProviderSchema>;

export const llmProviderSchema = z.enum(["openai", "anthropic", "gemini"]);
export type LlmProviderId = z.infer<typeof llmProviderSchema>;

export const layerSchema = z.enum(["vector", "satellite"]);
export type Layer = z.infer<typeof layerSchema>;

export const runtimeConfigSchema = z.object({
  mapMode: mapModeSchema.default("internal"),
  mapProvider: mapProviderSchema.default("osm"),
  llmProvider: llmProviderSchema.default("openai"),
  enableForeignMapExperiments: z.boolean().default(true)
});
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export const transcriptSchema = z.object({
  text: z.string().min(1),
  language: z.string().min(2),
  isFinal: z.boolean()
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const sessionSchema = z.object({
  id: z.string().min(1)
});
export type Session = z.infer<typeof sessionSchema>;

export const sourceCardSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  provider: z.string().min(1),
  note: z.string().min(1)
});
export type SourceCard = z.infer<typeof sourceCardSchema>;

export const mapFeatureKindSchema = z.enum([
  "district",
  "campus",
  "landmark",
  "hub",
  "venue",
  "route_landmark"
]);
export type MapFeatureKind = z.infer<typeof mapFeatureKindSchema>;

export const mapFeatureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  kind: mapFeatureKindSchema,
  description: z.string().min(1),
  bbox: boundsSchema,
  centroid: pointSchema,
  tags: z.array(z.string()).default([]),
  narrativeBullets: z.array(z.string()).default([])
});
export type MapFeature = z.infer<typeof mapFeatureSchema>;

export const routeLandmarkSchema = z.object({
  featureId: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  point: pointSchema
});
export type RouteLandmark = z.infer<typeof routeLandmarkSchema>;

export const toolNameSchema = z.enum(["poiSearch", "areaLookup", "routeSummary"]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const toolCallSchema = z.object({
  toolName: toolNameSchema,
  arguments: z.record(z.string(), z.unknown())
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const intentClassificationSchema = z.object({
  intent: z.enum([
    "focus_area",
    "route_overview",
    "layer_switch",
    "zoom_in",
    "detail_follow_up",
    "multi_point_story"
  ]),
  confidence: z.number().min(0).max(1),
  requestedLayer: layerSchema.optional(),
  focusQuery: z.string().optional(),
  route: z
    .object({
      from: z.string().min(1),
      to: z.string().min(1)
    })
    .optional(),
  pointQueries: z.array(z.string()).optional()
});
export type IntentClassification = z.infer<typeof intentClassificationSchema>;

export const poiSearchResultSchema = z.object({
  tool: z.literal("poiSearch"),
  query: z.string().min(1),
  isAmbiguous: z.boolean().default(false),
  features: z.array(mapFeatureSchema),
  sourceCards: z.array(sourceCardSchema)
});
export type PoiSearchResult = z.infer<typeof poiSearchResultSchema>;

export const areaLookupResultSchema = z.object({
  tool: z.literal("areaLookup"),
  feature: mapFeatureSchema,
  keyPoints: z.array(
    z.object({
      title: z.string().min(1),
      body: z.string().min(1)
    })
  ),
  sourceCards: z.array(sourceCardSchema)
});
export type AreaLookupResult = z.infer<typeof areaLookupResultSchema>;

export const routeSummaryResultSchema = z.object({
  tool: z.literal("routeSummary"),
  routeId: z.string().min(1),
  name: z.string().min(1),
  startFeature: mapFeatureSchema.optional(),
  endFeature: mapFeatureSchema.optional(),
  bounds: boundsSchema.optional(),
  path: z.array(pointSchema).default([]),
  landmarks: z.array(routeLandmarkSchema).default([]),
  summary: z.string().min(1),
  cautions: z.array(z.string()).default([]),
  ambiguity: z
    .object({
      field: z.enum(["from", "to"]),
      query: z.string().min(1),
      options: z.array(mapFeatureSchema).min(2)
    })
    .optional(),
  sourceCards: z.array(sourceCardSchema)
});
export type RouteSummaryResult = z.infer<typeof routeSummaryResultSchema>;

export const toolResultSchema = z.union([
  poiSearchResultSchema,
  areaLookupResultSchema,
  routeSummaryResultSchema
]);
export type ToolResult = z.infer<typeof toolResultSchema>;

export const calloutItemSchema = z.object({
  featureId: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  index: z.number().int().positive().optional()
});
export type CalloutItem = z.infer<typeof calloutItemSchema>;

export const mapActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("fly_to_bounds"),
    bounds: boundsSchema,
    reason: z.string().min(1)
  }),
  z.object({
    type: z.literal("adjust_zoom"),
    factor: z.number().positive(),
    reason: z.string().min(1)
  }),
  z.object({
    type: z.literal("set_layer"),
    layer: layerSchema
  }),
  z.object({
    type: z.literal("highlight_features"),
    featureIds: z.array(z.string()).min(1),
    style: z.enum(["primary", "secondary"])
  }),
  z.object({
    type: z.literal("draw_route"),
    path: z.array(pointSchema).min(2),
    landmarkFeatureIds: z.array(z.string()).default([]),
    summary: z.string().min(1)
  }),
  z.object({
    type: z.literal("show_callouts"),
    items: z.array(calloutItemSchema).min(1)
  }),
  z.object({
    type: z.literal("clear_route")
  })
]);
export type MapAction = z.infer<typeof mapActionSchema>;

export const mapActionPlanSchema = z.object({
  summary: z.string().min(1),
  actions: z.array(mapActionSchema),
  sourceCards: z.array(sourceCardSchema)
});
export type MapActionPlan = z.infer<typeof mapActionPlanSchema>;

export const clarificationSchema = z.object({
  question: z.string().min(1),
  options: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      resolvedValue: z.string().min(1)
    })
  )
});
export type Clarification = z.infer<typeof clarificationSchema>;

export const narrationSchema = z.object({
  text: z.string().min(1),
  language: z.string().min(2),
  grounding: z.array(z.string()).default([])
});
export type Narration = z.infer<typeof narrationSchema>;

export const mapContextSchema = z.object({
  currentBounds: boundsSchema.default([0, 0, 100, 100]),
  activeLayer: layerSchema.default("vector"),
  highlightedFeatureIds: z.array(z.string()).default([])
});
export type MapContext = z.infer<typeof mapContextSchema>;

export const orchestratorRequestSchema = z.object({
  runtime: runtimeConfigSchema,
  session: sessionSchema,
  transcript: transcriptSchema,
  mapContext: mapContextSchema
});
export type OrchestratorRequest = z.infer<typeof orchestratorRequestSchema>;

export const mapPolicySchema = z.object({
  mapMode: mapModeSchema,
  baseMapProvider: mapProviderSchema,
  providerDisplayName: z.string().min(1),
  allowForeignProviders: z.boolean(),
  requireAttributionDisplay: z.boolean(),
  requireDomesticReviewNumber: z.boolean(),
  reviewNumber: z.string().nullable(),
  attributionText: z.string().min(1),
  disclaimerText: z.string().min(1)
});
export type MapPolicy = z.infer<typeof mapPolicySchema>;

export const createNarrationRequestSchema = z.object({
  transcript: transcriptSchema,
  classification: intentClassificationSchema,
  toolResults: z.array(toolResultSchema),
  mapActionPlan: mapActionPlanSchema,
  mapPolicy: mapPolicySchema
});
export type CreateNarrationRequest = z.infer<typeof createNarrationRequestSchema>;

export const assistantTurnResultSchema = z.object({
  responseMode: z.enum(["answer", "clarification"]),
  policy: mapPolicySchema,
  classification: intentClassificationSchema,
  toolCalls: z.array(toolCallSchema),
  toolResults: z.array(toolResultSchema),
  mapActionPlan: mapActionPlanSchema,
  narration: narrationSchema,
  clarification: clarificationSchema.optional()
});
export type AssistantTurnResult = z.infer<typeof assistantTurnResultSchema>;

export const providerBindingSummarySchema = z.object({
  kind: z.string().min(1),
  providerId: z.string().min(1),
  adapterMode: z.string().min(1),
  credentialEnvVar: z.string().nullable(),
  message: z.string().min(1)
});
export type ProviderBindingSummary = z.infer<typeof providerBindingSummarySchema>;

export const stackComponentSummarySchema = z.object({
  category: z.string().min(1),
  stack: z.string().min(1),
  detail: z.string().min(1)
});
export type StackComponentSummary = z.infer<typeof stackComponentSummarySchema>;

export const runtimeInspectionSchema = z.object({
  runtime: runtimeConfigSchema,
  bindings: z.array(providerBindingSummarySchema),
  warnings: z.array(z.string()),
  architectureSummary: z.string().min(1),
  stack: z.array(stackComponentSummarySchema)
});
export type RuntimeInspection = z.infer<typeof runtimeInspectionSchema>;

export const turnResponseSchema = z.object({
  result: assistantTurnResultSchema,
  trace: z.array(z.record(z.string(), z.unknown())),
  bindings: z.array(providerBindingSummarySchema),
  warnings: z.array(z.string()),
  architectureSummary: z.string().min(1),
  stack: z.array(stackComponentSummarySchema)
});
export type TurnResponse = z.infer<typeof turnResponseSchema>;
