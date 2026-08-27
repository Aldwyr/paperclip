import { chmod, copyFile, cp, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import type { NativeMcpLaunchBinding } from "./native-mcp.js";

async function assertSafeTree(root: string, relative = ""): Promise<void> {
  for (const entry of await readdir(relative ? join(root, relative) : root, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const stat = await lstat(join(root, childRelative));
    if (stat.isSymbolicLink()) throw new Error(`runtime context asset contains a symlink: ${childRelative}`);
    if (stat.isDirectory()) await assertSafeTree(root, childRelative);
    else if (!stat.isFile()) throw new Error(`runtime context asset contains an unsupported file: ${childRelative}`);
  }
}
async function makeReadOnly(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) await makeReadOnly(child);
    else await chmod(child, (await lstat(child)).mode & 0o555);
  }
  await chmod(root, 0o555);
}

async function makeWritableForRemoval(root: string): Promise<void> {
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) {
      await makeWritableForRemoval(join(root, entry));
    }
  } else if (stat.isFile()) {
    await chmod(root, 0o600);
  }
}

export async function materializeNativeRuntimeSkills(context: NativeRuntimeContextSnapshot | null, skillsHome: string): Promise<void> {
  await makeWritableForRemoval(skillsHome);
  await rm(skillsHome, { recursive: true, force: true });
  await mkdir(skillsHome, { recursive: true, mode: 0o700 });
  if (!context) return;
  for (const skill of context.skills) {
    await assertSafeTree(skill.bundle.rootPath);
    const target = join(skillsHome, skill.runtimeName);
    await cp(skill.bundle.rootPath, target, { recursive: true, force: false, errorOnExist: true });
    await makeReadOnly(target);
  }
}

export async function prepareIsolatedCodexHome(input: { context: NativeRuntimeContextSnapshot | null; codexHome: string; sourceCodexHome?: string | null; nativeMcp?: NativeMcpLaunchBinding | null }): Promise<void> {
  await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
  await chmod(input.codexHome, 0o700);
  await materializeNativeRuntimeSkills(input.context, join(input.codexHome, "skills"));
  await rm(join(input.codexHome, "config.toml"), { force: true });
  await writeFile(join(input.codexHome, "config.toml"), [
    // Codex shell snapshots serialize the provider process environment. Native
    // Codex receives API-key credentials only through that environment, so a
    // snapshot would turn an ephemeral credential into durable session state.
    "[features]",
    "shell_snapshot = false",
    "",
    ...(input.nativeMcp ? [
      `[mcp_servers.${JSON.stringify(input.nativeMcp.name)}]`,
      `url = ${JSON.stringify(input.nativeMcp.url)}`,
      `http_headers = { Authorization = ${JSON.stringify(`Bearer ${input.nativeMcp.token}`)} }`,
      "",
    ] : []),
  ].join("\n"), { mode: 0o600 });
  const targetAuth = join(input.codexHome, "auth.json");
  await rm(targetAuth, { force: true });
  const sourceHome = input.sourceCodexHome?.trim();
  if (!sourceHome) return;
  const sourceAuth = join(sourceHome, "auth.json");
  const stat = await lstat(sourceAuth).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) return;
  await copyFile(sourceAuth, targetAuth);
  await chmod(targetAuth, 0o600);
}
