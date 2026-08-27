import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
import { prepareIsolatedCodexHome } from "./runtime-context-materializer.js";

const roots: string[] = [];
async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await makeWritable(join(root, entry));
  } else {
    await chmod(root, 0o600);
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});
function context(skillRoot: string, instructionRoot: string, runtimeName = "assigned"): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: instructionRoot, fileCount: 2, totalBytes: 2 },
    },
    skills: [{
      key: `company/${runtimeName}`,
      runtimeName,
      versionId: "version-1",
      bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: skillRoot, fileCount: 2, totalBytes: 2 },
    }],
    mcp: { assignmentSetId: runtimeName, digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
}

describe("runtime context materialization", () => {
  it("copies only assigned skills with their supporting files and an isolated MCP config", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-context-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const instructions = join(root, "instructions-source");
    const hostSkills = join(root, "host-home", "skills", "unassigned");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(join(assigned, "references"), { recursive: true }), mkdir(instructions), mkdir(hostSkills, { recursive: true })]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\nRead references/support.md\n");
    await writeFile(join(assigned, "references", "support.md"), "support\n");
    await writeFile(join(instructions, "AGENTS.md"), "Read sibling.md\n");
    await writeFile(join(instructions, "sibling.md"), "sibling\n");
    await writeFile(join(hostSkills, "SKILL.md"), "# Must not leak\n");

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
      sourceCodexHome: join(root, "host-home"),
      nativeMcp: { name: "paperclip-assigned", url: "https://paperclip.example/mcp", token: "x".repeat(40) },
    });

    await expect(readFile(join(codexHome, "skills", "assigned", "references", "support.md"), "utf8")).resolves.toBe("support\n");
    await expect(stat(join(codexHome, "skills", "unassigned"))).rejects.toThrow();
    expect((await stat(join(codexHome, "skills", "assigned", "SKILL.md"))).mode & 0o222).toBe(0);
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("shell_snapshot = false");
    expect(config).toContain("paperclip-assigned");
    expect(config).toContain("Bearer ");
    expect(config).not.toContain("unassigned");
  });

  it("prepares the same isolated Codex home twice and keeps staged skills read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-context-repeat-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const instructions = join(root, "instructions-source");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(join(assigned, "references"), { recursive: true }), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(assigned, "references", "support.md"), "support\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    const runtimeContext = context(assigned, instructions);
    for (const token of ["a".repeat(40), "b".repeat(40)]) {
      await prepareIsolatedCodexHome({
        context: runtimeContext,
        codexHome,
        nativeMcp: { name: "paperclip-assigned", url: "https://paperclip.example/mcp", token },
      });

      expect((await stat(join(codexHome, "skills", "assigned"))).mode & 0o222).toBe(0);
      expect((await stat(join(codexHome, "skills", "assigned", "SKILL.md"))).mode & 0o222).toBe(0);
      expect((await stat(join(codexHome, "skills", "assigned", "references", "support.md"))).mode & 0o222).toBe(0);
    }
  });

  it("does not materialize an API key into the isolated Codex home", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-context-api-key-"));
    roots.push(root);
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "stale-persisted-key" }),
      { mode: 0o600 },
    );

    await prepareIsolatedCodexHome({
      context: null,
      codexHome,
    });

    await expect(stat(join(codexHome, "auth.json"))).rejects.toThrow();
    await expect(readFile(join(codexHome, "config.toml"), "utf8")).resolves.toContain(
      "shell_snapshot = false",
    );
  });

  it("reconciles changed and empty assignments without following unexpected symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runtime-context-reconcile-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const replacement = join(root, "replacement-source");
    const instructions = join(root, "instructions-source");
    const externalTarget = join(root, "external-target.txt");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(replacement), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(replacement, "SKILL.md"), "# Replacement\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");
    await writeFile(externalTarget, "must remain unchanged\n", { mode: 0o640 });

    await prepareIsolatedCodexHome({ context: context(assigned, instructions), codexHome });
    const externalMode = (await stat(externalTarget)).mode;
    await symlink(externalTarget, join(codexHome, "skills", "unexpected-link"));

    await prepareIsolatedCodexHome({
      context: context(replacement, instructions, "replacement"),
      codexHome,
    });

    await expect(stat(join(codexHome, "skills", "assigned"))).rejects.toThrow();
    await expect(lstat(join(codexHome, "skills", "unexpected-link"))).rejects.toThrow();
    await expect(readFile(externalTarget, "utf8")).resolves.toBe("must remain unchanged\n");
    expect((await stat(externalTarget)).mode).toBe(externalMode);
    expect((await stat(join(codexHome, "skills", "replacement"))).mode & 0o222).toBe(0);
    expect((await stat(join(codexHome, "skills", "replacement", "SKILL.md"))).mode & 0o222).toBe(0);

    await prepareIsolatedCodexHome({ context: null, codexHome });
    await expect(readdir(join(codexHome, "skills"))).resolves.toEqual([]);
  });
});
