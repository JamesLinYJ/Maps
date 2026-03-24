import { describe, expect, it } from "vitest";

import type { MapActionPlan, MapPolicy } from "@maps/schemas";

import { applyMapActionPlan, createInitialMapViewState } from "./index";

const testPolicy: MapPolicy = {
  mapMode: "internal",
  baseMapProvider: "amap",
  providerDisplayName: "Amap",
  allowForeignProviders: false,
  requireAttributionDisplay: true,
  requireDomesticReviewNumber: false,
  reviewNumber: null,
  attributionText: "test",
  disclaimerText: "test"
};

describe("map-core camera actions", () => {
  it("applies zoom-out and camera actions to map view state", () => {
    const state = createInitialMapViewState(testPolicy);
    state.currentBounds = [121.5, 31.2, 121.6, 31.3];

    const plan: MapActionPlan = {
      summary: "test",
      sourceCards: [],
      actions: [
        {
          type: "adjust_zoom",
          factor: 0.72,
          reason: "zoom out"
        },
        {
          type: "set_camera",
          pitch: 50,
          rotation: 0,
          reason: "tilt"
        }
      ]
    };

    const nextState = applyMapActionPlan(state, plan);

    expect(nextState.currentBounds[0]).toBeLessThan(121.5);
    expect(nextState.currentBounds[2]).toBeGreaterThan(121.6);
    expect(nextState.cameraPitch).toBe(50);
    expect(nextState.cameraRotation).toBe(0);
  });
});
