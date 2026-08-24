import { readFile } from "node:fs/promises";

import type { AcpElicitationRequest } from "acpx/runtime";
import { describe, expect, it } from "vitest";

import { normalizeAcpFormElicitation } from "../drivers/acpx/acp-question-adapter.js";
import { normalizeCodexQuestionSet } from "../drivers/codex/codex-app-server-driver.js";
import { normalizeOpenCodeQuestionSet } from "../drivers/opencode/opencode-server-driver.js";
import { parsePaperclipQuestionResponse, parsePaperclipQuestionSet } from "./question-set.js";

interface Fixture {
  schema: "paperclip.question_adapter_fixture.v1";
  adapter: "codex" | "opencode" | "acpx";
  nativeRequest: Record<string, unknown>;
  canonicalQuestionSet: unknown;
  canonicalResponse: unknown;
  nativeResponse: unknown;
}

async function fixture(adapter: Fixture["adapter"]): Promise<Fixture> {
  return JSON.parse(await readFile(new URL(`../../protocol/fixtures/questions/${adapter}.json`, import.meta.url), "utf8")) as Fixture;
}

describe("question adapter conformance fixtures", () => {
  it("normalizes equivalent Codex, OpenCode, and ACPX requests identically", async () => {
    const [codex, opencode, acpx] = await Promise.all([
      fixture("codex"),
      fixture("opencode"),
      fixture("acpx"),
    ]);
    const codexNative = codex.nativeRequest;
    const codexQuestionSet = normalizeCodexQuestionSet(
      String(codexNative.method),
      codexNative.params as Record<string, unknown>,
    );
    const opencodeProperties = opencode.nativeRequest.properties as Record<string, unknown>;
    const opencodeQuestionSet = normalizeOpenCodeQuestionSet(
      (opencodeProperties.questions as unknown[]).map((value) => value as Record<string, unknown>),
      opencodeProperties,
    );
    const acpxQuestionSet = normalizeAcpFormElicitation(
      (acpx.nativeRequest.params as Record<string, unknown>) as AcpElicitationRequest,
    )?.questionSet;
    const expected = parsePaperclipQuestionSet(codex.canonicalQuestionSet);

    expect(codexQuestionSet).toEqual(expected);
    expect(opencodeQuestionSet).toEqual(expected);
    expect(acpxQuestionSet).toEqual(expected);
    expect(parsePaperclipQuestionSet(opencode.canonicalQuestionSet)).toEqual(expected);
    expect(parsePaperclipQuestionSet(acpx.canonicalQuestionSet)).toEqual(expected);
    expect(parsePaperclipQuestionResponse(expected, codex.canonicalResponse)).toEqual(codex.canonicalResponse);
  });

  it("converts the canonical fixture response back into typed ACP content", async () => {
    const acpx = await fixture("acpx");
    const normalized = normalizeAcpFormElicitation(
      (acpx.nativeRequest.params as Record<string, unknown>) as AcpElicitationRequest,
    );
    expect(normalized?.accept(acpx.canonicalResponse)).toEqual(acpx.nativeResponse);
  });
});
