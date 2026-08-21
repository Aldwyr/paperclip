import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverPaperclipWorkspaceFileReferences,
  paperclipWorkspaceFileReferencesFromText,
} from "./workspace-file-reference.js";

describe("workspace file references", () => {
  it("normalizes Markdown links and verifies a bounded preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-file-reference-"));
    await writeFile(join(root, "guide.md"), "# Guide\n\nSafe content.\n");
    const references = await discoverPaperclipWorkspaceFileReferences(
      root,
      `Read [the guide](${join(root, "guide.md")}:2).`,
      "turn-1",
    );
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      schema: "paperclip.workspace.file_reference.v1",
      source: "runner_verified",
      path: "guide.md",
      displayName: "the guide",
      presentation: "document",
      line: 2,
      preview: "# Guide\n\nSafe content.\n",
    });
    expect(references[0]?.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects external URLs and paths outside the authorized workspace", () => {
    const references = paperclipWorkspaceFileReferencesFromText(
      "/workspace",
      "[external](https://example.com/file.md) [outside](/etc/passwd) [safe](docs/safe.md)",
      "turn-1",
    );
    expect(references.map((reference) => reference.path)).toEqual(["docs/safe.md"]);
  });
});
