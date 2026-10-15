import { describe, expect, test } from "bun:test";

import {
  parseTuxBattleBaseUrl,
  resolveTuxLinkConfig,
} from "../tools/tux-link-config.ts";

describe("Tux Link build URL", () => {
  test("canonicalizes a path prefix and preserves an explicit port", () => {
    expect(parseTuxBattleBaseUrl("https://Battle.Example:8443/proxy/v1"))
      .toEqual({
        httpBase: "https://battle.example:8443/proxy/v1/",
        wsBase: "wss://battle.example:8443/proxy/v1/",
        trustedReplayBase: "https://battle.example:8443/proxy/v1/tux/v1/replays/",
      });

    expect(parseTuxBattleBaseUrl("https://battle.example:443"))
      .toEqual({
        httpBase: "https://battle.example:443/",
        wsBase: "wss://battle.example:443/",
        trustedReplayBase: "https://battle.example:443/tux/v1/replays/",
      });
  });

  test("normalizes dot segments and exactly one trailing path separator", () => {
    expect(parseTuxBattleBaseUrl("https://battle.example/gateway/old/../api///"))
      .toEqual({
        httpBase: "https://battle.example/gateway/api/",
        wsBase: "wss://battle.example/gateway/api/",
        trustedReplayBase: "https://battle.example/gateway/api/tux/v1/replays/",
      });
  });

  test("allows HTTP only on the specified loopback hosts", () => {
    expect(parseTuxBattleBaseUrl("http://localhost:8080/dev").wsBase)
      .toBe("ws://localhost:8080/dev/");
    expect(parseTuxBattleBaseUrl("http://127.0.0.1").httpBase)
      .toBe("http://127.0.0.1/");
    expect(parseTuxBattleBaseUrl("http://127.255.12.9:80/base").httpBase)
      .toBe("http://127.255.12.9:80/base/");
    expect(parseTuxBattleBaseUrl("http://[::1]:9090").trustedReplayBase)
      .toBe("http://[::1]:9090/tux/v1/replays/");
  });

  test("rejects plaintext production and loopback-lookalike hosts", () => {
    for (const value of [
      "http://battle.example",
      "http://localhost.example",
      "http://127.example",
      "http://128.0.0.1",
      "http://[::ffff:127.0.0.1]",
    ]) {
      expect(() => parseTuxBattleBaseUrl(value), value).toThrow(/HTTP is allowed only/);
    }
  });

  test("rejects non-absolute URLs and authority or suffix injection", () => {
    for (const value of [
      "battle.example",
      "//battle.example",
      "ftp://battle.example",
      "https:battle.example",
      "https://user@battle.example",
      "https://user:secret@battle.example",
      "https://@battle.example",
      "https://battle.example?redirect=https://evil.example",
      "https://battle.example/#https://evil.example",
      "https://battle.example\\@evil.example",
      " https://battle.example",
      "https://battle.example\n",
      "https://battle.example:",
      "https://battle.example:65536",
    ]) {
      expect(() => parseTuxBattleBaseUrl(value), value).toThrow();
    }
  });

  test("returns null when absent and reads the explicit environment object", () => {
    expect(resolveTuxLinkConfig([], {})).toBeNull();
    expect(resolveTuxLinkConfig(["--unrelated"], { OTHER: "https://ignored.example" }))
      .toBeNull();
    expect(resolveTuxLinkConfig([], {
      TUX_BATTLE_BASE_URL: "https://env.example/service",
    })?.httpBase).toBe("https://env.example/service/");
  });

  test("supports both CLI forms and CLI overrides the environment", () => {
    const env = { TUX_BATTLE_BASE_URL: "https://env.example" };
    expect(resolveTuxLinkConfig(["--tux-battle-url=https://cli.example/prefix"], env)?.httpBase)
      .toBe("https://cli.example/prefix/");
    expect(resolveTuxLinkConfig(["--tux-battle-url", "https://two-arg.example:9443/root"], env)?.wsBase)
      .toBe("wss://two-arg.example:9443/root/");
  });

  test("fails closed on missing, empty, duplicate, or invalid selected values", () => {
    expect(() => resolveTuxLinkConfig(["--tux-battle-url"], {})).toThrow(/requires a value/);
    expect(() => resolveTuxLinkConfig(["--tux-battle-url="], {})).toThrow(/requires a value/);
    expect(() => resolveTuxLinkConfig(["--tux-battle-url", "--other"], {})).toThrow(/requires a value/);
    expect(() => resolveTuxLinkConfig([
      "--tux-battle-url=https://one.example",
      "--tux-battle-url=https://two.example",
    ], {})).toThrow(/only once/);
    expect(() => resolveTuxLinkConfig([], { TUX_BATTLE_BASE_URL: "" })).toThrow(/must not be empty/);
    expect(() => resolveTuxLinkConfig([], { TUX_BATTLE_BASE_URL: "http://production.example" }))
      .toThrow(/HTTP is allowed only/);
  });
});
