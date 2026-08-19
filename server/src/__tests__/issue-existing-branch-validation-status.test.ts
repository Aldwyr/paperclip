import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createIssueSchema, updateIssueSchema } from "@paperclipai/shared";
import { z } from "zod";
import { errorHandler } from "../middleware/error-handler.js";
import { validateIssueMutationBody } from "../middleware/validate.js";

const EXISTING_BRANCH_PATH = ["executionWorkspaceSettings", "workspaceStrategy", "existingBranch"];

// Mirrors the route-level schema in routes/issues.ts.
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});

function buildApp(schema: Parameters<typeof validateIssueMutationBody>[0]) {
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.status(200).json({ ok: true });
  });
  const app = express();
  app.use(express.json());
  app.post("/target", validateIssueMutationBody(schema), handler);
  app.use(errorHandler);
  return { app, handler };
}

function settingsBody(settings: Record<string, unknown>) {
  return { executionWorkspaceSettings: settings };
}

describe("existingBranch issue create/update validation status", () => {
  it("returns 422 with field details for invalid branch syntax on update", async () => {
    const { app, handler } = buildApp(updateIssueRouteSchema);
    const res = await request(app).post("/target").send(settingsBody({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", existingBranch: "bad..branch" },
    }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Validation error");
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].path).toEqual(EXISTING_BRANCH_PATH);
    expect(res.body.details[0].message).toBe("existingBranch must be a valid git branch name");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 422 for placement outside isolated_workspace + git_worktree on update", async () => {
    const { app, handler } = buildApp(updateIssueRouteSchema);
    const res = await request(app).post("/target").send(settingsBody({
      mode: "shared_workspace",
      workspaceStrategy: { type: "project_primary", existingBranch: "feature/pinned" },
    }));
    expect(res.status).toBe(422);
    const messages = res.body.details.map((detail: { message: string }) => detail.message).sort();
    expect(messages).toEqual([
      'existingBranch requires mode "isolated_workspace"',
      'existingBranch requires workspaceStrategy.type "git_worktree"',
    ]);
    for (const detail of res.body.details) {
      expect(detail.path).toEqual(EXISTING_BRANCH_PATH);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 422 when existingBranch is combined with branchTemplate on update", async () => {
    const { app, handler } = buildApp(updateIssueRouteSchema);
    const res = await request(app).post("/target").send(settingsBody({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        existingBranch: "feature/pinned",
        branchTemplate: "agent/{issue}",
      },
    }));
    expect(res.status).toBe(422);
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].path).toEqual(EXISTING_BRANCH_PATH);
    expect(res.body.details[0].message).toBe("existingBranch and branchTemplate are mutually exclusive");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 422 for the same semantic failures on create", async () => {
    const { app, handler } = buildApp(createIssueSchema);
    const res = await request(app).post("/target").send({
      title: "Pinned worktree issue",
      status: "todo",
      ...settingsBody({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", existingBranch: "-bad-leading-dash" },
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.details[0].path).toEqual(EXISTING_BRANCH_PATH);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps 400 for validation failures unrelated to existingBranch", async () => {
    const { app, handler } = buildApp(createIssueSchema);
    const res = await request(app).post("/target").send({ title: 42, status: "todo" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps 400 when existingBranch and unrelated failures are mixed", async () => {
    const { app, handler } = buildApp(createIssueSchema);
    const res = await request(app).post("/target").send({
      title: 42,
      status: "todo",
      ...settingsBody({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", existingBranch: "bad..branch" },
      }),
    });
    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes a valid pinned existingBranch through to the handler", async () => {
    const { app, handler } = buildApp(updateIssueRouteSchema);
    const res = await request(app).post("/target").send(settingsBody({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", existingBranch: "feature/pinned" },
    }));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
