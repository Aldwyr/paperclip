import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queued-comment route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue queued-comment routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-comments-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments).catch(() => undefined);
    await db.delete(issues).catch(() => undefined);
    await db.delete(heartbeatRuns).catch(() => undefined);
    await db.delete(agentWakeupRequests).catch(() => undefined);
    await db.delete(companyMemberships).catch(() => undefined);
    await db.delete(agents).catch(() => undefined);
    await db.delete(companies).catch(() => undefined);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, userId = "queue-owner") {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedQueue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const commentIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Queue Test Company",
      issuePrefix: "QUE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Paperclip Runner",
      role: "engineer",
      status: "working",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: "queue-owner",
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId,
        principalType: "user",
        principalId: "other-operator",
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "issue_comment",
      reason: "Follow-up comments arrived during the active run",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "queue-owner",
      payload: {
        issueId,
        commentId: commentIds[1],
        _paperclipWakeContext: {
          commentId: commentIds[1],
          wakeCommentId: commentIds[1],
          wakeCommentIds: commentIds,
        },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "queue route test",
      status: "running",
      runtimeMode: "native",
      startedAt: new Date("2026-08-22T15:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "QUE-1",
      title: "Queued steering",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
    });
    await db.insert(issueComments).values(commentIds.map((id, index) => ({
      id,
      companyId,
      issueId,
      authorType: "user" as const,
      authorUserId: "queue-owner",
      body: index === 0 ? "First queued message" : "Second queued message",
      createdAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
      updatedAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
    })));
    return { companyId, agentId, issueId, runId, wakeId, commentIds };
  }

  it("returns the authoritative order, preserves full Markdown edits, and rejects stale revisions", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);

    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body).toMatchObject({
      issueId: seeded.issueId,
      targetRunId: seeded.runId,
      protocol: "paperclip_runner_v1",
      entries: [
        { position: 0, canEdit: true, canDiscard: true, comment: { id: seeded.commentIds[0] } },
        { position: 1, canEdit: true, canDiscard: true, comment: { id: seeded.commentIds[1] } },
      ],
    });

    const markdown = "  Keep **all** Markdown.  \n";
    const edited = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ targetRunId: seeded.runId, revision: initial.body.revision, body: markdown });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.entries[0].comment.body).toBe(markdown);
    expect(edited.body.revision).not.toBe(initial.body.revision);
    const stored = await db.select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(stored?.body).toBe(markdown);

    const stale = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ targetRunId: seeded.runId, revision: initial.body.revision, body: "stale" });
    expect(stale.status).toBe(409);
    expect(stale.body.details?.code).toBe("queued_comment_revision_conflict");
  });

  it("rewrites the wake order transactionally and cancels an empty queue after trash", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const reordered = await request(app(seeded.companyId))
      .put(`/api/issues/${seeded.issueId}/queued-comments/order`)
      .send({
        targetRunId: seeded.runId,
        revision: initial.body.revision,
        orderedCommentIds: [...seeded.commentIds].reverse(),
      });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.body.entries.map((entry: any) => entry.comment.id)).toEqual([...seeded.commentIds].reverse());

    const afterFirstTrash = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[1]}`)
      .send({ targetRunId: seeded.runId, revision: reordered.body.revision });
    expect(afterFirstTrash.status, JSON.stringify(afterFirstTrash.body)).toBe(200);
    expect(afterFirstTrash.body.entries.map((entry: any) => entry.comment.id)).toEqual([seeded.commentIds[0]]);

    const emptied = await request(app(seeded.companyId))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ targetRunId: seeded.runId, revision: afterFirstTrash.body.revision });
    expect(emptied.status, JSON.stringify(emptied.body)).toBe(200);
    expect(emptied.body.entries).toEqual([]);
    const wake = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect(wake?.status).toBe("cancelled");
  });

  it("limits edit and trash to the comment owner", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId, "other-operator"))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(initial.status).toBe(200);
    expect(initial.body.entries[0]).toMatchObject({ canEdit: false, canDiscard: false });

    const edit = await request(app(seeded.companyId, "other-operator"))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ targetRunId: seeded.runId, revision: initial.body.revision, body: "not mine" });
    expect(edit.status).toBe(403);
    const discard = await request(app(seeded.companyId, "other-operator"))
      .delete(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({ targetRunId: seeded.runId, revision: initial.body.revision });
    expect(discard.status).toBe(403);
  });

  it("leaves the selected row queued when no native steering session is attached", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    const steered = await request(app(seeded.companyId))
      .post(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}/steer`)
      .send({ targetRunId: seeded.runId, revision: initial.body.revision });

    expect(steered.status).toBe(409);
    expect(steered.body.details).toMatchObject({
      code: "steering_temporarily_unavailable",
      retryable: true,
    });
    const queueAfterFailure = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    expect(queueAfterFailure.body.entries.map((entry: any) => entry.comment.id)).toEqual(seeded.commentIds);
  });

  it("does not consume or edit a queued comment when the target run finishes first", async () => {
    const seeded = await seedQueue();
    const initial = await request(app(seeded.companyId))
      .get(`/api/issues/${seeded.issueId}/queued-comments`);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date("2026-08-22T15:05:00.000Z") })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const edit = await request(app(seeded.companyId))
      .patch(`/api/issues/${seeded.issueId}/queued-comments/${seeded.commentIds[0]}`)
      .send({
        targetRunId: seeded.runId,
        revision: initial.body.revision,
        body: "must remain deferred",
      });

    expect(edit.status).toBe(409);
    expect(edit.body.details?.code).toBe("queued_comment_stale_target");
    const stored = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.id, seeded.commentIds[0]))
      .then((rows) => rows[0]);
    expect(stored?.body).toBe("First queued message");
    const wake = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect((wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toEqual(seeded.commentIds);
  });
});
