import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CAPABILITY_SEMANTIC_TOOL_CATALOG as SCENARIO_CATALOG } from "../tools/capability-semantic-tool-catalog.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG as LIVE_CATALOG } from "../semantic-tools/catalog.js";
import {
  CAPABILITY_CANONICAL_CATALOG,
  capabilityCanonicalOperation,
  capabilityCatalogReconciliation,
} from "./reconciliation.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("canonical semantic-catalog reconciliation authority", () => {
  it("pins the reconciled op-set relationship between the two catalogs", () => {
    const summary = capabilityCatalogReconciliation();
    expect(summary.scenarioCount).toBe(37);
    expect(summary.liveCount).toBe(28);
    expect(summary.sharedCount).toBe(24);
    expect(summary.unionCount).toBe(41);
    // Any operation added to or removed from either catalog without a
    // reconciliation decision changes these exact sets and fails the gate.
    expect(summary.liveOnly).toEqual([
      "get_agent",
      "get_approval",
      "get_approval_context",
      "schedule_wake",
    ]);
    expect(summary.scenarioOnly).toEqual([
      "administer_company",
      "export_company",
      "inspect_operation_result",
      "list_cases",
      "list_company_skills",
      "list_goals",
      "list_projects",
      "list_routines",
      "list_secret_metadata",
      "manage_routine",
      "read_secret_value",
      "sync_company_skills",
      "upsert_case",
    ]);
  });

  it("defines exactly one canonical entry per union operation", () => {
    expect(CAPABILITY_CANONICAL_CATALOG).toHaveLength(41);
    const ids = CAPABILITY_CANONICAL_CATALOG.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const scenarioIds = new Set(SCENARIO_CATALOG.map((tool) => tool.operationId));
    const liveIds = new Set(LIVE_CATALOG.map((tool) => tool.operationId));
    for (const id of [...scenarioIds, ...liveIds]) {
      expect(capabilityCanonicalOperation(id)).toBeDefined();
    }
  });

  it("names placement, claims, task modes, side-effect class, idempotency, redaction, mock mapping, real binding status, and PRP evidence for every operation", () => {
    for (const operation of CAPABILITY_CANONICAL_CATALOG) {
      expect(operation.placement).toMatch(/^(always|optional)_agent_tool$/);
      expect(Array.isArray(operation.requiredClaims)).toBe(true);
      expect(operation.taskModes.length).toBeGreaterThan(0);
      expect(operation.sideEffectClass.length).toBeGreaterThan(0);
      expect(["none", "required", "recommended"]).toContain(operation.idempotency);
      expect(typeof operation.redacts).toBe("boolean");
      expect(["live_codex", "scenario_mock", "test_only"]).toContain(operation.realBindingStatus);
      expect(operation.realServiceBinding).toBe("unbound");
      expect(operation.prpEvidence.length).toBeGreaterThan(0);
      expect(operation.prpBindingStatus).toBe("audit_pending");
      // Scenario-surface ops carry a mock mapping; live-only ops resolve inline.
      if (operation.surfaces.includes("scenario")) {
        expect(operation.mockCommandMapping).not.toBeNull();
      }
    }
  });

  it("classifies real binding status so generic_api_request is never product coverage", () => {
    const summary = capabilityCatalogReconciliation();
    expect(summary.byRealBindingStatus).toEqual({
      live_codex: 27,
      scenario_mock: 13,
      test_only: 1,
    });
    expect(capabilityCanonicalOperation("generic_api_request")?.realBindingStatus).toBe("test_only");
  });

  it("records a disposition for every metadata divergence between the two catalogs", () => {
    const { divergences } = capabilityCatalogReconciliation();
    // No divergence may be left unrecorded, regardless of field.
    for (const divergence of divergences) {
      expect(divergence.disposition).not.toMatch(/UNRECORDED/);
    }
    const idsFor = (field: string): string[] =>
      divergences
        .filter((entry) => entry.field === field)
        .map((entry) => entry.operationId)
        .sort();

    // The only claim divergence is the reviewed test-only escape-hatch grant.
    expect(idsFor("requiredClaims")).toEqual(["generic_api_request"]);

    // Task-mode policy diverges systematically between the two surfaces; the
    // exact op-set is pinned so a new, unreviewed divergence fails the gate.
    expect(idsFor("taskModes")).toEqual([
      "block_task",
      "comment_on_approval",
      "control_workspace_service",
      "create_task",
      "decide_approval",
      "finish_task",
      "get_workspace_runtime",
      "list_agents",
      "list_approvals",
      "register_deliverable",
      "report_progress",
      "request_approval",
      "request_review",
      "search_tasks",
      "set_dependencies",
    ]);

    // Input schemas legitimately differ across the two surfaces today; every one
    // carries the shared schema-migration disposition.
    for (const divergence of divergences.filter((entry) => entry.field === "inputSchemaShape")) {
      expect(divergence.disposition).toMatch(/schema-migration follow-on/);
    }
  });

  it("gives every legacy MCP alias a reviewed disposition in the inventory", () => {
    const raw = readFileSync(
      resolve(packageRoot, "spec/capability/mcp-tool-map.yaml"),
      "utf8",
    );
    const inventory = JSON.parse(raw.replace(/^#.*$/m, ""));
    expect(inventory.inventoryRole).toBe("legacy_alias_index");
    expect(inventory.rows.length).toBeGreaterThan(0);
    for (const row of inventory.rows) {
      // Every alias is either folded into a native eval/operation or explicitly
      // dispositioned; a bare alias without a disposition fails the gate.
      expect(typeof row.foldedInto === "string" && row.foldedInto.length > 0).toBe(true);
    }
  });
});
