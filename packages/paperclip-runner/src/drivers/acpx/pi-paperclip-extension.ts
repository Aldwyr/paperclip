import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const PRIVATE_PERMISSION_TOOL = "__paperclip_runtime_permission";
const PRIVATE_INPUT_TOOL = "__paperclip_runtime_input";
const MODEL_INPUT_TOOL = "request_user_input";
const BUILTIN_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const BUILTIN_GOVERNED_TOOLS = new Set(["write", "edit", "bash"]);
const MAX_RESPONSE_BYTES = 1_048_576;

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpResponse {
  result?: {
    tools?: McpTool[];
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
}

/**
 * Qualified Pi extension. Pi deliberately has neither MCP nor permission
 * prompts, so this small runner-owned adapter supplies both without granting
 * Pi direct Paperclip credentials or control-plane network access.
 */
export default async function paperclipPiExtension(pi: ExtensionAPI): Promise<void> {
  const endpoint = requiredLoopbackEndpoint(process.env.PAPERCLIP_RUNNER_BRIDGE_URL);
  const token = requiredSecret(process.env.PAPERCLIP_RUNNER_BRIDGE_TOKEN);
  const workspace = resolve(requiredValue(process.env.PAPERCLIP_WORKSPACE_ROOT, "workspace root"));
  const runtimeRoot = resolve(requiredValue(process.env.PAPERCLIP_RUNTIME_ROOT, "runtime root"));
  const readOnlyRoots = [process.env.PAPERCLIP_INSTRUCTION_ROOT, process.env.PAPERCLIP_ASSIGNED_SKILLS_ROOT]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolve(value));
  const rpc = createMcpClient(endpoint, token);
  let sessionAllowsGovernedTools = false;
  await initializeMcpClient(rpc, "paperclip-pi-extension");
  registerRuntimeInputTool(pi, rpc);
  await registerMcpTools(pi, rpc, { privatePermissionTool: true, prefix: "" });
  const assignedUrl = process.env.PAPERCLIP_NATIVE_MCP_URL?.trim();
  const assignedToken = process.env.PAPERCLIP_NATIVE_MCP_TOKEN?.trim();
  if (assignedUrl || assignedToken) {
    const assigned = createMcpClient(requiredMcpEndpoint(assignedUrl), requiredSecret(assignedToken));
    await initializeMcpClient(assigned, "paperclip-pi-assigned-mcp");
    await registerMcpTools(pi, assigned, { privatePermissionTool: false, prefix: "assigned__" });
  }

  pi.on("tool_call", async (event) => {
    if (BUILTIN_READ_TOOLS.has(event.toolName)) {
      const unsafe = referencedPaths(event.input).find((candidate) => !safeWorkspaceTarget(workspace, runtimeRoot, readOnlyRoots, candidate, false));
      return unsafe ? { block: true, reason: "Paperclip denied a path outside the authorized workspace." } : undefined;
    }
    if (!BUILTIN_GOVERNED_TOOLS.has(event.toolName)) return undefined;
    const pathTarget = referencedPaths(event.input)[0] ?? null;
    if (pathTarget !== null && !safeWorkspaceTarget(workspace, runtimeRoot, [], pathTarget, true)) {
      return { block: true, reason: "Paperclip denied a protected or outside-workspace target." };
    }
    const command = event.toolName === "bash" ? commandText(event.input) : null;
    if (command !== null && unsafeCommandPath(command, workspace, runtimeRoot)) {
      return { block: true, reason: "Paperclip denied a command that names a protected or outside-workspace path." };
    }
    if (sessionAllowsGovernedTools) return undefined;
    const target = command === null ? pathTarget : `command-sha256:${createHash("sha256").update(command).digest("hex")}`;
    const response = await rpc("tools/call", {
      name: PRIVATE_PERMISSION_TOOL,
      arguments: { operation: event.toolName, target: target === null ? null : relative(workspace, resolve(workspace, target)), inputClass: event.toolName === "bash" ? "command" : "workspace_mutation" },
    }, `permission:${event.toolCallId}`);
    const decision = decodedResult(response).decision;
    if (decision === "accept_for_session") sessionAllowsGovernedTools = true;
    return decision === "accept" || decision === "accept_for_session" ? undefined : { block: true, reason: decision === "cancel" ? "Paperclip cancelled this operation." : "Paperclip declined this operation." };
  });
}

function registerRuntimeInputTool(pi: ExtensionAPI, rpc: ReturnType<typeof createMcpClient>): void {
  pi.registerTool({
    name: MODEL_INPUT_TOOL,
    label: "Ask · user input",
    description: "Pause the current turn and ask the user one or more structured questions. Use text, single-select, multi-select, boolean, integer, or number fields as appropriate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["title", "questions"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 1_000 },
        description: { type: "string", maxLength: 4_000 },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "prompt", "answerMode"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9_.:-]+$" },
              header: { type: "string", maxLength: 1_000 },
              prompt: { type: "string", minLength: 1, maxLength: 4_000 },
              helpText: { type: "string", maxLength: 4_000 },
              required: { type: "boolean" },
              answerMode: { enum: ["text", "single_select", "multi_select", "boolean", "integer", "number"] },
              options: {
                type: "array",
                minItems: 1,
                maxItems: 128,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label"],
                  properties: {
                    id: { type: "string", minLength: 1, maxLength: 160 },
                    label: { type: "string", minLength: 1, maxLength: 1_000 },
                    description: { type: "string", maxLength: 4_000 },
                  },
                },
              },
              minLength: { type: "integer", minimum: 0, maximum: 1_000_000 },
              maxLength: { type: "integer", minimum: 0, maximum: 1_000_000 },
              minimum: { type: "number" },
              maximum: { type: "number" },
              pattern: { type: "string", maxLength: 1_000 },
            },
          },
        },
      },
    } as ToolDefinition["parameters"],
    async execute(toolCallId, input, signal) {
      const response = await rpcWithCancellation(rpc, PRIVATE_INPUT_TOOL, toolCallId, input, signal);
      if (response.result?.isError) throw new Error(safeResultText(response) || "Paperclip input request failed");
      return {
        content: [{ type: "text" as const, text: safeResultText(response) || JSON.stringify({ action: "cancel" }) }],
        details: { operationId: PRIVATE_INPUT_TOOL, registeredName: MODEL_INPUT_TOOL, callId: toolCallId },
      };
    },
  });
}

async function initializeMcpClient(rpc: ReturnType<typeof createMcpClient>, clientName: string): Promise<void> {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: clientName, version: "1" } }, `${clientName}-initialize`);
  await rpc("notifications/initialized", {}, null);
}

async function registerMcpTools(pi: ExtensionAPI, rpc: ReturnType<typeof createMcpClient>, options: { privatePermissionTool: boolean; prefix: string }): Promise<void> {
  const catalog = await rpc("tools/list", {}, "paperclip-pi-tools");
  for (const tool of catalog.result?.tools ?? []) {
    if (
      !safeTool(tool) ||
      (options.privatePermissionTool && tool.name === PRIVATE_PERMISSION_TOOL) ||
      (options.prefix === "" && tool.name === MODEL_INPUT_TOOL)
    ) continue;
    const registeredName = `${options.prefix}${tool.name}`;
    pi.registerTool({
      name: registeredName,
      label: semanticLabel(registeredName),
      description: tool.description ?? `Paperclip semantic operation ${tool.name}`,
      parameters: (tool.inputSchema ?? { type: "object", additionalProperties: true }) as ToolDefinition["parameters"],
      async execute(toolCallId, input, signal) {
        const response = await rpcWithCancellation(rpc, tool.name, toolCallId, input, signal);
        if (response.result?.isError) throw new Error(safeResultText(response) || "Paperclip operation failed");
        return {
          content: response.result?.content?.flatMap((item) =>
            item.type === "text" && typeof item.text === "string"
              ? [{ type: "text" as const, text: item.text.slice(0, MAX_RESPONSE_BYTES) }]
              : [],
          ) ?? [],
          details: { operationId: tool.name, registeredName, callId: toolCallId },
        };
      },
    });
  }
}

function createMcpClient(endpoint: URL, token: string) {
  return async (method: string, params: Record<string, unknown>, id: string | null): Promise<McpResponse> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
    });
    if (!response.ok && response.status !== 202) throw new Error(`Paperclip runner bridge returned HTTP ${response.status}`);
    if (id === null || response.status === 202) return {};
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error("Paperclip runner bridge response exceeded its bound");
    const parsed = JSON.parse(body) as McpResponse;
    if (parsed.error) throw new Error(String(parsed.error.message ?? "Paperclip runner bridge rejected the request").slice(0, 4_000));
    return parsed;
  };
}

async function rpcWithCancellation(
  rpc: ReturnType<typeof createMcpClient>,
  tool: string,
  callId: string,
  input: unknown,
  signal: AbortSignal | undefined,
): Promise<McpResponse> {
  if (signal?.aborted) throw new Error("Paperclip operation cancelled");
  const cancel = () => { void rpc("notifications/cancelled", { requestId: callId }, null).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await rpc("tools/call", { name: tool, arguments: input }, callId);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function decodedResult(response: McpResponse): Record<string, unknown> {
  const value = safeResultText(response);
  if (!value) return {};
  try {
    const decoded = JSON.parse(value) as unknown;
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeResultText(response: McpResponse): string {
  return response.result?.content?.find((item) => item.type === "text")?.text?.slice(0, MAX_RESPONSE_BYTES) ?? "";
}

function referencedPaths(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  return [record.path, record.file_path, record.filePath, record.cwd]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function inside(root: string, candidate: string): boolean {
  const value = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const result = relative(root, value);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function pathEntryExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingAncestor(candidate: string): string | null {
  let current = candidate;
  while (!pathEntryExists(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function safeWorkspaceTarget(workspace: string, runtimeRoot: string, readOnlyRoots: string[], candidate: string, mayCreate: boolean): boolean {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(workspace, candidate);
  const authorizedRoot = [workspace, ...readOnlyRoots].find((root) => inside(root, absolute));
  if (!authorizedRoot || (inside(runtimeRoot, absolute) && !readOnlyRoots.some((root) => inside(root, absolute)))) return false;
  try {
    const existing = pathEntryExists(absolute)
      ? absolute
      : mayCreate
        ? nearestExistingAncestor(dirname(absolute))
        : absolute;
    if (existing === null) return false;
    const physical = realpathSync(existing);
    const physicalAuthorizedRoot = realpathSync(authorizedRoot);
    const physicalRuntimeRoot = realpathSync(runtimeRoot);
    const physicalReadOnlyRoots = readOnlyRoots.map((root) => realpathSync(root));
    return inside(physicalAuthorizedRoot, physical)
      && (!inside(physicalRuntimeRoot, physical) || physicalReadOnlyRoots.some((root) => inside(root, physical)));
  } catch {
    return false;
  }
}

function commandText(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const command = [value.command, value.cmd, value.script].find((candidate): candidate is string => typeof candidate === "string");
  return command?.slice(0, 64 * 1024) ?? null;
}

function unsafeCommandPath(command: string, workspace: string, runtimeRoot: string): boolean {
  const shellBoundary = String.raw`[\s'"\x60=;&|()<>]`;
  if (
    new RegExp(`(^|${shellBoundary})~(?:/|${shellBoundary}|$)`).test(command)
    || new RegExp(`(^|${shellBoundary}|/)\\.\\.(?:/|${shellBoundary}|$)`).test(command)
  ) return true;
  const absolutePaths = [...command.matchAll(new RegExp(`(?:^|${shellBoundary})(/(?:[^\\s'"\\x60;&|()<>]|\\\\.)+)`, "g"))]
    .map((match) => match[1]!)
    .filter((candidate) => candidate.length > 0);
  return absolutePaths.some((candidate) => !inside(workspace, candidate) || inside(runtimeRoot, candidate));
}

function safeTool(value: McpTool): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(value.name)
    && value.inputSchema !== null
    && typeof value.inputSchema === "object"
    && !Array.isArray(value.inputSchema);
}

function semanticLabel(name: string): string {
  if (/read|get|list|search|find/i.test(name)) return `Read · ${name}`;
  if (/write|create|update|edit|comment|finish|block/i.test(name)) return `Change · ${name}`;
  return `Paperclip · ${name}`;
}

function requiredLoopbackEndpoint(value: string | undefined): URL {
  const endpoint = new URL(requiredValue(value, "runner bridge URL"));
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp") {
    throw new Error("Paperclip Pi extension requires an authenticated loopback bridge");
  }
  return endpoint;
}

function requiredMcpEndpoint(value: string | undefined): URL {
  const endpoint = new URL(requiredValue(value, "assigned MCP URL"));
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))) throw new Error("Paperclip assigned MCP requires HTTPS or loopback HTTP");
  return endpoint;
}

function requiredSecret(value: string | undefined): string {
  const secret = requiredValue(value, "runner bridge credential");
  if (secret.length < 32) throw new Error("Paperclip runner bridge credential is invalid");
  return secret;
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Paperclip Pi extension is missing ${name}`);
  return value;
}
