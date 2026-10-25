import { test } from "node:test";
import assert from "node:assert/strict";
import { NemauTaskFailedError, isResourceInUse } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

/** Serves a write, then a task that turns terminal on the nth poll. */
function taskStub(options: {
  untilNth: number;
  terminal: string;
  resourceId?: string;
  result?: Record<string, unknown>;
}) {
  let polls = 0;
  return startStub((req, res) => {
    if (!req.path.startsWith("/api/v1/tasks/")) {
      return json(res, { task_id: "task-1", status: "pending" }, 202);
    }
    polls += 1;
    if (polls < options.untilNth) {
      return json(res, { id: "task-1", taskType: "network:create", status: "running", progress: 40 });
    }
    json(res, {
      id: "task-1",
      taskType: "network:create",
      status: options.terminal,
      progress: 100,
      ...(options.resourceId ? { resourceId: options.resourceId, resourceType: "network" } : {}),
      ...(options.result ? { result: options.result } : {}),
      ...(options.terminal === "failed"
        ? { error: "the operation failed; contact support with the task id" }
        : {}),
    });
  });
}

test("waitFor polls until the terminal state", async () => {
  const stub = await taskStub({ untilNth: 3, terminal: "completed", resourceId: "net-42" });
  try {
    const nemau = clientFor(stub);
    const ref = await nemau.network.createNetwork("prod");
    const task = await nemau.waitFor(ref);
    assert.equal(task.status, "completed");
    assert.equal(task.resourceId, "net-42");
    // One write plus three polls.
    assert.equal(stub.requests.length, 4);
  } finally {
    await stub.close();
  }
});

test("a failed task throws an error carrying the task", async () => {
  const stub = await taskStub({ untilNth: 1, terminal: "failed" });
  try {
    const nemau = clientFor(stub);
    const ref = await nemau.network.createNetwork("prod");
    await assert.rejects(
      () => nemau.waitFor(ref),
      (error: unknown) => {
        assert.ok(error instanceof NemauTaskFailedError);
        // The message carries the task id, which support needs to
        // investigate a failure.
        assert.equal(error.task.id, "task-1");
        assert.match(error.message, /task-1/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("resourceId wins over the result contents", async () => {
  const stub = await taskStub({
    untilNth: 1,
    terminal: "completed",
    resourceId: "net-authoritative",
    result: { network_id: "net-from-result" },
  });
  try {
    const nemau = clientFor(stub);
    const ref = await nemau.network.createNetwork("prod");
    const { id } = await nemau.waitForResourceId(ref, "network_id");
    assert.equal(id, "net-authoritative");
  } finally {
    await stub.close();
  }
});

test("result is the fallback when the task links no resource", async () => {
  const stub = await taskStub({ untilNth: 1, terminal: "completed", result: { volume_id: "vol-9" } });
  try {
    const nemau = clientFor(stub);
    const ref = await nemau.network.createNetwork("prod");
    const { id } = await nemau.waitForResourceId(ref, "volume_id");
    assert.equal(id, "vol-9");
  } finally {
    await stub.close();
  }
});

test("a 404 right after the 202 is treated as not-yet", async () => {
  // The 202 can land before the task row is readable; failing there would make
  // every create flaky.
  let polls = 0;
  const stub = await startStub((req, res) => {
    if (!req.path.startsWith("/api/v1/tasks/")) {
      return json(res, { task_id: "t", status: "pending" }, 202);
    }
    polls += 1;
    if (polls < 3) return json(res, { error: "task not found" }, 404);
    json(res, { id: "t", status: "completed", resourceId: "net-1" });
  });
  try {
    const nemau = clientFor(stub);
    const ref = await nemau.network.createNetwork("prod");
    const task = await nemau.waitFor(ref);
    assert.equal(task.resourceId, "net-1");
  } finally {
    await stub.close();
  }
});

test("resource operations pass resource_id in the query", async () => {
  const stub = await startStub((_req, res) => json(res, { tasks: [{ id: "t1", status: "completed" }] }));
  try {
    const tasks = await clientFor(stub).tasks.listForResource("inst-1");
    assert.equal(tasks.length, 1);
    assert.equal(stub.requests[0]!.query, "resource_id=inst-1");
  } finally {
    await stub.close();
  }
});

test("isResourceInUse recognises a refused delete by its code, not its wording", () => {
  const task = (errorCode?: string) =>
    new NemauTaskFailedError({
      id: "t1",
      taskType: "compute:delete",
      status: "failed",
      progress: 0,
      error: "detach volume(s) data before deleting the instance",
      ...(errorCode ? { errorCode } : {}),
      createdAt: "2026-10-01T10:00:00Z",
    });

  assert.equal(isResourceInUse(task("resource_in_use")), true);
  assert.equal(isResourceInUse(task()), false);
  assert.equal(isResourceInUse(task("something_else")), false);
  assert.equal(isResourceInUse(new Error("detach volume(s) data before deleting the instance")), false);
  assert.equal(isResourceInUse(undefined), false);
});
