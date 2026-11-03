import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts resolves its search paths at import time and ends with the
// package-root config.yaml (which exists in this repo). Mocking fs is the
// only way to test the "no file present" default deterministically. The fake
// file is registered at the loader's first search path: cwd/config.yaml.
const state = vi.hoisted(() => ({
  configPath: undefined as string | undefined,
  content: "",
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: (path: string | URL): boolean =>
      state.configPath !== undefined && String(path) === state.configPath,
    readFileSync: (path: string | URL): string => {
      if (state.configPath !== undefined && String(path) === state.configPath) {
        return state.content;
      }
      throw new Error(`unexpected config read: ${String(path)}`);
    },
  };
});

import { resolveConfig } from "../src/config";

function useFile(content: string): void {
  state.configPath = resolve(process.cwd(), "config.yaml");
  state.content = content;
}

function clearEnv(): void {
  delete process.env.DOCWORM_API_KEY;
  delete process.env.DOCWORM_URL;
}

beforeEach(() => {
  state.configPath = undefined;
  state.content = "";
  clearEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearEnv();
});

describe("resolveConfig precedence", () => {
  it("falls back to the hosted defaults when nothing is set", () => {
    expect(resolveConfig({})).toEqual({
      api_key: "",
      base_url: "https://docworm.web.app",
    });
  });

  it("uses environment variables over the defaults", () => {
    vi.stubEnv("DOCWORM_API_KEY", "env-key");
    vi.stubEnv("DOCWORM_URL", "https://env.example.test");
    expect(resolveConfig({})).toEqual({
      api_key: "env-key",
      base_url: "https://env.example.test",
    });
  });

  it("uses constructor snake_case overrides over the environment", () => {
    vi.stubEnv("DOCWORM_API_KEY", "env-key");
    vi.stubEnv("DOCWORM_URL", "https://env.example.test");
    expect(
      resolveConfig({
        api_key: "ctor-key",
        base_url: "https://ctor.example.test",
      }),
    ).toEqual({
      api_key: "ctor-key",
      base_url: "https://ctor.example.test",
    });
  });

  it("accepts the camelCase aliases over the environment", () => {
    vi.stubEnv("DOCWORM_API_KEY", "env-key");
    vi.stubEnv("DOCWORM_URL", "https://env.example.test");
    expect(
      resolveConfig({
        apiKey: "alias-key",
        baseUrl: "https://alias.example.test",
      }),
    ).toEqual({
      api_key: "alias-key",
      base_url: "https://alias.example.test",
    });
  });

  it("reads api_key and base_url from the config file", () => {
    useFile("api_key: file-key\nbase_url: https://file.example.test\n");
    expect(resolveConfig({})).toEqual({
      api_key: "file-key",
      base_url: "https://file.example.test",
    });
  });

  it("lets the environment override the config file", () => {
    useFile("api_key: file-key\nbase_url: https://file.example.test\n");
    vi.stubEnv("DOCWORM_API_KEY", "env-key");
    expect(resolveConfig({})).toEqual({
      api_key: "env-key",
      base_url: "https://file.example.test",
    });
  });

  it("lets constructor arguments override file and environment", () => {
    useFile("api_key: file-key\nbase_url: https://file.example.test\n");
    vi.stubEnv("DOCWORM_API_KEY", "env-key");
    vi.stubEnv("DOCWORM_URL", "https://env.example.test");
    expect(
      resolveConfig({ api_key: "ctor-key", base_url: "https://ctor.example.test" }),
    ).toEqual({
      api_key: "ctor-key",
      base_url: "https://ctor.example.test",
    });
  });

  it("counts an empty override as absent and falls through", () => {
    vi.stubEnv("DOCWORM_API_KEY", "env-key");
    expect(resolveConfig({ api_key: "" }).api_key).toBe("env-key");
  });
});

describe("resolveConfig config-file parsing", () => {
  it("ignores comments and blank lines, trims keys and values", () => {
    useFile(
      [
        "# DocWorm config",
        "",
        "   ",
        "  api_key :   file-key   ",
        "base_url: https://file.example.test",
        "",
      ].join("\n"),
    );
    expect(resolveConfig({})).toEqual({
      api_key: "file-key",
      base_url: "https://file.example.test",
    });
  });

  it("strips matching single and double quotes", () => {
    useFile('api_key: "double"\nbase_url: \'https://single.example.test\'\n');
    expect(resolveConfig({})).toEqual({
      api_key: "double",
      base_url: "https://single.example.test",
    });
  });

  it("skips ${VAR} references", () => {
    useFile("api_key: ${DOCWORM_API_KEY}\nbase_url: https://file.example.test\n");
    expect(resolveConfig({})).toEqual({
      api_key: "",
      base_url: "https://file.example.test",
    });
  });

  it("skips lines without a colon", () => {
    useFile("not a pair\napi_key: file-key\n");
    expect(resolveConfig({}).api_key).toBe("file-key");
  });

  it("keeps colons inside the value", () => {
    useFile("base_url: https://file.example.test:8443\n");
    expect(resolveConfig({}).base_url).toBe(
      "https://file.example.test:8443",
    );
  });
});

describe("resolveConfig trailing slashes", () => {
  it("strips exactly one trailing slash", () => {
    expect(resolveConfig({ base_url: "https://x.example.test///" }).base_url).toBe(
      "https://x.example.test//",
    );
  });

  it("leaves a slash-free URL untouched", () => {
    expect(resolveConfig({ base_url: "https://x.example.test" }).base_url).toBe(
      "https://x.example.test",
    );
  });

  it("does not rewrite the api key", () => {
    expect(resolveConfig({ api_key: "dw_live_key/" }).api_key).toBe(
      "dw_live_key/",
    );
  });
});
