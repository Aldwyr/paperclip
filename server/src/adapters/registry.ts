import type {
  AdapterModelProfileDefinition,
  AdapterRuntimeCommandSpec,
  ServerAdapterModule,
} from "./types.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AcpxRuntimeHost,
  inspectQualifiedAcpxInstallation,
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "../vendor/paperclip-runner/index.js";
import { parseAdapterModelsEnv } from "../services/adapter-models-env.js";
import { stampClaudeAgentIdHeader } from "./claude-agent-id-header.js";
import {
  buildSandboxNpmInstallCommand,
  getAdapterSessionManagement,
} from "@paperclipai/adapter-utils";
import type { AdapterLoginCapability } from "@paperclipai/adapter-utils";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  refreshClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
  readClaudeAuthStatus,
  getConfigSchema as getClaudeConfigSchema,
  CLAUDE_SETUP_TOKEN_COMMAND,
  parseSetupTokenPrompt,
  parseSetupTokenCredential,
} from "@paperclipai/adapter-claude-local/server";
import {
  agentConfigurationDoc as claudeAgentConfigurationDoc,
  models as claudeModels,
  modelProfiles as claudeModelProfiles,
} from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
  readCodexAuthInfo,
  getConfigSchema as getCodexConfigSchema,
  CODEX_DEVICE_LOGIN_COMMAND,
  parseDeviceLoginPrompt,
} from "@paperclipai/adapter-codex-local/server";
import {
  agentConfigurationDoc as codexAgentConfigurationDoc,
  models as codexModels,
  modelProfiles as codexModelProfiles,
} from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import {
  agentConfigurationDoc as cursorAgentConfigurationDoc,
  models as cursorModels,
  modelProfiles as cursorModelProfiles,
} from "@paperclipai/adapter-cursor-local";
import {
  execute as cursorCloudExecute,
  getConfigSchema as getCursorCloudConfigSchema,
  sessionCodec as cursorCloudSessionCodec,
  testEnvironment as cursorCloudTestEnvironment,
} from "@paperclipai/adapter-cursor-cloud/server";
import { agentConfigurationDoc as cursorCloudAgentConfigurationDoc } from "@paperclipai/adapter-cursor-cloud";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
  getConfigSchema as getGeminiConfigSchema,
} from "@paperclipai/adapter-gemini-local/server";
import {
  agentConfigurationDoc as geminiAgentConfigurationDoc,
  models as geminiModels,
  modelProfiles as geminiModelProfiles,
} from "@paperclipai/adapter-gemini-local";
import {
  execute as grokExecute,
  listGrokSkills,
  syncGrokSkills,
  testEnvironment as grokTestEnvironment,
  sessionCodec as grokSessionCodec,
} from "@paperclipai/adapter-grok-local/server";
import {
  agentConfigurationDoc as grokAgentConfigurationDoc,
  models as grokModels,
} from "@paperclipai/adapter-grok-local";
import {
  createHermesGatewayServerAdapter,
  createHermesLocalServerAdapter,
} from "@paperclipai/hermes-paperclip-adapter";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
  modelProfiles as openCodeModelProfiles,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels, refreshCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  modelProfiles as piModelProfiles,
} from "@paperclipai/adapter-pi-local";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

const execFileAsync = promisify(execFile);

async function testPaperclipRunnerOpenCodeEnvironment(
  context: Parameters<typeof openCodeTestEnvironment>[0],
) {
  const result = await openCodeTestEnvironment(context);
  if (context.executionTarget?.kind === "remote") {
    return {
      ...result,
      status: result.status === "pass" ? "warn" as const : result.status,
      checks: [...result.checks, {
        code: "opencode_version_unverified_remote",
        level: "warn" as const,
        message: "OpenCode version could not be qualified by the local runner probe on a remote target.",
      }],
    };
  }
  const command = readConfiguredCommand(context.config, "opencode");
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      timeout: 5_000,
      env: process.env,
    });
    const output = `${stdout}\n${stderr}`;
    const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!match) throw new Error("OpenCode returned an unrecognized version string");
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const comparison = compareSemver(version, "1.18.17");
    const check = comparison < 0
      ? { code: "opencode_version_too_old", level: "error" as const, message: `OpenCode ${version} is older than required 1.18.17.` }
      : comparison > 0
        ? { code: "opencode_version_unqualified", level: "warn" as const, message: `OpenCode ${version} is newer than qualified version 1.18.17.` }
        : { code: "opencode_version_qualified", level: "info" as const, message: "OpenCode 1.18.17 is installed and qualified." };
    return {
      ...result,
      status: check.level === "error" ? "fail" as const
        : check.level === "warn" && result.status === "pass" ? "warn" as const
          : result.status,
      checks: [...result.checks, check],
    };
  } catch (error) {
    return {
      ...result,
      status: "fail" as const,
      checks: [...result.checks, {
        code: "opencode_version_probe_failed",
        level: "error" as const,
        message: error instanceof Error ? error.message : "OpenCode version probe failed.",
      }],
    };
  }
}

async function testPaperclipRunnerAcpxEnvironment(
  context: Parameters<typeof codexTestEnvironment>[0],
) {
  const testedAt = new Date().toISOString();
  const agent = context.config.acpxAgent;
  const model = typeof context.config.model === "string" ? context.config.model.trim() : "";
  if (context.config.permissionPolicy !== undefined && context.config.permissionPolicy !== "interactive") {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_permission_policy_invalid", level: "error" as const, message: "ACPX v1 requires permissionPolicy=interactive." }],
    };
  }
  if (agent !== "pi" && agent !== "claude" && agent !== "codex") {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_agent_invalid", level: "error" as const, message: "ACPX agent must be Pi, Claude, or Codex." }],
    };
  }
  let profile;
  try {
    profile = resolveQualifiedAcpxProfile(agent, model);
  } catch (error) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_model_unqualified", level: "error" as const, message: error instanceof Error ? error.message : "ACPX model is not qualified." }],
    };
  }
  const nodeParts = process.versions.node.split(".").map(Number);
  if ((nodeParts[0] ?? 0) < 22 || ((nodeParts[0] ?? 0) === 22 && (nodeParts[1] ?? 0) < 13)) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_node_too_old", level: "error" as const, message: `ACPX 0.13.1 requires Node 22.13 or newer; found ${process.versions.node}.` }],
    };
  }
  const configuredEnv = context.config.env && typeof context.config.env === "object"
    ? context.config.env as Record<string, unknown>
    : {};
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(configuredEnv)) if (typeof value === "string") environment[key] = value;
  const managedClaudeAuth = agent === "claude" && !environment.ANTHROPIC_API_KEY && !environment.CLAUDE_CODE_OAUTH_TOKEN
    ? await readClaudeAuthStatus()
    : null;
  const managedCodexAuth = agent === "codex" && !environment.OPENAI_API_KEY && !environment.CODEX_API_KEY
    ? await readCodexAuthInfo()
    : null;
  const credentialReady = agent === "pi"
    ? Boolean(environment.OPENROUTER_API_KEY)
    : agent === "claude"
      ? Boolean(environment.ANTHROPIC_API_KEY || environment.CLAUDE_CODE_OAUTH_TOKEN || managedClaudeAuth?.loggedIn)
      : Boolean(environment.OPENAI_API_KEY || environment.CODEX_API_KEY || managedCodexAuth);
  if (!credentialReady) {
    const required = agent === "pi"
      ? "OPENROUTER_API_KEY"
      : agent === "claude"
        ? "ANTHROPIC_API_KEY or the managed Claude credential"
        : "the managed Codex credential or OPENAI_API_KEY";
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_auth_missing", level: "error" as const, message: `ACPX ${agent} requires ${required}.` }],
    };
  }
  let probeRoot: string | null = null;
  try {
    const installation = await inspectQualifiedAcpxInstallation(agent as QualifiedAcpxAgent, model);
    probeRoot = await mkdtemp(join(tmpdir(), "paperclip-acpx-probe-"));
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: probeRoot,
      normalizedSessionId: "environment-probe",
      workingDirectory: probeRoot,
      agent: agent as QualifiedAcpxAgent,
      model,
      environment,
      dynamicTools: [],
      dynamicToolHandler: async () => { throw new Error("environment probe exposes no semantic tools"); },
    });
    const identity = host.identity();
    await host.close({ reason: "environment probe complete", discardPersistentState: true });
    return {
      adapterType: "paperclip_runner",
      status: "pass" as const,
      testedAt,
      checks: [{
        code: "acpx_profile_qualified",
        level: "info" as const,
        message: `Verified ACPX ${profile.acpxVersion}, ${profile.agentServerPackage}@${profile.agentServerVersion}, exact model ${identity.effectiveModel}, semantic bridge startup, and clean shutdown (digest ${installation.commandDigest}).`,
      }, {
        code: "acpx_auth_ready",
        level: "info" as const,
        message: `Credential readiness was verified for ACPX ${agent}; no credential value was retained.`,
      }],
    };
  } catch (error) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_handshake_failed", level: "error" as const, message: error instanceof Error ? error.message : "ACPX handshake failed." }],
    };
  } finally {
    if (probeRoot) await rm(probeRoot, { recursive: true, force: true });
  }
}

async function testPaperclipRunnerClaudeManagedEnvironment(
  context: Parameters<typeof codexTestEnvironment>[0],
) {
  const testedAt = new Date().toISOString();
  const required = [
    ["managedProfileId", "Managed profile ID"],
    ["anthropicAgentId", "Anthropic Agent ID"],
    ["agentVersion", "Agent version"],
    ["anthropicEnvironmentId", "Anthropic Environment ID"],
    ["model", "Claude model"],
  ] as const;
  const missing = required.filter(([key]) =>
    typeof context.config[key] !== "string" || String(context.config[key]).trim().length === 0
  );
  if (missing.length > 0 || context.config.managedAgentsRetentionAcknowledged !== true) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{
        code: "claude_managed_profile_incomplete",
        level: "error" as const,
        message: missing.length > 0
          ? `Claude Agent profile is missing: ${missing.map(([, label]) => label).join(", ")}.`
          : "Claude Agent requires an administrator acknowledgement of beta status and provider retention.",
      }],
    };
  }
  const cap = Number(context.config.maxSessionListCostUsd);
  if (!Number.isFinite(cap) || cap <= 0) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "claude_managed_spend_cap_invalid", level: "error" as const, message: "Claude Agent requires a positive session spend ceiling." }],
    };
  }
  const configuredEnv = context.config.env && typeof context.config.env === "object"
    ? context.config.env as Record<string, unknown>
    : {};
  const key = typeof configuredEnv.ANTHROPIC_API_KEY === "string"
    ? configuredEnv.ANTHROPIC_API_KEY.trim()
    : process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{
        code: "claude_managed_auth_missing",
        level: "error" as const,
        message: "ANTHROPIC_API_KEY is not available to the Paperclip server. Bind it through the company secret-reference environment configuration.",
      }],
    };
  }
  const headers = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "managed-agents-2026-04-01",
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const [agentResponse, environmentResponse, versionsResponse] = await Promise.all([
      fetch(`https://api.anthropic.com/v1/agents/${encodeURIComponent(String(context.config.anthropicAgentId))}?beta=true`, { headers, signal: controller.signal }),
      fetch(`https://api.anthropic.com/v1/environments/${encodeURIComponent(String(context.config.anthropicEnvironmentId))}?beta=true`, { headers, signal: controller.signal }),
      fetch(`https://api.anthropic.com/v1/agents/${encodeURIComponent(String(context.config.anthropicAgentId))}/versions?beta=true`, { headers, signal: controller.signal }),
    ]);
    if (!agentResponse.ok || !environmentResponse.ok || !versionsResponse.ok) {
      return {
        adapterType: "paperclip_runner",
        status: "fail" as const,
        testedAt,
        checks: [{
          code: "claude_managed_resource_probe_failed",
          level: "error" as const,
          message: `Anthropic resource probe failed (Agent HTTP ${agentResponse.status}; Environment HTTP ${environmentResponse.status}; versions HTTP ${versionsResponse.status}).`,
        }],
      };
    }
    const agent = await agentResponse.json() as Record<string, unknown>;
    const environment = await environmentResponse.json() as Record<string, unknown>;
    const versions = await versionsResponse.json() as Record<string, unknown>;
    if (agent.id !== context.config.anthropicAgentId || environment.id !== context.config.anthropicEnvironmentId) {
      throw new Error("Anthropic returned resource identities that do not match the configured profile");
    }
    const versionRows = Array.isArray(versions.data) ? versions.data : [];
    const pinnedVersion = String(context.config.agentVersion);
    if (!versionRows.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const value = (entry as Record<string, unknown>).version;
      return String(value) === pinnedVersion;
    })) {
      throw new Error("The configured Anthropic Agent version does not exist");
    }
    const environmentConfig = environment.config && typeof environment.config === "object"
      ? environment.config as Record<string, unknown>
      : {};
    const networking = environmentConfig.networking && typeof environmentConfig.networking === "object"
      ? environmentConfig.networking as Record<string, unknown>
      : {};
    const packages = environmentConfig.packages && typeof environmentConfig.packages === "object"
      ? environmentConfig.packages as Record<string, unknown>
      : {};
    const packageEntries = Object.entries(packages)
      .filter(([key]) => key !== "type")
      .flatMap(([, value]) => Array.isArray(value) ? value : []);
    if (
      environmentConfig.type !== "cloud"
      || networking.type !== "limited"
      || networking.allow_mcp_servers === true
      || networking.allow_package_managers === true
      || (Array.isArray(networking.allowed_hosts) && networking.allowed_hosts.length > 0)
      || packageEntries.length > 0
    ) {
      throw new Error("Anthropic Environment drifted from Paperclip's no-network, no-package profile");
    }
    return {
      adapterType: "paperclip_runner",
      status: "warn" as const,
      testedAt,
      checks: [{
        code: "claude_managed_profile_qualified",
        level: "info" as const,
        message: `Verified Claude Agent ${String(context.config.anthropicAgentId)} and Environment ${String(context.config.anthropicEnvironmentId)} without creating a session.`,
      }, {
        code: "claude_managed_retention_notice",
        level: "warn" as const,
        message: "Managed Agents is a stateful beta service and is not eligible for ZDR or HIPAA modes.",
      }],
    };
  } catch (error) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{
        code: "claude_managed_probe_failed",
        level: "error" as const,
        message: error instanceof Error && error.name === "AbortError"
          ? "Anthropic resource probe timed out."
          : "Anthropic resource probe failed before the profile could be verified.",
      }],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function testPaperclipRunnerAwsAgentCoreEnvironment(
  context: Parameters<typeof codexTestEnvironment>[0],
) {
  const testedAt = new Date().toISOString();
  const required = [
    ["agentCoreProfileId", "AgentCore profile ID"], ["awsRegion", "AWS region"],
    ["harnessId", "Harness ID"], ["harnessVersion", "Harness version"],
    ["endpointQualifier", "endpoint qualifier"], ["memoryId", "Memory ID"],
    ["invocationRoleArn", "invocation role ARN"], ["model", "Bedrock model"],
  ] as const;
  const missing = required.filter(([key]) => typeof context.config[key] !== "string" || String(context.config[key]).trim().length === 0);
  if (missing.length > 0 || context.config.agentCoreRetentionAcknowledged !== true) {
    return {
      adapterType: "paperclip_runner", status: "fail" as const, testedAt,
      checks: [{ code: "aws_agentcore_profile_incomplete", level: "error" as const,
        message: missing.length > 0
          ? `AWS AgentCore profile is missing: ${missing.map(([, label]) => label).join(", ")}.`
          : "AWS AgentCore requires an administrator acknowledgement of 90-day Memory retention." }],
    };
  }
  const cap = Number(context.config.maxEstimatedSessionCostUsd);
  if (!Number.isFinite(cap) || cap <= 0) {
    return { adapterType: "paperclip_runner", status: "fail" as const, testedAt,
      checks: [{ code: "aws_agentcore_estimated_cap_invalid", level: "error" as const, message: "AWS AgentCore requires a positive estimated session ceiling." }] };
  }
  const sourceEnvironment = context.config.env && typeof context.config.env === "object"
    ? { ...process.env, ...(context.config.env as Record<string, string>) }
    : process.env;
  const region = String(context.config.awsRegion);
  try {
    const version = await execFileAsync("aws", ["--version"], { timeout: 5_000, env: sourceEnvironment });
    if (!`${version.stdout}${version.stderr}`.includes("aws-cli/2.")) throw new Error("AWS CLI v2 is required");
    const assumed = await execFileAsync("aws", ["--region", region, "sts", "assume-role", "--role-arn", String(context.config.invocationRoleArn), "--role-session-name", "paperclip-environment-probe", "--duration-seconds", "900", "--output", "json"], { timeout: 15_000, env: sourceEnvironment });
    const credentials = (JSON.parse(assumed.stdout) as { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string } }).Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error("STS omitted temporary credentials");
    const env = {
      ...sourceEnvironment,
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      AWS_PROFILE: undefined,
    };
    await Promise.all([
      execFileAsync("aws", ["--region", region, "bedrock-agentcore-control", "get-harness", "--harness-id", String(context.config.harnessId), "--harness-version", String(context.config.harnessVersion)], { timeout: 15_000, env }),
      execFileAsync("aws", ["--region", region, "bedrock-agentcore-control", "get-harness-endpoint", "--harness-id", String(context.config.harnessId), "--endpoint-name", String(context.config.endpointQualifier)], { timeout: 15_000, env }),
      execFileAsync("aws", ["--region", region, "bedrock-agentcore-control", "get-memory", "--memory-id", String(context.config.memoryId), "--view", "full"], { timeout: 15_000, env }),
    ]);
    return {
      adapterType: "paperclip_runner", status: "warn" as const, testedAt,
      checks: [
        { code: "aws_agentcore_profile_qualified", level: "info" as const, message: `Verified pinned Harness ${String(context.config.harnessId)} version ${String(context.config.harnessVersion)} and Memory ${String(context.config.memoryId)} without creating a paid session.` },
        { code: "aws_agentcore_retention_notice", level: "warn" as const, message: "AgentCore Memory retains short-term events for 90 days; the session cost shown by Paperclip is an estimate, not an AWS currency hard stop." },
      ],
    };
  } catch {
    return { adapterType: "paperclip_runner", status: "fail" as const, testedAt,
      checks: [{ code: "aws_agentcore_probe_failed", level: "error" as const, message: "AWS AgentCore read-only qualification failed. Verify AWS CLI v2, the source profile, sts:AssumeRole, region, Harness endpoint, and Memory identifiers." }] };
  }
}

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function readConfiguredCommand(config: Record<string, unknown>, fallback: string): string {
  const value = typeof config.command === "string" ? config.command.trim() : "";
  return value.length > 0 ? value : fallback;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildNpmRuntimeCommandSpec(
  config: Record<string, unknown>,
  fallbackCommand: string,
  packageName: string,
): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, fallbackCommand);
  const canSelfInstall = !hasPathSeparator(command) && command === fallbackCommand;
  const installLine = buildSandboxNpmInstallCommand(packageName);
  return {
    command,
    detectCommand: command,
    installCommand: canSelfInstall
      ? `if ! command -v ${shellQuote(command)} >/dev/null 2>&1; then ${installLine}; fi`
      : null,
  };
}

function buildCursorRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, "agent");
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}

const retiredAcpxMessage =
  "The acpx_local adapter has been retired. Existing Claude and Codex ACPX agents should be migrated to claude_local or codex_local with adapterConfig.engine=\"acp\".";

const retiredAcpxAgentConfigurationDoc = `# acpx_local retired

Adapter: acpx_local

The standalone ACPX adapter has been retired. Use:

- claude_local with adapterConfig.engine="acp" for Claude ACP execution.
- codex_local with adapterConfig.engine="acp" for Codex ACP execution.

Paperclip keeps this tombstone registered so stale acpx_local rows fail clearly instead of falling back to the process adapter.
`;

// The Claude interactive login capability. Claude runs `claude setup-token` on a
// real pseudo-terminal. The user pastes a browser code back into the flow. The
// flow uses a fixed host-side timeout and records a stored session identifier on
// success. The capability data holds no secret; the callbacks return runtime
// values only.
const claudeLoginCapability: AdapterLoginCapability = {
  panelMode: "submitted_browser_code",
  sandboxTransport: "pseudo_terminal",
  timeoutPolicy: "fixed",
  getCommand: () => CLAUDE_SETUP_TOKEN_COMMAND,
  parsePrompt: (output) => {
    const prompt = parseSetupTokenPrompt(output);
    return prompt ? { url: prompt.url } : null;
  },
  captureCredential: (output) => {
    const token = parseSetupTokenCredential(output);
    return token === null ? null : Buffer.from(token, "utf8");
  },
  completionClaim: "storedSessionId",
};

// The Codex interactive login capability. Codex runs `codex login --device-auth`
// over the streamed exec channel. The flow shows a one-time code that the user
// enters in the browser. The caller sets the host-side timeout. The device-login
// flow writes its credential inside the sandbox, so the capability declares no
// terminal credential capture and no completion claim.
const codexLoginCapability: AdapterLoginCapability = {
  panelMode: "displayed_code",
  sandboxTransport: "streamed_exec",
  timeoutPolicy: "caller_bounded",
  getCommand: () => CODEX_DEVICE_LOGIN_COMMAND,
  parsePrompt: (output) => {
    const prompt = parseDeviceLoginPrompt(output);
    return prompt ? { url: prompt.url, code: prompt.code } : null;
  },
};

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: stampClaudeAgentIdHeader(claudeExecute),
  testEnvironment: claudeTestEnvironment,
  acp: {
    agentId: "claude",
    skillsMode: "ephemeral",
    prerequisites: {
      nodeRange: ">=22.12.0",
      packages: ["@agentclientprotocol/claude-agent-acp"],
    },
  },
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  modelProfiles: claudeModelProfiles,
  listModels: listClaudeModels,
  refreshModels: refreshClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "claude", "@anthropic-ai/claude-code"),
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getConfigSchema: getClaudeConfigSchema,
  getQuotaWindows: claudeGetQuotaWindows,
  loginCapability: claudeLoginCapability,
};

const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  async execute(ctx) {
    await ctx.onLog("stderr", `${retiredAcpxMessage}\n`);
    await ctx.onMeta?.({
      adapterType: "acpx_local",
      command: "acpx_local-retired",
      commandNotes: [retiredAcpxMessage],
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: retiredAcpxMessage,
      errorCode: "acpx_local_retired",
      provider: "acpx",
      summary: retiredAcpxMessage,
    };
  },
  async testEnvironment() {
    return {
      adapterType: "acpx_local",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [
        {
          code: "acpx_local_retired",
          level: "error",
          message: retiredAcpxMessage,
          hint: "Set the agent adapter to claude_local or codex_local and set adapterConfig.engine to acp.",
        },
      ],
    };
  },
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: retiredAcpxAgentConfigurationDoc,
  getConfigSchema: () => ({ fields: [] }),
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  acp: {
    agentId: "codex",
    skillsMode: "ephemeral",
    prerequisites: {
      nodeRange: ">=22.13.0",
      packages: ["@agentclientprotocol/codex-acp"],
    },
  },
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  modelProfiles: codexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "codex", "@openai/codex"),
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getConfigSchema: getCodexConfigSchema,
  getQuotaWindows: codexGetQuotaWindows,
  loginCapability: codexLoginCapability,
};

const paperclipRunnerAdapter: ServerAdapterModule = {
  type: "paperclip_runner",
  async execute(ctx) {
    const message = "paperclip_runner must be executed by the native runner coordinator";
    await ctx.onLog("stderr", `${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "paperclip_runner_coordinator_required",
      provider: ctx.config.provider === "acpx"
        ? "acpx"
        : ctx.config.provider === "opencode"
          ? "opencode"
          : ctx.config.provider === "claude_managed"
            ? "anthropic"
            : ctx.config.provider === "aws_agentcore"
              ? "amazon-bedrock"
              : "codex",
      summary: message,
    };
  },
  async testEnvironment(context) {
    const provider = context.config.provider === "opencode"
      ? "opencode"
      : context.config.provider === "claude_managed" ? "claude_managed"
      : context.config.provider === "aws_agentcore" ? "aws_agentcore"
      : context.config.provider === "acpx" ? "acpx" : "codex";
    const result = provider === "claude_managed"
      ? await testPaperclipRunnerClaudeManagedEnvironment(context)
      : provider === "aws_agentcore"
      ? await testPaperclipRunnerAwsAgentCoreEnvironment(context)
      : provider === "opencode"
      ? await testPaperclipRunnerOpenCodeEnvironment(context)
      : provider === "acpx"
      ? await testPaperclipRunnerAcpxEnvironment(context)
      : await codexTestEnvironment(context);
    return { ...result, adapterType: "paperclip_runner" };
  },
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  models: [
    ...codexModels,
    { id: "openrouter/deepseek/deepseek-v4-flash-0731", label: "OpenRouter · DeepSeek V4 Flash 0731" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "global.anthropic.claude-sonnet-4-6", label: "Amazon Bedrock · Claude Sonnet 4.6 (global)" },
  ],
  modelProfiles: codexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) => config.provider === "claude_managed" || config.provider === "aws_agentcore" || config.provider === "acpx"
    ? { command: "paperclip-runnerd", detectCommand: null, installCommand: null }
    : config.provider === "opencode"
    ? buildNpmRuntimeCommandSpec(config, "opencode", "opencode-ai@1.18.17")
    : buildNpmRuntimeCommandSpec(config, "codex", "@openai/codex@0.148.0"),
  agentConfigurationDoc: `# Paperclip Runner\n\nAdapter: paperclip_runner\n\nRuns native Codex, OpenCode, Claude Managed, AWS AgentCore, or a qualified Pi/Claude/Codex ACP agent through ACPX 0.13.1 and authenticated PRP. Provider processes never receive a Paperclip credential or unrestricted server environment.\n`,
  getConfigSchema: () => ({
    fields: [{
      key: "provider",
      label: "Provider",
      type: "select",
      default: "codex",
      options: [
        { value: "codex", label: "Codex" },
        { value: "opencode", label: "OpenCode 1.18.17" },
        { value: "claude_managed", label: "Claude Agent" },
        { value: "aws_agentcore", label: "AWS AgentCore" },
        { value: "acpx", label: "ACPX" },
      ],
      hint: "Select a local harness, ACPX agent, Anthropic Claude Agent, or AWS AgentCore Harness.",
    }, {
      key: "acpxAgent",
      label: "ACP agent",
      type: "select",
      default: "pi",
      options: [
        { value: "pi", label: "Pi via ACPX" },
        { value: "claude", label: "Claude via ACPX" },
        { value: "codex", label: "Codex via ACPX (control)" },
      ],
      hint: "Qualified ACP server profile. Configuration is immutable after session creation.",
      meta: { provider: "acpx" },
    }, {
      key: "permissionPolicy",
      label: "Permission policy",
      type: "text",
      default: "interactive",
      hint: "ACPX v1 supports the interactive policy only.",
      meta: { provider: "acpx", readOnly: true },
    }, {
      key: "lifecycleMode",
      label: "Runner lifecycle",
      type: "select",
      default: "per_turn",
      options: [
        { value: "per_turn", label: "Turn by turn" },
        { value: "warm", label: "Warm session" },
      ],
      hint: "Warm sessions retain runnerd and the provider between separately governed runs.",
    }, {
      key: "idleTimeoutMs",
      label: "Warm idle timeout (ms)",
      type: "number",
      default: 300000,
      hint: "Warm sessions suspend resumably after this much inactivity.",
    }, {
      key: "model",
      label: "Model",
      type: "text",
      default: "openrouter/deepseek/deepseek-v4-flash-0731",
      placeholder: "openrouter/deepseek/deepseek-v4-flash-0731",
      hint: "OpenCode uses provider/model form. Claude Agent defaults to claude-sonnet-5.",
    }, {
      key: "command",
      label: "OpenCode command",
      type: "text",
      default: "opencode",
      hint: "OpenCode executable. Version 1.18.17 is qualified.",
    }, {
      key: "managedProfileId", label: "Managed Agent profile", type: "text", required: true,
      hint: "Company-scoped profile identifier. Required for Claude Agent.",
      meta: { provider: "claude_managed" },
    }, {
      key: "anthropicAgentId", label: "Anthropic Agent ID", type: "text", required: true,
      meta: { provider: "claude_managed" },
    }, {
      key: "agentVersion", label: "Pinned Agent version", type: "text", required: true,
      meta: { provider: "claude_managed" },
    }, {
      key: "anthropicEnvironmentId", label: "Anthropic Environment ID", type: "text", required: true,
      meta: { provider: "claude_managed" },
    }, {
      key: "maxSessionListCostUsd", label: "Session spend ceiling (USD)", type: "number", default: 1,
      hint: "Required hard ceiling for a managed session.", meta: { provider: "claude_managed" },
    }, {
      key: "managedAgentsRetentionAcknowledged", label: "Acknowledge beta retention", type: "toggle", default: false,
      hint: "Managed Agents is stateful and is not eligible for ZDR or HIPAA modes.", meta: { provider: "claude_managed" },
    }, {
      key: "agentCoreProfileId", label: "AgentCore profile", type: "text", required: true,
      hint: "Company-scoped provisioned profile identifier.", meta: { provider: "aws_agentcore" },
    }, {
      key: "awsRegion", label: "AWS region", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "awsAccountId", label: "AWS account ID", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "harnessArn", label: "Harness ARN", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "harnessId", label: "Harness ID", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "harnessVersion", label: "Pinned Harness version", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "endpointQualifier", label: "Harness endpoint", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "endpointArn", label: "Harness endpoint ARN", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "agentRuntimeArn", label: "Underlying Runtime ARN", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "memoryId", label: "AgentCore Memory ID", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "memoryArn", label: "AgentCore Memory ARN", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "invocationRoleArn", label: "Invocation role ARN", type: "text", required: true,
      meta: { provider: "aws_agentcore" },
    }, {
      key: "maxEstimatedSessionCostUsd", label: "Estimated session ceiling (USD)", type: "number", default: 1,
      hint: "Paperclip estimate; AWS has no per-session currency hard stop.", meta: { provider: "aws_agentcore" },
    }, {
      key: "qualificationRevision", label: "Qualification revision", type: "text", default: "aws-agentcore-harness-v1",
      meta: { provider: "aws_agentcore" },
    }, {
      key: "agentCoreRetentionAcknowledged", label: "Acknowledge 90-day Memory retention", type: "toggle", default: false,
      hint: "AgentCore short-term Memory retains events for 90 days.", meta: { provider: "aws_agentcore" },
    }],
  }),
  loginCapability: codexLoginCapability,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  modelProfiles: cursorModelProfiles,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: buildCursorRuntimeCommandSpec,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const cursorCloudAdapter: ServerAdapterModule = {
  type: "cursor_cloud",
  execute: cursorCloudExecute,
  testEnvironment: cursorCloudTestEnvironment,
  sessionCodec: cursorCloudSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor_cloud") ?? undefined,
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: cursorCloudAgentConfigurationDoc,
  getConfigSchema: getCursorCloudConfigSchema,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  acp: {
    agentId: "gemini",
    skillsMode: "ephemeral",
    prerequisites: {
      nodeRange: ">=20.0.0",
      packages: ["@google/gemini-cli"],
    },
  },
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  modelProfiles: geminiModelProfiles,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "gemini", "@google/gemini-cli"),
  agentConfigurationDoc: geminiAgentConfigurationDoc,
  getConfigSchema: getGeminiConfigSchema,
};

const grokLocalAdapter: ServerAdapterModule = {
  type: "grok_local",
  execute: grokExecute,
  testEnvironment: grokTestEnvironment,
  listSkills: listGrokSkills,
  syncSkills: syncGrokSkills,
  sessionCodec: grokSessionCodec,
  sessionManagement: getAdapterSessionManagement("grok_local") ?? undefined,
  models: grokModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => ({
    command: readConfiguredCommand(config, "grok"),
    detectCommand: readConfiguredCommand(config, "grok"),
    installCommand: null,
  }),
  agentConfigurationDoc: grokAgentConfigurationDoc,
};

const hermesGatewayAdapter = createHermesGatewayServerAdapter();

const hermesLocalAdapter = createHermesLocalServerAdapter();

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  modelProfiles: openCodeModelProfiles,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "opencode", "opencode-ai"),
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  modelProfiles: piModelProfiles,
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "pi", "@mariozechner/pi-coding-agent"),
  agentConfigurationDoc: piAgentConfigurationDoc,
};

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

function registerBuiltInAdapters() {
  for (const adapter of [
    acpxLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    paperclipRunnerAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorCloudAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    grokLocalAdapter,
    hermesGatewayAdapter,
    hermesLocalAdapter,
    openclawGatewayAdapter,
    processAdapter,
    httpAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}

registerBuiltInAdapters();

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
//
// External adapter packages export createServerAdapter() which returns a
// ServerAdapterModule. When the module provides its own sessionManagement
// it is preserved; otherwise the host falls back to the built-in registry
// lookup (so externals that override a built-in type inherit the builtin's
// policy). This brings init-time registration to at-least-as-good behavior
// as the hot-install path (routes/adapters.ts:179 -> registerServerAdapter):
// both preserve module-provided sessionManagement, and init-time additionally
// applies the registry fallback for externals overriding a built-in type.
// ---------------------------------------------------------------------------

/** Cached sync wrapper — the store is a simple JSON file read, safe to call frequently. */
function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

/**
 * Merge an external adapter module with host-provided session management.
 *
 * Module-provided `sessionManagement` takes precedence. When absent, fall
 * back to the hardcoded registry keyed by adapter type (so externals that
 * override a built-in — same `type` — inherit the builtin's policy). If
 * neither is available, `sessionManagement` remains `undefined`.
 *
 * Used by both the init-time IIFE below (external-adapter load pass on
 * server start) and the hot-install path in `routes/adapters.ts`
 * (`registerWithSessionManagement`), so the two load paths resolve
 * `sessionManagement` identically.
 */
export function resolveExternalAdapterRegistration(
  externalAdapter: ServerAdapterModule,
): ServerAdapterModule {
  return {
    ...externalAdapter,
    sessionManagement:
      externalAdapter.sessionManagement
        ?? getAdapterSessionManagement(externalAdapter.type)
        ?? undefined,
  };
}

/**
 * Load external adapters from the plugin store and hardcoded sources.
 * Called once at module initialization. The promise is exported so that
 * callers (e.g. assertKnownAdapterType, app startup) can await completion
 * and avoid racing against the loading window.
 */
const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
        resolveExternalAdapterRegistration(externalAdapter),
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

/**
 * Await this before validating adapter types to avoid race conditions
 * during server startup. External adapters are loaded asynchronously;
 * calling assertKnownAdapterType before this resolves will reject
 * valid external adapter types.
 */
export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return findActiveServerAdapter(type) ?? processAdapter;
}

/**
 * Memoized view of PAPERCLIP_ADAPTER_MODELS, keyed by the raw env string so
 * tests (and live env mutation) that change the variable are still observed.
 * Parsing happens at most once per distinct raw value instead of per
 * `listAdapterModels` request, and malformed values fail SOFT here: we log the
 * parse error once (per distinct raw value) and fall back to adapter-discovered
 * models rather than throwing at request time.
 */
let adapterModelsEnvCache: {
  raw: string | undefined;
  value: ReturnType<typeof parseAdapterModelsEnv>;
} | null = null;

function getDeclaredAdapterModels(): ReturnType<typeof parseAdapterModelsEnv> {
  const raw = process.env.PAPERCLIP_ADAPTER_MODELS;
  if (adapterModelsEnvCache && adapterModelsEnvCache.raw === raw) {
    return adapterModelsEnvCache.value;
  }
  let value: ReturnType<typeof parseAdapterModelsEnv> = null;
  try {
    value = parseAdapterModelsEnv(process.env);
  } catch (err) {
    console.error(
      "[paperclip] Invalid PAPERCLIP_ADAPTER_MODELS; ignoring declared model lists:",
      err,
    );
  }
  adapterModelsEnvCache = { raw, value };
  return value;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const declaredModels = getDeclaredAdapterModels();
  if (declaredModels && declaredModels[type]?.length) {
    return declaredModels[type].map((m) => ({ id: m.id, label: m.label ?? m.id }));
  }
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function refreshAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.refreshModels) {
    const refreshed = await adapter.refreshModels();
    if (refreshed.length > 0) return refreshed;
  }
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function listAdapterModelProfiles(type: string): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModelProfiles) {
    const discovered = await adapter.listModelProfiles();
    if (discovered.length > 0) return discovered;
  }
  return adapter.modelProfiles ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * List adapters excluding those that are disabled in settings.
 * Used for menus and agent creation flows — disabled adapters remain
 * functional for existing agents but hidden from selection.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Override pause / resume
// ---------------------------------------------------------------------------

/**
 * Pause or resume an external override for a builtin adapter type.
 *
 * - `paused = true`  → subsequent calls to `getServerAdapter(type)` return
 *   the builtin fallback instead of the external adapter.  Already-running
 *   agent sessions are unaffected (they hold a reference to the module they
 *   started with).
 *
 * - `paused = false` → the external adapter is active again.
 *
 * Returns `true` if the state actually changed, `false` if the type is not
 * an override or was already in the requested state.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

/** Check whether the external override for a builtin type is currently paused. */
export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/** Get the set of types whose overrides are currently paused. */
export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }
  return adaptersByType.get(type) ?? null;
}
