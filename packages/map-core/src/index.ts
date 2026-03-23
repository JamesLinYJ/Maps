import type { Bounds, CalloutItem, Layer, MapActionPlan, MapPolicy, Point } from "@maps/schemas";

export interface BaseMapProvider {
  readonly id: string;
  readonly supportsSatelliteLayer: boolean;
  readonly isDomesticCompliant: boolean;
}

export interface RouteOverlayState {
  path: Point[];
  summary: string;
  landmarkFeatureIds: string[];
}

export interface MapViewState {
  policy: MapPolicy;
  currentBounds: Bounds;
  activeLayer: Layer;
  highlightedFeatureIds: string[];
  callouts: CalloutItem[];
  routeOverlay: RouteOverlayState | null;
}

export const INITIAL_BOUNDS: Bounds = [0, 0, 100, 100];

export function createInitialMapViewState(policy: MapPolicy): MapViewState {
  return {
    policy,
    currentBounds: INITIAL_BOUNDS,
    activeLayer: "vector",
    highlightedFeatureIds: [],
    callouts: [],
    routeOverlay: null
  };
}

function clampBounds(bounds: Bounds): Bounds {
  // 把演示坐标限制在 0-100 的舞台内，避免镜头被工具动作推到可视范围外。
  return [
    Math.max(0, bounds[0]),
    Math.max(0, bounds[1]),
    Math.min(100, bounds[2]),
    Math.min(100, bounds[3])
  ];
}

function zoomBounds(bounds: Bounds, factor: number): Bounds {
  const centerX = (bounds[0] + bounds[2]) / 2;
  const centerY = (bounds[1] + bounds[3]) / 2;
  const width = (bounds[2] - bounds[0]) / factor;
  const height = (bounds[3] - bounds[1]) / factor;

  return clampBounds([
    centerX - width / 2,
    centerY - height / 2,
    centerX + width / 2,
    centerY + height / 2
  ]);
}

export function applyMapActionPlan(state: MapViewState, plan: MapActionPlan): MapViewState {
  // 按动作顺序依次落地，保留“先切层、再聚焦、再画路线”的可解释性。
  return plan.actions.reduce<MapViewState>((currentState, action) => {
    switch (action.type) {
      case "fly_to_bounds":
        return {
          ...currentState,
          currentBounds: clampBounds(action.bounds)
        };
      case "adjust_zoom":
        return {
          ...currentState,
          currentBounds: zoomBounds(currentState.currentBounds, action.factor)
        };
      case "set_layer":
        return {
          ...currentState,
          activeLayer: action.layer
        };
      case "highlight_features":
        return {
          ...currentState,
          highlightedFeatureIds: action.featureIds
        };
      case "draw_route":
        return {
          ...currentState,
          routeOverlay: {
            path: action.path,
            summary: action.summary,
            landmarkFeatureIds: action.landmarkFeatureIds
          }
        };
      case "show_callouts":
        return {
          ...currentState,
          callouts: action.items
        };
      case "clear_route":
        return {
          ...currentState,
          routeOverlay: null
        };
    }
  }, state);
}
