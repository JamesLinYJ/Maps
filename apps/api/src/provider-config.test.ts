import { describe, expect, it } from "vitest";

import {
  createRuntimeDependencies,
  describeRuntimeAssembly,
  parseServerEnv,
  resolveRuntimeDefaults
} from "./provider-config";

describe("provider-config", () => {
  it("resolves runtime defaults from environment variables", () => {
    const runtime = resolveRuntimeDefaults({
      MAP_MODE: "internal",
      MAP_PROVIDER: "amap",
      LLM_PROVIDER: "anthropic",
      ENABLE_FOREIGN_MAP_EXPERIMENTS: "true"
    });

    expect(runtime).toEqual({
      mapMode: "internal",
      mapProvider: "amap",
      llmProvider: "anthropic",
      enableForeignMapExperiments: true
    });
  });

  it("uses internal defaults when environment variables are absent", () => {
    const runtime = resolveRuntimeDefaults({});

    expect(runtime).toEqual({
      mapMode: "internal",
      mapProvider: "osm",
      llmProvider: "openai",
      enableForeignMapExperiments: true
    });
  });

  it("marks providers as requiring configuration when credentials are missing", () => {
    const diagnostics = describeRuntimeAssembly(
      {
        mapMode: "china_public",
        mapProvider: "tianditu",
        llmProvider: "openai",
        enableForeignMapExperiments: false
      },
      {}
    );

    expect(
      diagnostics.bindings.every((binding) => binding.adapterMode === "requires_configuration")
    ).toBe(true);
    expect(diagnostics.warnings.some((warning) => warning.includes("OPENAI_API_KEY"))).toBe(true);
    expect(diagnostics.warnings.some((warning) => warning.includes("TIANDITU_API_KEY"))).toBe(true);
  });

  it("surfaces credential-ready placeholder mode when keys exist", () => {
    const dependencies = createRuntimeDependencies(
      {
        mapMode: "china_public",
        mapProvider: "tianditu",
        llmProvider: "openai",
        enableForeignMapExperiments: false
      },
      {
        OPENAI_API_KEY: "sk-test",
        TIANDITU_API_KEY: "tdt-test"
      }
    );

    expect(dependencies.bindings.every((binding) => binding.adapterMode === "credential_ready_placeholder")).toBe(true);
    expect(dependencies.warnings).toHaveLength(0);
  });

  it("treats osm as public-access experimental provider without requiring a key", () => {
    const diagnostics = describeRuntimeAssembly(
      {
        mapMode: "experimental",
        mapProvider: "osm",
        llmProvider: "openai",
        enableForeignMapExperiments: true
      },
      {
        OPENAI_API_KEY: "sk-test"
      }
    );

    expect(diagnostics.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "map",
          providerId: "osm",
          adapterMode: "public_access",
          credentialEnvVar: null
        })
      ])
    );
    expect(diagnostics.warnings.some((warning) => warning.includes("OSM"))).toBe(false);
  });

  it("throws in strict mode when credentials are missing", () => {
    expect(() =>
      describeRuntimeAssembly(
        {
          mapMode: "china_public",
          mapProvider: "tianditu",
          llmProvider: "openai",
          enableForeignMapExperiments: false
        },
        {
          STRICT_PROVIDER_CONFIG: "true"
        }
      )
    ).toThrow(/OPENAI_API_KEY/i);
  });

  it("parses server env summary", () => {
    const result = parseServerEnv({
      STRICT_PROVIDER_CONFIG: "false"
    });

    expect(result.runtimeDefaults.mapMode).toBe("internal");
    expect(result.runtimeDefaults.mapProvider).toBe("osm");
    expect(result.strictProviderConfig).toBe(false);
  });
});
