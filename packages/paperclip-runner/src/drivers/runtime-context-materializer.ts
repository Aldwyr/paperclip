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

export async function materializeNativeRuntimeSkills(context: NativeRuntimeContextSnapshot | null, skillsHome: string): Promise<void> {
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
  if (input.nativeMcp) {
    await writeFile(join(input.codexHome, "config.toml"), [
      `[mcp_servers.${JSON.stringify(input.nativeMcp.name)}]`,
      `url = ${JSON.stringify(input.nativeMcp.url)}`,
      `http_headers = { Authorization = ${JSON.stringify(`Bearer ${input.nativeMcp.token}`)} }`,
      "",
    ].join("\n"), { mode: 0o600 });
  }
  const sourceHome = input.sourceCodexHome?.trim();
  if (!sourceHome) return;
  const sourceAuth = join(sourceHome, "auth.json");
  const stat = await lstat(sourceAuth).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) return;
  await copyFile(sourceAuth, join(input.codexHome, "auth.json"));
  await chmod(join(input.codexHome, "auth.json"), 0o600);
}
