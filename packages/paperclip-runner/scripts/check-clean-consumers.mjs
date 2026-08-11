import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evalKernelRoot = resolve(runnerRoot, "../paperclip-eval-kernel");
const scratchParent = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  ?? process.env.PAPERCLIP_SCRATCH_DIR
  ?? tmpdir();
await mkdir(scratchParent, { recursive: true });
const scratchRoot = await mkdtemp(join(scratchParent, "paperclip-package-consumers-"));
const artifactsRoot = resolve(scratchRoot, "artifacts");
await mkdir(artifactsRoot, { recursive: true });

try {
  run("pnpm", ["run", "build:typescript"], runnerRoot);
  run("pnpm", ["run", "build"], evalKernelRoot);
  const runnerTarball = await pack(runnerRoot, artifactsRoot);
  const evalKernelTarball = await pack(evalKernelRoot, artifactsRoot);
  const runtimeDependencyTarballs = await packRunnerRuntimeDependencies(artifactsRoot);

  await verifyEvalsConsumer(
    resolve(scratchRoot, "evals-consumer"),
    runnerTarball,
    runtimeDependencyTarballs,
  );
  await verifyAppDevConsumer(
    resolve(scratchRoot, "app-dev-consumer"),
    runnerTarball,
    evalKernelTarball,
    runtimeDependencyTarballs,
  );

  const runnerManifest = JSON.parse(await readFile(resolve(runnerRoot, "package.json"), "utf8"));
  const runtimeDependencies = {
    ...(runnerManifest.dependencies ?? {}),
    ...(runnerManifest.optionalDependencies ?? {}),
    ...(runnerManifest.peerDependencies ?? {}),
  };
  if ("@paperclipai/paperclip-eval-kernel" in runtimeDependencies) {
    throw new Error("runner tarball has a runtime dependency on Paperclip Evals");
  }
  process.stdout.write("Clean-consumer pack/install checks passed for Evals -> App and App dev -> eval kernel.\n");
} finally {
  if (process.env.PAPERCLIP_KEEP_PACKAGE_CONSUMERS !== "1") {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`Kept clean-consumer scratch at ${scratchRoot}\n`);
  }
}

async function pack(packageRoot, destination) {
  const before = new Set(await readdir(destination));
  run("pnpm", ["pack", "--pack-destination", destination], packageRoot, { quiet: true });
  const created = (await readdir(destination))
    .filter((entry) => entry.endsWith(".tgz") && !before.has(entry))
    .sort();
  if (created.length !== 1) {
    throw new Error(`Expected one tarball from ${packageRoot}, found ${created.join(", ") || "none"}`);
  }
  return resolve(destination, created[0]);
}

async function packRunnerRuntimeDependencies(destination) {
  const ajvRoot = resolve(runnerRoot, "node_modules/ajv");
  const ajvModules = dirname(await realpath(ajvRoot));
  const packageNames = [
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ];
  const tarballs = {};
  for (const packageName of packageNames) {
    const packageRoot = packageName === "ajv" ? ajvRoot : resolve(ajvModules, packageName);
    tarballs[packageName] = await pack(packageRoot, destination);
  }
  return tarballs;
}

function localOverrides(tarballs) {
  return Object.fromEntries(
    Object.entries(tarballs).map(([packageName, tarball]) => [packageName, `file:${tarball}`]),
  );
}

async function verifyEvalsConsumer(consumerRoot, runnerTarball, runtimeDependencyTarballs) {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, "package.json"), `${JSON.stringify({
    name: "paperclip-evals-clean-consumer",
    private: true,
    type: "module",
    packageManager: "pnpm@9.15.4",
    dependencies: {
      "@paperclipai/paperclip-runner": `file:${runnerTarball}`,
    },
    pnpm: { overrides: localOverrides(runtimeDependencyTarballs) },
  }, null, 2)}\n`);
  await writeFile(resolve(consumerRoot, "verify.mjs"), `
import * as runtime from "@paperclipai/paperclip-runner";
import * as testing from "@paperclipai/paperclip-runner/testing";

if ("MockControlPlaneAdapter" in runtime || "runControlPlanePortConformance" in runtime) {
  throw new Error("test helpers leaked through the runtime root");
}
if (typeof testing.MockControlPlaneAdapter !== "function") {
  throw new Error("deterministic mock is absent from ./testing");
}
const adapter = new testing.MockControlPlaneAdapter();
const report = await testing.runControlPlanePortConformance({
  port: adapter,
  start: () => adapter.start(),
  stop: () => adapter.stop(),
});
if (report.eventCount !== 3) throw new Error("packed conformance kit returned the wrong event count");

runtime.assertPaperclipRunnerCompatibility({
  consumer: "paperclip-evals-clean-consumer",
  components: { catalog: 1, protocol: 1, runnerClient: 1, controlPlaneAdapter: 1, testkit: 1 },
  evalCorpusVersion: 1,
  requiredOperationIds: ["finish_task"],
  provider: { id: "clean-provider", supportedOperationIds: ["finish_task"] },
});
let failedExplicitly = false;
try {
  runtime.assertPaperclipRunnerCompatibility({
    consumer: "incompatible-provider",
    requiredOperationIds: ["finish_task"],
    provider: { id: "missing-finish", supportedOperationIds: [] },
  });
} catch (error) {
  failedExplicitly = error?.code === "paperclip_runner_incompatible"
    && error.issues?.[0]?.code === "provider_operation_unsupported";
}
if (!failedExplicitly) throw new Error("provider incompatibility did not fail explicitly");

const normalized = {
  authorization: { outcome: "allowed" },
  state: { status: "done" },
  effects: [],
  audit: [],
};
await testing.runSemanticConformanceKit({
  vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
  adapters: [
    { id: "mock", execute: async () => normalized },
    { id: "real", execute: async () => ({ audit: [], effects: [], state: { status: "done" }, authorization: { outcome: "allowed" } }) },
  ],
});
`);
  installAndRun(consumerRoot);
}

async function verifyAppDevConsumer(
  consumerRoot,
  runnerTarball,
  evalKernelTarball,
  runtimeDependencyTarballs,
) {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, "package.json"), `${JSON.stringify({
    name: "paperclip-app-dev-clean-consumer",
    private: true,
    type: "module",
    packageManager: "pnpm@9.15.4",
    dependencies: {
      "@paperclipai/paperclip-runner": `file:${runnerTarball}`,
    },
    devDependencies: {
      "@paperclipai/paperclip-eval-kernel": `file:${evalKernelTarball}`,
    },
    pnpm: { overrides: localOverrides(runtimeDependencyTarballs) },
  }, null, 2)}\n`);
  await writeFile(resolve(consumerRoot, "verify.mjs"), `
import {
  assertPaperclipRunnerCompatibility,
} from "@paperclipai/paperclip-runner";
import {
  PAPERCLIP_EVAL_KERNEL_COMPATIBILITY,
  runPaperclipEvalMatrix,
} from "@paperclipai/paperclip-eval-kernel";

if (PAPERCLIP_EVAL_KERNEL_COMPATIBILITY.apiVersion !== 1) {
  throw new Error("unexpected eval-kernel API version");
}
const results = await runPaperclipEvalMatrix({
  scenarios: [{ id: "finish", input: { expected: "done" } }],
  candidates: [{
    id: "runner-v1",
    config: { result: "done" },
    preflight: () => assertPaperclipRunnerCompatibility({
      consumer: "paperclip-app-dev-clean-consumer",
      components: { catalog: 1, protocol: 1, runnerClient: 1, controlPlaneAdapter: 1, testkit: 1 },
      evalCorpusVersion: 1,
      requiredOperationIds: ["finish_task"],
      provider: { id: "clean-provider", supportedOperationIds: ["finish_task"] },
    }),
  }],
  execute: async ({ candidate }) => candidate.config.result,
  score: ({ scenario, output }) => ({ passed: output === scenario.input.expected }),
});
if (results.length !== 1 || results[0].score.passed !== true) {
  throw new Error("packed eval kernel did not execute the dev-only matrix");
}
`);
  installAndRun(consumerRoot);
}

function installAndRun(consumerRoot) {
  run("pnpm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--lockfile=false",
    "--store-dir",
    resolve(consumerRoot, ".pnpm-store"),
    "--config.auto-install-peers=false",
    "--reporter=append-only",
  ], consumerRoot, { env: { NODE_ENV: "development" } });
  run(process.execPath, ["verify.mjs"], consumerRoot);
}

function run(command, args, cwd, { quiet = false, env = {} } = {}) {
  const usesPnpm = command === "pnpm";
  const executable = usesPnpm
    ? (process.platform === "win32" ? "corepack.cmd" : "corepack")
    : command;
  const effectiveArgs = usesPnpm ? ["pnpm@9.15.4", ...args] : args;
  const result = spawnSync(executable, effectiveArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...env },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    ...(quiet ? { maxBuffer: 32 * 1024 * 1024 } : {}),
  });
  if (result.status !== 0) {
    if (quiet) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    if (result.error !== undefined) process.stderr.write(`${String(result.error)}\n`);
    if (result.signal !== null) process.stderr.write(`Terminated by signal ${result.signal}\n`);
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}
