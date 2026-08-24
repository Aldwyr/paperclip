import { describe, expect, it } from "vitest";
import type { AcpElicitationRequest } from "acpx/runtime";

import { normalizeAcpFormElicitation } from "./acp-question-adapter.js";

describe("ACP form question adapter", () => {
  it("normalizes all supported field modes and restores typed ACP content", () => {
    const normalized = normalizeAcpFormElicitation({
      mode: "form",
      sessionId: "session-1",
      message: "Choose deployment settings.",
      requestedSchema: {
        type: "object",
        title: "Deployment",
        required: ["name", "region", "features", "confirmed", "replicas"],
        properties: {
          name: { type: "string", title: "Name", minLength: 2, maxLength: 20 },
          region: {
            type: "string",
            title: "Region",
            oneOf: [
              { const: "us-east-1", title: "Virginia", description: "Lowest latency for US East." },
              { const: "eu-west-1", title: "Ireland" },
            ],
          },
          features: {
            type: "array",
            title: "Features",
            items: { anyOf: [
              { const: "tracing", title: "Tracing" },
              { const: "backups", title: "Backups" },
            ] },
          },
          confirmed: { type: "boolean", title: "Confirm" },
          replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 10 },
        },
      },
    } as AcpElicitationRequest);

    expect(normalized).not.toBeNull();
    const questionSet = normalized!.questionSet;
    expect(questionSet.title).toBe("Deployment");
    expect(questionSet.description).toContain("Choose deployment settings.");
    expect(questionSet.questions.map((question) => question.answerMode)).toEqual([
      "text",
      "single_select",
      "multi_select",
      "single_select",
      "text",
    ]);
    expect(questionSet.questions[1]?.options?.[0]).toMatchObject({
      label: "Virginia",
      description: "Lowest latency for US East.",
    });
    expect(questionSet.questions[4]?.textValidation).toMatchObject({
      inputType: "integer",
      minimum: 1,
      maximum: 10,
    });

    const [name, region, features, confirmed, replicas] = questionSet.questions;
    const response = normalized!.accept({
      schema: "paperclip.question_response.v1",
      answers: {
        [name!.id]: { text: "paperclip" },
        [region!.id]: { selectedOptionIds: [region!.options![1]!.id] },
        [features!.id]: { selectedOptionIds: features!.options!.map((option) => option.id) },
        [confirmed!.id]: { selectedOptionIds: [confirmed!.options![0]!.id] },
        [replicas!.id]: { text: "3" },
      },
    });
    expect(response).toEqual({
      action: "accept",
      content: {
        name: "paperclip",
        region: "eu-west-1",
        features: ["tracing", "backups"],
        confirmed: true,
        replicas: 3,
      },
    });
  });

  it("rejects invalid numeric answers before they reach ACP", () => {
    const normalized = normalizeAcpFormElicitation({
      mode: "form",
      requestId: "request-1",
      message: "How many?",
      requestedSchema: {
        type: "object",
        required: ["count"],
        properties: { count: { type: "integer", minimum: 1 } },
      },
    } as AcpElicitationRequest)!;
    expect(() => normalized.accept({
      schema: "paperclip.question_response.v1",
      answers: { [normalized.questionSet.questions[0]!.id]: { text: "1.5" } },
    })).toThrow(/must be a valid integer/);
  });

  it("does not advertise a question shape for URL elicitation", () => {
    expect(normalizeAcpFormElicitation({
      mode: "url",
      requestId: "request-1",
      message: "Authenticate",
      elicitationId: "auth-1",
      url: "https://example.invalid",
    } as AcpElicitationRequest)).toBeNull();
  });
});
