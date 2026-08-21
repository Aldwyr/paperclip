import { describe, expect, it } from "vitest";

import { validateJsonSchema } from "../tools/capability-semantic-tool-runtime.js";
import type { CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";
import { PAPERCLIP_PROTOCOL_ACTIONS } from "../protocol-actions/index.js";

describe("canonical Paperclip protocol action contracts", () => {
  it.each(PAPERCLIP_PROTOCOL_ACTIONS.map((action) => [action.id, action] as const))(
    "%s has a schema-valid canonical example and every declared projection",
    (operationId, action) => {
      expect(action.canonical.operationId).toBe(operationId);
      expect(action.examples.call.operationId).toBe(operationId);
      expect(action.examples.success.operationId).toBe(operationId);
      expect(action.live !== null || action.scenario !== null).toBe(true);

      const documentedProjection = action.live ?? action.scenario;
      if (documentedProjection !== null) {
        const projection = documentedProjection;
        expect(projection.descriptor.operationId).toBe(operationId);
        expect(validateJsonSchema(
          projection.descriptor.inputSchema,
          action.examples.call.input as CapabilityJsonValue,
        )).toEqual([]);
        expect(validateJsonSchema(
          projection.descriptor.outputSchema,
          action.examples.success.result as CapabilityJsonValue,
        )).toEqual([]);
      }

      if (action.scenario !== null) {
        expect(action.scenario.descriptor.mockCommandMapping).toBeDefined();
      }
    },
  );
});
