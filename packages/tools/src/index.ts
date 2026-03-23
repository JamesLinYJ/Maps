import { z } from "zod";

import type { ToolCall } from "@maps/schemas";
import {
  areaLookupResultSchema,
  poiSearchResultSchema,
  routeSummaryResultSchema,
  type MapFeature,
  type ToolResult
} from "@maps/schemas";

import {
  routeLandmarksById,
  routePathsById,
  scenarioFeatures,
  sourceCards
} from "./scenario-data";

export {
  defaultGeoAnchor,
  geoAnchorsByFeatureId,
  scenarioFeatures,
  sourceCards
} from "./scenario-data";

export interface ToolExecutionResult {
  toolName: string;
  schema: typeof poiSearchResultSchema | typeof areaLookupResultSchema | typeof routeSummaryResultSchema;
  payload: ToolResult;
}

export interface ToolRegistry {
  execute(toolCalls: ToolCall[]): Promise<ToolExecutionResult[]>;
}

function normalizeText(text: string) {
  return text.trim().toLowerCase();
}

export function searchScenarioFeatures(query: string) {
  const normalizedQuery = normalizeText(query);

  return scenarioFeatures.filter((feature) => {
    if (normalizeText(feature.id).includes(normalizedQuery)) {
      return true;
    }

    if (normalizeText(feature.name).includes(normalizedQuery)) {
      return true;
    }

    return feature.aliases.some((alias) => normalizeText(alias).includes(normalizedQuery));
  });
}

function getFeatureById(featureId: string) {
  return scenarioFeatures.find((feature) => feature.id === featureId);
}

function createPoiSearchResult(query: string, features: MapFeature[]) {
  return poiSearchResultSchema.parse({
    tool: "poiSearch",
    query,
    isAmbiguous: features.length > 1,
    features,
    sourceCards
  });
}

function createAreaLookupResult(featureId: string) {
  const feature = getFeatureById(featureId);

  if (!feature) {
    throw new Error(`Unknown featureId "${featureId}"`);
  }

  return areaLookupResultSchema.parse({
    tool: "areaLookup",
    feature,
    keyPoints: feature.narrativeBullets.map((bullet) => ({
      title: bullet,
      body: `${feature.name}当前视图中的重点讲解方向：${bullet}。`
    })),
    sourceCards
  });
}

function createRouteResult(fromQuery: string, toQuery: string) {
  const fromMatches = searchScenarioFeatures(fromQuery);
  const toMatches = searchScenarioFeatures(toQuery);

  if (fromMatches.length > 1) {
    return routeSummaryResultSchema.parse({
      tool: "routeSummary",
      routeId: "route-ambiguity-from",
      name: "Ambiguous Route Request",
      summary: "需要先澄清出发点。",
      ambiguity: {
        field: "from",
        query: fromQuery,
        options: fromMatches
      },
      sourceCards
    });
  }

  if (toMatches.length > 1) {
    return routeSummaryResultSchema.parse({
      tool: "routeSummary",
      routeId: "route-ambiguity-to",
      name: "Ambiguous Route Request",
      summary: "需要先澄清终点。",
      ambiguity: {
        field: "to",
        query: toQuery,
        options: toMatches
      },
      sourceCards
    });
  }

  const fromFeature = fromMatches[0];
  const toFeature = toMatches[0];

  if (!fromFeature || !toFeature) {
    throw new Error(`Unable to summarize route from "${fromQuery}" to "${toQuery}"`);
  }

  const routeId =
    fromFeature.id === "hub-pudong-airport"
      ? "route-pvg-necc"
      : fromFeature.id === "hub-hongqiao"
        ? "route-hq-necc"
        : "route-hq-necc";

  return routeSummaryResultSchema.parse({
    tool: "routeSummary",
    routeId,
    name: `${fromFeature.name} 到 ${toFeature.name}`,
    startFeature: fromFeature,
    endFeature: toFeature,
    bounds: [
      Math.min(fromFeature.bbox[0], toFeature.bbox[0]),
      Math.min(fromFeature.bbox[1], toFeature.bbox[1]),
      Math.max(fromFeature.bbox[2], toFeature.bbox[2]),
      Math.max(fromFeature.bbox[3], toFeature.bbox[3])
    ],
    path: routePathsById[routeId],
    landmarks: routeLandmarksById[routeId],
    summary: `展示从${fromFeature.name}到${toFeature.name}的路线概览。`,
    cautions: ["该路线为概览摘要，不提供精确导航与实时交通判断。"],
    sourceCards
  });
}

export function createToolRegistry(): ToolRegistry {
  return {
    async execute(toolCalls) {
      return toolCalls.map((toolCall) => {
        switch (toolCall.toolName) {
          case "poiSearch": {
            const query = z.string().parse(toolCall.arguments.query);
            const matches = searchScenarioFeatures(query);

            return {
              toolName: "poiSearch",
              schema: poiSearchResultSchema,
              payload: createPoiSearchResult(query, matches)
            };
          }
          case "areaLookup": {
            const featureId = z.string().parse(toolCall.arguments.featureId);

            return {
              toolName: "areaLookup",
              schema: areaLookupResultSchema,
              payload: createAreaLookupResult(featureId)
            };
          }
          case "routeSummary": {
            const from = z.string().parse(toolCall.arguments.from);
            const to = z.string().parse(toolCall.arguments.to);

            return {
              toolName: "routeSummary",
              schema: routeSummaryResultSchema,
              payload: createRouteResult(from, to)
            };
          }
        }
      });
    }
  };
}
