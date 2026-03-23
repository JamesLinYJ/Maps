import { describe, expect, it } from "vitest";

import { listMapProviders, resolveMapPolicy } from "./index";

describe("compliance map providers", () => {
  it("keeps osm disabled in china_public mode", () => {
    const providers = listMapProviders({
      mapMode: "china_public",
      mapProvider: "tianditu",
      llmProvider: "openai",
      enableForeignMapExperiments: false
    });

    const osm = providers.find((provider) => provider.id === "osm");
    expect(osm?.enabled).toBe(false);
    expect(osm?.reason).toMatch(/china_public/i);
  });

  it("requires explicit foreign experiments before resolving osm policy", () => {
    expect(() =>
      resolveMapPolicy({
        mapMode: "experimental",
        mapProvider: "osm",
        llmProvider: "openai",
        enableForeignMapExperiments: false
      })
    ).toThrow(/enableForeignMapExperiments/i);
  });

  it("allows osm once experimental foreign providers are explicitly enabled", () => {
    const policy = resolveMapPolicy({
      mapMode: "experimental",
      mapProvider: "osm",
      llmProvider: "openai",
      enableForeignMapExperiments: true
    });

    expect(policy.baseMapProvider).toBe("osm");
    expect(policy.allowForeignProviders).toBe(true);
    expect(policy.requireDomesticReviewNumber).toBe(false);
  });
});
