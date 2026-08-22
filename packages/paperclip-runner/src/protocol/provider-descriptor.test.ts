import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { providerDescriptorSchema } from "./generated/schema-bundle.js";

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(providerDescriptorSchema);

describe("provider runtime descriptor", () => {
  it("accepts the closed AWS AgentCore remote identity", () => {
    expect(validate({
      provider: "aws_agentcore",
      driver: "aws_agentcore_harness_api",
      model: "global.anthropic.claude-sonnet-4-6",
      executionKind: "remote_service",
      providerVersion: "3",
      service: "aws_bedrock_agentcore_harness",
      providerSessionId: "paperclip-session-1",
      processId: null,
      endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness-endpoint/example",
      endpointQualifier: "paperclip",
      memoryId: "memory-1",
      eventExpiryDays: 90,
    })).toBe(true);
  });

  it("rejects an AWS descriptor using the wrong remote service", () => {
    expect(validate({
      provider: "aws_agentcore",
      driver: "aws_agentcore_harness_api",
      model: "global.anthropic.claude-sonnet-4-6",
      executionKind: "remote_service",
      providerVersion: "3",
      service: "anthropic_managed_agents",
      providerSessionId: "paperclip-session-1",
      processId: null,
      endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness-endpoint/example",
      endpointQualifier: "paperclip",
      memoryId: "memory-1",
      eventExpiryDays: 90,
    })).toBe(false);
  });
});
