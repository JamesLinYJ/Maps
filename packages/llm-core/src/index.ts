import {
  createNarrationRequestSchema,
  intentClassificationSchema,
  mapActionPlanSchema,
  type CreateNarrationRequest,
  type IntentClassification,
  type MapActionPlan,
  type MapContext,
  type MapPolicy,
  type Narration,
  type RuntimeConfig,
  type ToolCall,
  type ToolResult,
  type Transcript
} from "@maps/schemas";

export interface LlmProviderCapabilities {
  functionCalling: boolean;
  realtimeAudio: boolean;
  multimodal: boolean;
  structuredOutput: boolean;
}

export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ClassifyIntentRequest {
  transcript: Transcript;
  mapContext: MapContext;
}

export interface CallToolsRequest {
  transcript: Transcript;
  classification: IntentClassification;
  mapContext: MapContext;
  runtime: RuntimeConfig;
}

export interface GenerateMapActionsRequest {
  transcript: Transcript;
  classification: IntentClassification;
  toolResults: ToolResult[];
  mapContext: MapContext;
  mapPolicy: MapPolicy;
}

export interface LlmProvider {
  readonly id: string;
  readonly capabilities: LlmProviderCapabilities;
  chat(messages: LlmChatMessage[]): Promise<string>;
  classifyIntent(request: ClassifyIntentRequest): Promise<IntentClassification>;
  callTools(request: CallToolsRequest): Promise<ToolCall[]>;
  generateMapActions(request: GenerateMapActionsRequest): Promise<MapActionPlan>;
  generateNarration(request: CreateNarrationRequest): Promise<Narration>;
}

function normalizeText(text: string) {
  return text.trim().toLowerCase();
}

function extractRoute(text: string) {
  const match = text.match(/从(.+?)到(.+?)(?:的|并|，|,|。|$)/);

  if (!match) {
    return undefined;
  }

  return {
    from: match[1].trim(),
    to: match[2].trim()
  };
}

function extractKnownPoints(text: string) {
  const candidates = ["浦东新区", "陆家嘴", "张江科学城", "虹桥枢纽", "虹桥机场", "浦东机场", "国家会展中心"];
  return candidates.filter((candidate) => text.includes(candidate));
}

function createBaseClassification(transcript: Transcript, mapContext: MapContext): IntentClassification {
  const text = normalizeText(transcript.text);
  const route = extractRoute(transcript.text);
  const requestedLayer = text.includes("卫星") ? "satellite" : text.includes("矢量") || text.includes("普通") ? "vector" : undefined;
  const pointQueries = extractKnownPoints(transcript.text);

  if (route) {
    return intentClassificationSchema.parse({
      intent: "route_overview",
      confidence: 0.86,
      requestedLayer,
      route
    });
  }

  if (text.includes("详细") && mapContext.highlightedFeatureIds.length > 0) {
    return intentClassificationSchema.parse({
      intent: "detail_follow_up",
      confidence: 0.8,
      requestedLayer
    });
  }

  if (text.includes("放大")) {
    return intentClassificationSchema.parse({
      intent: "zoom_in",
      confidence: 0.79,
      requestedLayer
    });
  }

  if (text.includes("缩小") || text.includes("拉远")) {
    return intentClassificationSchema.parse({
      intent: "zoom_out",
      confidence: 0.77,
      requestedLayer
    });
  }

  if (text.includes("回正") || text.includes("标准视角") || text.includes("正北朝上")) {
    return intentClassificationSchema.parse({
      intent: "reset_view",
      confidence: 0.8,
      requestedLayer
    });
  }

  if (text.includes("3d") || text.includes("俯视") || text.includes("抬高视角")) {
    return intentClassificationSchema.parse({
      intent: "tilt_view",
      confidence: 0.78,
      requestedLayer
    });
  }

  if (text.includes("旋转") || text.includes("转一下方向") || text.includes("换个朝向")) {
    return intentClassificationSchema.parse({
      intent: "rotate_view",
      confidence: 0.76,
      requestedLayer
    });
  }

  if (text.includes("清掉") || text.includes("清除标注") || text.includes("清空地图") || text.includes("去掉路线")) {
    return intentClassificationSchema.parse({
      intent: "clear_overlays",
      confidence: 0.78,
      requestedLayer
    });
  }

  if (pointQueries.length >= 2 || text.includes("逐个讲解")) {
    return intentClassificationSchema.parse({
      intent: "multi_point_story",
      confidence: 0.82,
      requestedLayer,
      pointQueries
    });
  }

  if (requestedLayer && pointQueries.length === 0 && mapContext.highlightedFeatureIds.length === 0) {
    return intentClassificationSchema.parse({
      intent: "layer_switch",
      confidence: 0.76,
      requestedLayer
    });
  }

  const focusMatch =
    transcript.text.match(/(?:看看|聚焦|放大到|展示|标出)(.+?)(?:的重点区域|并|，|,|。|$)/) ??
    transcript.text.match(/(.+?)(?:园区|新区|区域|会展中心|科学城|机场|枢纽)/);

  const focusQuery =
    mapContext.highlightedFeatureIds.length > 0 &&
    (text.includes("这个园区") || text.includes("这里"))
      ? mapContext.highlightedFeatureIds[0]
      : focusMatch?.[1]?.trim();

  return intentClassificationSchema.parse({
    intent: "focus_area",
    confidence: 0.74,
    requestedLayer,
    focusQuery: focusQuery || transcript.text.trim()
  });
}

function buildToolCalls(
  transcript: Transcript,
  classification: IntentClassification,
  mapContext: MapContext
): ToolCall[] {
  switch (classification.intent) {
    case "route_overview":
      return classification.route
        ? [
            {
              toolName: "routeSummary",
              arguments: {
                from: classification.route.from,
                to: classification.route.to,
                locale: transcript.language
              }
            }
          ]
        : [];
    case "detail_follow_up":
      return mapContext.highlightedFeatureIds[0]
        ? [
            {
              toolName: "areaLookup",
              arguments: {
                featureId: mapContext.highlightedFeatureIds[0]
              }
            }
          ]
        : [];
    case "multi_point_story":
      return (classification.pointQueries ?? []).map((query) => ({
        toolName: "poiSearch",
        arguments: {
          query,
          locale: transcript.language
        }
      }));
    case "focus_area":
      return classification.focusQuery
        ? [
            {
              toolName: "poiSearch",
              arguments: {
                query: classification.focusQuery,
                locale: transcript.language
              }
            }
          ]
        : [];
    case "layer_switch":
    case "zoom_in":
    case "zoom_out":
    case "reset_view":
    case "tilt_view":
    case "rotate_view":
    case "clear_overlays":
      return [];
  }
}

function flattenSourceCards(toolResults: ToolResult[]) {
  const seen = new Map<string, { id: string; title: string; provider: string; note: string }>();

  toolResults.flatMap((result) => result.sourceCards).forEach((card) => {
    seen.set(card.id, card);
  });

  return [...seen.values()];
}

function buildMapActions(
  classification: IntentClassification,
  toolResults: ToolResult[],
  mapContext: MapContext
): MapActionPlan {
  const actions: MapActionPlan["actions"] = [];
  const sourceCards = flattenSourceCards(toolResults);

  if (classification.requestedLayer && classification.requestedLayer !== mapContext.activeLayer) {
    actions.push({
      type: "set_layer",
      layer: classification.requestedLayer
    });
  }

  if (classification.intent === "zoom_in") {
    actions.push({
      type: "adjust_zoom",
      factor: 1.35,
      reason: "Zoom in on the current presentation area"
    });

    return mapActionPlanSchema.parse({
      summary: "Zoomed into the current focus region.",
      actions,
      sourceCards
    });
  }

  if (classification.intent === "zoom_out") {
    actions.push({
      type: "adjust_zoom",
      factor: 0.72,
      reason: "Zoom out to show a broader presentation area"
    });

    return mapActionPlanSchema.parse({
      summary: "已拉远当前地图视图。",
      actions,
      sourceCards
    });
  }

  if (classification.intent === "reset_view") {
    actions.push({
      type: "set_camera",
      pitch: 0,
      rotation: 0,
      reason: "Reset camera to the default north-up presentation view"
    });

    return mapActionPlanSchema.parse({
      summary: "已恢复到标准地图视角。",
      actions,
      sourceCards
    });
  }

  if (classification.intent === "tilt_view") {
    actions.push({
      type: "set_camera",
      pitch: 50,
      rotation: 0,
      reason: "Tilt the camera for a more spatial 3D presentation"
    });

    return mapActionPlanSchema.parse({
      summary: "已切换到 3D 俯视视角。",
      actions,
      sourceCards
    });
  }

  if (classification.intent === "rotate_view") {
    actions.push({
      type: "set_camera",
      rotation: 90,
      reason: "Rotate the camera to inspect the current scene from another orientation"
    });

    return mapActionPlanSchema.parse({
      summary: "已旋转地图视角。",
      actions,
      sourceCards
    });
  }

  if (classification.intent === "clear_overlays") {
    actions.push({
      type: "clear_route"
    });
    actions.push({
      type: "clear_highlights"
    });
    actions.push({
      type: "clear_callouts"
    });

    return mapActionPlanSchema.parse({
      summary: "已清除当前路线、高亮和讲解标注。",
      actions,
      sourceCards
    });
  }

  const matchedFeatures = toolResults.flatMap((result) => {
    if (result.tool === "poiSearch") {
      return result.features;
    }

    if (result.tool === "areaLookup") {
      return [result.feature];
    }

    if (result.tool === "routeSummary" && result.startFeature && result.endFeature) {
      return [result.startFeature, result.endFeature];
    }

    return [];
  });

  if (matchedFeatures.length > 0) {
    actions.push({
      type: "fly_to_bounds",
      bounds: matchedFeatures[0].bbox,
      reason: `Focus on ${matchedFeatures[0].name}`
    });
    actions.push({
      type: "highlight_features",
      featureIds: matchedFeatures.map((feature) => feature.id),
      style: matchedFeatures.length > 1 ? "secondary" : "primary"
    });
  }

  const routeResult = toolResults.find((result) => result.tool === "routeSummary");
  if (routeResult && routeResult.tool === "routeSummary" && routeResult.path.length > 1 && routeResult.bounds) {
    actions.push({
      type: "fly_to_bounds",
      bounds: routeResult.bounds,
      reason: routeResult.summary
    });
    actions.push({
      type: "draw_route",
      path: routeResult.path,
      landmarkFeatureIds: routeResult.landmarks.map((landmark) => landmark.featureId),
      summary: routeResult.summary
    });
  } else {
    actions.push({
      type: "clear_route"
    });
  }

  const calloutItems =
    routeResult && routeResult.tool === "routeSummary"
      ? routeResult.landmarks.map((landmark, index) => ({
          featureId: landmark.featureId,
          title: landmark.name,
          body: landmark.summary,
          index: index + 1
        }))
      : toolResults.flatMap((result) => {
          if (result.tool === "areaLookup") {
            return result.keyPoints.map((point, index) => ({
              featureId: result.feature.id,
              title: point.title,
              body: point.body,
              index: index + 1
            }));
          }

          if (result.tool === "poiSearch") {
            return result.features.map((feature, index) => ({
              featureId: feature.id,
              title: feature.name,
              body: feature.description,
              index: matchedFeatures.length > 1 ? index + 1 : undefined
            }));
          }

          return [];
        });

  if (calloutItems.length > 0) {
    actions.push({
      type: "show_callouts",
      items: calloutItems
    });
  }

  return mapActionPlanSchema.parse({
    summary:
      classification.intent === "route_overview"
        ? "已生成路线展示视图。"
        : classification.intent === "multi_point_story"
          ? "已生成多点顺序展示视图。"
          : "已生成地图聚焦展示视图。",
    actions,
    sourceCards
  });
}

function createNarrationText(style: "concise" | "guided", request: CreateNarrationRequest) {
  const { classification, toolResults } = request;
  const featureNames = toolResults.flatMap((result) => {
    if (result.tool === "poiSearch") {
      return result.features.map((feature) => feature.name);
    }

    if (result.tool === "areaLookup") {
      return [result.feature.name];
    }

    if (result.tool === "routeSummary" && result.startFeature && result.endFeature) {
      return [result.startFeature.name, result.endFeature.name];
    }

    return [];
  });

  if (classification.intent === "route_overview") {
    const routeResult = toolResults.find((result) => result.tool === "routeSummary");
    if (routeResult && routeResult.tool === "routeSummary") {
      const landmarks = routeResult.landmarks.map((item) => item.name).join("、");
      return style === "concise"
        ? `已展示从${routeResult.startFeature?.name ?? "起点"}到${routeResult.endFeature?.name ?? "终点"}的大致路线，并标出${landmarks}等沿线重点。`
        : `我已经把从${routeResult.startFeature?.name ?? "起点"}到${routeResult.endFeature?.name ?? "终点"}的路线展开，同时把${landmarks}这些适合讲解的沿线节点依次标出来了。`;
    }
  }

  if (classification.intent === "detail_follow_up") {
    const areaResult = toolResults.find((result) => result.tool === "areaLookup");
    if (areaResult && areaResult.tool === "areaLookup") {
      const focusPoints = areaResult.keyPoints.map((point) => point.title).join("、");
      return style === "concise"
        ? `我补充了${areaResult.feature.name}的详细讲解，重点包括${focusPoints}。`
        : `我把${areaResult.feature.name}的讲解进一步展开了，当前最值得看的部分包括${focusPoints}，你可以边听边看右侧标注。`;
    }
  }

  if (classification.intent === "zoom_in") {
    return style === "concise"
      ? "我已经把当前视角再放大一点，方便继续讲解。"
      : "我把镜头再推进了一些，这样你接下来查看重点区域会更清楚。";
  }

  if (classification.intent === "zoom_out") {
    return style === "concise"
      ? "我已经把视角拉远一点，方便观察整体范围。"
      : "我把镜头稍微拉远了一些，这样你可以先看清整体范围，再继续讲解细节。";
  }

  if (classification.intent === "reset_view") {
    return style === "concise"
      ? "我已经把地图回正，并恢复到标准视角。"
      : "我已经把地图恢复到标准视角并回正朝向，这样后续讲解会更稳定清晰。";
  }

  if (classification.intent === "tilt_view") {
    return style === "concise"
      ? "我已经切到 3D 俯视视角。"
      : "我已经把地图切换到更有空间感的 3D 俯视视角，方便你观察楼块和区域关系。";
  }

  if (classification.intent === "rotate_view") {
    return style === "concise"
      ? "我已经把地图旋转到新的观察朝向。"
      : "我已经把地图旋转到了新的观察朝向，方便你从另一个方向继续看当前区域。";
  }

  if (classification.intent === "clear_overlays") {
    return style === "concise"
      ? "我已经清除了当前路线、标注和高亮。"
      : "我已经把当前路线、高亮和讲解标注清掉了，地图画面现在更干净，可以重新开始下一步展示。";
  }

  if (classification.intent === "layer_switch" && featureNames.length === 0) {
    return style === "concise"
      ? "已切换图层。"
      : "图层已经切换完成，你可以继续要求我标注或讲解具体地点。";
  }

  if (classification.intent === "multi_point_story") {
    return style === "concise"
      ? `我已依次标出${featureNames.join("、")}，并准备逐个讲解。`
      : `我已经把${featureNames.join("、")}这些点位依次放上地图，接下来可以按照编号逐个为你讲解。`;
  }

  return style === "concise"
    ? `已为你聚焦${featureNames.join("、")}，并高亮重点内容。`
    : `我已经把画面聚焦到${featureNames.join("、")}，并把适合讲解的重点信息同步标了出来。`;
}

function createProviderAdapter(
  id: "openai" | "anthropic" | "gemini",
  style: "concise" | "guided"
): LlmProvider {
  return {
    id,
    capabilities: {
      functionCalling: true,
      realtimeAudio: false,
      multimodal: false,
      structuredOutput: true
    },
    async chat(messages) {
      return `${id} provider received ${messages.length} messages.`;
    },
    async classifyIntent(request) {
      return createBaseClassification(request.transcript, request.mapContext);
    },
    async callTools(request) {
      return buildToolCalls(request.transcript, request.classification, request.mapContext);
    },
    async generateMapActions(request) {
      return buildMapActions(request.classification, request.toolResults, request.mapContext);
    },
    async generateNarration(rawRequest) {
      const request = createNarrationRequestSchema.parse(rawRequest);
      return {
        text: createNarrationText(style, request),
        language: request.transcript.language,
        grounding: request.toolResults.flatMap((result) => {
          if (result.tool === "poiSearch") {
            return result.features.map((feature) => feature.id);
          }

          if (result.tool === "areaLookup") {
            return [result.feature.id];
          }

          if (result.tool === "routeSummary") {
            return result.landmarks.map((landmark) => landmark.featureId);
          }

          return [];
        })
      };
    }
  };
}

export function createLlmProvider(providerId: "openai" | "anthropic" | "gemini") {
  if (providerId === "anthropic") {
    return createProviderAdapter("anthropic", "guided");
  }

  if (providerId === "gemini") {
    return createProviderAdapter("gemini", "guided");
  }

  return createProviderAdapter("openai", "concise");
}
