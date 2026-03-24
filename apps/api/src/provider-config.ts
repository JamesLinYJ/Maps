import { z } from "zod";

import { listMapProviders } from "@maps/compliance";
import { createLlmProvider, type LlmProvider } from "@maps/llm-core";
import { runtimeConfigSchema, type RuntimeConfig } from "@maps/schemas";
import { createToolRegistry, type ToolRegistry } from "@maps/tools";

type EnvSource = Record<string, string | boolean | undefined>;

export interface ProviderBindingSummary {
  kind: "llm" | "map";
  providerId: string;
  adapterMode: "requires_configuration" | "credential_ready_placeholder" | "public_access";
  credentialEnvVar: string | null;
  message: string;
}

export interface RuntimeAssemblyDiagnostics {
  runtime: RuntimeConfig;
  strictProviderConfig: boolean;
  bindings: ProviderBindingSummary[];
  warnings: string[];
}

export interface RuntimeDependencies extends RuntimeAssemblyDiagnostics {
  llmProvider: LlmProvider;
  tools: ToolRegistry;
}

const ENV_KEYS = {
  mapMode: ["MAP_MODE", "VITE_MAP_MODE"],
  mapProvider: ["MAP_PROVIDER", "VITE_MAP_PROVIDER"],
  llmProvider: ["LLM_PROVIDER", "VITE_LLM_PROVIDER"],
  enableForeignMapExperiments: [
    "ENABLE_FOREIGN_MAP_EXPERIMENTS",
    "VITE_ENABLE_FOREIGN_MAP_EXPERIMENTS"
  ],
  strictProviderConfig: ["STRICT_PROVIDER_CONFIG", "VITE_STRICT_PROVIDER_CONFIG"]
} as const;

const MAP_CREDENTIAL_ENV: Record<RuntimeConfig["mapProvider"], string | null> = {
  tianditu: "TIANDITU_API_KEY",
  amap: "AMAP_API_KEY",
  mapbox: "MAPBOX_ACCESS_TOKEN",
  osm: null
};

const LLM_CREDENTIAL_ENV: Record<RuntimeConfig["llmProvider"], string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY"
};

function readEnvValue(env: EnvSource, keys: readonly string[]) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }

    if (typeof value === "boolean") {
      return String(value);
    }
  }

  return undefined;
}

function parseBoolean(input: string | undefined, fallback: boolean) {
  if (input === undefined) {
    return fallback;
  }

  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function hasCredential(env: EnvSource, key: string) {
  return typeof env[key] === "string" && String(env[key]).trim().length > 0;
}

export function resolveRuntimeDefaults(env: EnvSource = {}): RuntimeConfig {
  return runtimeConfigSchema.parse({
    mapMode: readEnvValue(env, ENV_KEYS.mapMode),
    mapProvider: readEnvValue(env, ENV_KEYS.mapProvider),
    llmProvider: readEnvValue(env, ENV_KEYS.llmProvider),
    enableForeignMapExperiments: parseBoolean(
      readEnvValue(env, ENV_KEYS.enableForeignMapExperiments),
      false
    )
  });
}

export function describeRuntimeAssembly(
  runtimeInput: RuntimeConfig,
  env: EnvSource = {}
): RuntimeAssemblyDiagnostics {
  const runtime = runtimeConfigSchema.parse(runtimeInput);
  const strictProviderConfig = parseBoolean(
    readEnvValue(env, ENV_KEYS.strictProviderConfig),
    false
  );
  const warnings: string[] = [];
  const mapCredentialEnvVar = MAP_CREDENTIAL_ENV[runtime.mapProvider];
  const llmCredentialEnvVar = LLM_CREDENTIAL_ENV[runtime.llmProvider];

  const bindings: ProviderBindingSummary[] = [];

  const llmCredentialReady = hasCredential(env, llmCredentialEnvVar);
  if (!llmCredentialReady && strictProviderConfig) {
    throw new Error(
      `Strict provider config requires ${llmCredentialEnvVar} for LLM provider "${runtime.llmProvider}".`
    );
  }

  bindings.push({
    kind: "llm",
    providerId: runtime.llmProvider,
    adapterMode: llmCredentialReady ? "credential_ready_placeholder" : "requires_configuration",
    credentialEnvVar: llmCredentialEnvVar,
    message: llmCredentialReady
      ? runtime.llmProvider === "openai"
        ? `${llmCredentialEnvVar} 已提供。当前仓库按 OpenAI-compatible 抽象保留同一接口层。`
        : `${llmCredentialEnvVar} 已提供。当前仓库仍通过占位 adapter 走同一抽象层，后续可直接替换为真实 SDK。`
      : runtime.llmProvider === "openai"
        ? `${llmCredentialEnvVar} 未提供，OpenAI-compatible LLM 路线当前需要补充真实服务配置。`
        : `${llmCredentialEnvVar} 未提供，当前需要补充真实 LLM 服务配置。`
  });

  if (!llmCredentialReady) {
    warnings.push(`${llmCredentialEnvVar} 未配置，LLM provider 当前不可用。`);
  }

  const mapProviderOption = listMapProviders(runtime).find(
    (provider) => provider.id === runtime.mapProvider
  );
  if (!mapProviderOption?.enabled) {
    warnings.push(mapProviderOption?.reason ?? "当前 map provider 不可用。");
  }

  const mapCredentialReady =
    mapCredentialEnvVar === null ? true : hasCredential(env, mapCredentialEnvVar);
  if (!mapCredentialReady && strictProviderConfig) {
    throw new Error(
      `Strict provider config requires ${mapCredentialEnvVar} for map provider "${runtime.mapProvider}".`
    );
  }

  bindings.push({
    kind: "map",
    providerId: runtime.mapProvider,
    adapterMode:
      runtime.mapProvider === "osm"
        ? "public_access"
        : mapCredentialReady
          ? "credential_ready_placeholder"
          : "requires_configuration",
    credentialEnvVar: mapCredentialEnvVar,
    message:
      runtime.mapProvider === "osm"
        ? "OpenStreetMap 当前按公开访问方式接入，仅在 internal 或 experimental 模式下作为实验参考底图开放。"
        : mapCredentialReady
      ? `${mapCredentialEnvVar} 已提供，地图服务可按当前 provider 抽象接入。`
      : `${mapCredentialEnvVar} 未提供，当前 map provider 需要补充真实服务配置。`
  });

  if (!mapCredentialReady && mapCredentialEnvVar !== null) {
    warnings.push(`${mapCredentialEnvVar} 未配置，当前 map provider 不可用。`);
  }

  return {
    runtime,
    strictProviderConfig,
    bindings,
    warnings
  };
}

export function createRuntimeDependencies(
  runtimeInput: RuntimeConfig,
  env: EnvSource = {}
): RuntimeDependencies {
  const diagnostics = describeRuntimeAssembly(runtimeInput, env);

  return {
    ...diagnostics,
    llmProvider: createLlmProvider(diagnostics.runtime.llmProvider),
    tools: createToolRegistry()
  };
}

export function parseServerEnv(env: EnvSource = {}) {
  return z.object({
    runtimeDefaults: runtimeConfigSchema,
    strictProviderConfig: z.boolean()
  }).parse({
    runtimeDefaults: resolveRuntimeDefaults(env),
    strictProviderConfig: parseBoolean(readEnvValue(env, ENV_KEYS.strictProviderConfig), false)
  });
}
