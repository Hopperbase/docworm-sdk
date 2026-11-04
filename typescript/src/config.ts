/**
 * DocWorm SDK Configuration Loader.
 *
 * Loads config from, in priority order (highest first):
 *   1. Constructor arguments
 *   2. Environment variables (DOCWORM_API_KEY, DOCWORM_URL)
 *   3. config.yaml file (optional)
 *
 * Auth accepts a DocWorm API key (dw_live_...), sent as X-API-KEY, or a
 * bearer token, sent as Authorization: Bearer.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const CONFIG_FILENAME = "config.yaml";

function packageRootConfig(): string {
  // __dirname in CJS builds, import.meta.dirname in ESM (Node >= 20.11).
  const here =
    typeof __dirname !== "undefined"
      ? (__dirname as string)
      : (import.meta as unknown as { dirname: string }).dirname;
  return resolve(here, "..", "..", CONFIG_FILENAME);
}

const CONFIG_SEARCH_PATHS = [
  resolve(process.cwd(), CONFIG_FILENAME),
  resolve(homedir(), ".config", "docworm", CONFIG_FILENAME),
  resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "docworm", CONFIG_FILENAME),
  packageRootConfig(),
];

interface RawConfig {
  api_key?: string;
  base_url?: string;
}

function findConfigFile(): string | undefined {
  for (const p of CONFIG_SEARCH_PATHS) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function loadConfigFile(): RawConfig {
  const path = findConfigFile();
  if (!path) return {};

  try {
    const content = readFileSync(path, "utf-8");
    const config: RawConfig = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();

      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Skip env-var references like ${VAR}
      if (value.startsWith("${")) continue;

      if (key && value) {
        (config as Record<string, string>)[key] = value;
      }
    }

    return config;
  } catch {
    return {};
  }
}

export interface DocWormConfig {
  base_url?: string;
  api_key?: string;
  /** camelCase alias for api_key */
  apiKey?: string;
  /** camelCase alias for base_url */
  baseUrl?: string;
}

export function resolveConfig(
  overrides: DocWormConfig = {},
): Required<Pick<DocWormConfig, "base_url" | "api_key">> {
  const fileConfig = loadConfigFile();

  return {
    api_key:
      overrides.api_key ||
      overrides.apiKey ||
      process.env.DOCWORM_API_KEY ||
      fileConfig.api_key ||
      "",
    base_url: (
      overrides.base_url ||
      overrides.baseUrl ||
      process.env.DOCWORM_URL ||
      fileConfig.base_url ||
      "https://docworm.web.app"
    ).replace(/\/$/, ""),
  };
}
