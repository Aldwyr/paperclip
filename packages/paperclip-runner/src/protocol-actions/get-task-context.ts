/** Canonical definition and documentation for `get_task_context`. */
export const getTaskContextAction = {
  "id": "get_task_context",
  "canonical": {
    "operationId": "get_task_context",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "always_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "ask",
      "planning",
      "skill_test"
    ],
    "sideEffectClass": "read",
    "idempotency": "none",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "unbound",
    "prpEvidence": "read projection surfaced via a tool-result item event; no control-plane state diff",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": [
      "mcp:paperclipMe"
    ]
  },
  "documentation": {
    "title": "Get active task context",
    "description": "Read the active mock task, actor, wake, ancestors, budget, and interaction results.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "get_task_context",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "get_task_context",
      "result": {}
    }
  },
  "live": {
    "order": 0,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_task_context",
      "version": 1,
      "title": "Get active task context",
      "description": "Read the active mock task, actor, wake, ancestors, budget, and interaction results.",
      "exposure": "always",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "scenario": {
    "order": 0,
    "descriptor": {
      "operationId": "get_task_context",
      "version": 1,
      "title": "Get task context",
      "description": "Read the active task, ancestors, wake context, linked results, and budget summary.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "schema": {
            "type": "string",
            "enum": [
              "paperclip.capability.tool-result.v1"
            ]
          },
          "ok": {
            "type": "boolean"
          },
          "operationId": {
            "type": "string",
            "minLength": 1
          },
          "operationResultId": {
            "type": "string",
            "minLength": 1
          },
          "value": {},
          "commandResult": {},
          "authorization": {}
        },
        "required": [
          "schema",
          "ok",
          "operationId",
          "operationResultId",
          "value",
          "commandResult",
          "authorization"
        ],
        "additionalProperties": false
      },
      "disposition": "always_agent_tool",
      "optionalGroup": null,
      "requiredClaims": [],
      "taskModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "sideEffectClass": "read",
      "idempotency": "none",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "context_read",
        "projection": "active_task"
      }
    }
  }
} as const;
