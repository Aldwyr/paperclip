import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const PAPERCLIP_WORKSPACE_FILE_REFERENCE_SCHEMA = "paperclip.workspace.file_reference.v1" as const;

export interface PaperclipWorkspaceFileReference {
  schema: typeof PAPERCLIP_WORKSPACE_FILE_REFERENCE_SCHEMA;
  referenceId: string;
  source: "harness_reported" | "runner_verified";
  path: string;
  displayName: string;
  mediaType: string | null;
  presentation: "document" | "code" | "image" | "generic";
  line: number | null;
  preview: string | null;
  previewTruncated: boolean;
  contentDigest: string | null;
}

const MAX_REFERENCES = 32;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_READ_BYTES = 1024 * 1024;

function media(path: string): Pick<PaperclipWorkspaceFileReference, "mediaType" | "presentation"> {
  const extension = extname(path).toLowerCase();
  if ([".md", ".mdx", ".txt", ".rst"].includes(extension)) {
    return { mediaType: extension === ".md" || extension === ".mdx" ? "text/markdown" : "text/plain", presentation: "document" };
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
    const imageType = extension === ".jpg" ? "jpeg" : extension.slice(1);
    return { mediaType: `image/${imageType}`, presentation: "image" };
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".json", ".rs", ".py", ".go", ".java", ".css", ".html", ".yaml", ".yml", ".toml", ".sh"].includes(extension)) {
    return { mediaType: "text/plain", presentation: "code" };
  }
  return { mediaType: null, presentation: "generic" };
}

function localTarget(rawTarget: string): { target: string; line: number | null } | null {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("file:")) return null;
  if (target.startsWith("file://")) {
    try { target = decodeURIComponent(new URL(target).pathname); } catch { return null; }
  } else {
    try { target = decodeURIComponent(target); } catch { return null; }
  }
  let line: number | null = null;
  const hashLine = target.match(/#L(\d+)(?:C\d+)?$/i);
  if (hashLine) {
    line = Number(hashLine[1]);
    target = target.slice(0, hashLine.index);
  } else {
    const suffixLine = target.match(/:(\d+)$/);
    if (suffixLine) {
      line = Number(suffixLine[1]);
      target = target.slice(0, suffixLine.index);
    }
  }
  return target.length === 0 ? null : { target, line };
}

export function paperclipWorkspaceFileReferencesFromText(
  workspace: string,
  assistantText: string,
  turnId: string,
  source: PaperclipWorkspaceFileReference["source"] = "harness_reported",
): PaperclipWorkspaceFileReference[] {
  const root = resolve(workspace);
  const references: PaperclipWorkspaceFileReference[] = [];
  const seen = new Set<string>();
  const links = assistantText.matchAll(/\[([^\]]+)]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g);
  for (const match of links) {
    if (references.length >= MAX_REFERENCES) break;
    const parsed = localTarget(match[2] ?? "");
    if (parsed === null) continue;
    const absolutePath = resolve(root, parsed.target);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) continue;
    const key = `${relativePath}:${parsed.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const identity = createHash("sha256").update(`${turnId}\0${key}`).digest("hex").slice(0, 24);
    references.push({
      schema: PAPERCLIP_WORKSPACE_FILE_REFERENCE_SCHEMA,
      referenceId: `${turnId}:file:${identity}`,
      source,
      path: relativePath,
      displayName: (match[1]?.trim() || basename(relativePath)).slice(0, 255),
      ...media(relativePath),
      line: parsed.line,
      preview: null,
      previewTruncated: false,
      contentDigest: null,
    });
  }
  return references;
}

export async function discoverPaperclipWorkspaceFileReferences(
  workspace: string,
  assistantText: string,
  turnId: string,
): Promise<PaperclipWorkspaceFileReference[]> {
  const references = paperclipWorkspaceFileReferencesFromText(workspace, assistantText, turnId, "runner_verified");
  const verified: PaperclipWorkspaceFileReference[] = [];
  for (const reference of references) {
    const absolutePath = resolve(workspace, reference.path);
    let info;
    try { info = await stat(absolutePath); } catch { continue; }
    if (!info.isFile()) continue;
    if (info.size > MAX_READ_BYTES) {
      verified.push({ ...reference, previewTruncated: true });
      continue;
    }
    let bytes: Buffer;
    try { bytes = await readFile(absolutePath); } catch { continue; }
    const binary = bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0);
    verified.push({
      ...reference,
      preview: binary ? null : bytes.subarray(0, MAX_PREVIEW_BYTES).toString("utf8"),
      previewTruncated: bytes.length > MAX_PREVIEW_BYTES,
      contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  }
  return verified;
}
