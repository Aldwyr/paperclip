import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyDevRunnerOptions } from "../dev-runner-options.ts";

describe("applyDevRunnerOptions", () => {
  it("turns --data-dir into an isolated Paperclip home and consumes the option", () => {
    const env: NodeJS.ProcessEnv = {};
    const cwd = path.join(os.tmpdir(), "paperclip-dev-runner-options");

    const result = applyDevRunnerOptions(
      ["--bind", "loopback", "--data-dir", "./tmp", "--future-option"],
      env,
      cwd,
    );

    const expectedHome = path.resolve(cwd, "tmp");
    expect(result).toEqual({
      forwardedArgs: ["--bind", "loopback", "--future-option"],
      dataDir: expectedHome,
    });
    expect(env.PAPERCLIP_HOME).toBe(expectedHome);
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("default");
    expect(env.PAPERCLIP_CONFIG).toBe(
      path.join(expectedHome, "instances", "default", "config.json"),
    );
  });

  it.each([
    ["short option", ["-d", "~/paperclip-dev"]],
    ["equals form", ["--data-dir=~/paperclip-dev"]],
  ])("supports the %s", (_label, args) => {
    const env: NodeJS.ProcessEnv = {};

    const result = applyDevRunnerOptions(args, env, "/unused");

    expect(result.forwardedArgs).toEqual([]);
    expect(result.dataDir).toBe(path.join(os.homedir(), "paperclip-dev"));
  });

  it("preserves an explicit config while overriding the home", () => {
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_CONFIG: "/explicit/config.json",
      PAPERCLIP_INSTANCE_ID: "experiment",
    };

    applyDevRunnerOptions(["--data-dir", "/isolated/home"], env, "/unused");

    expect(env.PAPERCLIP_HOME).toBe("/isolated/home");
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("experiment");
    expect(env.PAPERCLIP_CONFIG).toBe("/explicit/config.json");
  });

  it.each([["--data-dir"], ["-d"], ["--data-dir="]])(
    "rejects a missing value for %s",
    (...args) => {
      expect(() => applyDevRunnerOptions(args, {}, "/unused")).toThrow(/requires a value/);
    },
  );
});
