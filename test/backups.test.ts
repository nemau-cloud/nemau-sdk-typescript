import { test } from "node:test";
import assert from "node:assert/strict";
import { BackupSchedule, SnapshotOrigin } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

test("a backup update sends exactly the fields given", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t-1", status: "pending" }, 202));
  try {
    await clientFor(stub).compute.updateInstance("i-1", {
      backup_schedule: BackupSchedule.Weekly,
      backup_weekday: 1,
      backup_hour: 3,
      backup_retention_days: 14,
    });
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "PATCH");
    assert.equal(seen.path, "/api/v1/compute/instances/i-1");
    assert.deepEqual(JSON.parse(seen.body), {
      backup_schedule: "weekly",
      backup_weekday: 1,
      backup_hour: 3,
      backup_retention_days: 14,
    });
  } finally {
    await stub.close();
  }
});

test("a schedule can be turned off without other backup fields", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t-1", status: "pending" }, 202));
  try {
    await clientFor(stub).compute.updateInstance("i-1", { backup_schedule: "none" });
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { backup_schedule: "none" });
  } finally {
    await stub.close();
  }
});

test("a name change and a backup change travel in one update", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t-1", status: "pending" }, 202));
  try {
    await clientFor(stub).compute.updateInstance("i-1", { name: "web-2", backup_hour: 23 });
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { name: "web-2", backup_hour: 23 });
  } finally {
    await stub.close();
  }
});

test("an update with no backup field still refuses an empty body", async () => {
  const stub = await startStub((_req, res) => json(res, {}));
  try {
    await assert.rejects(() => clientFor(stub).compute.updateInstance("i-1", {}), /no field to change/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("backup values outside the API ranges are refused before any request", async () => {
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ["unknown schedule", { backup_schedule: "hourly" }, /backup_schedule must be/],
    ["hour 24", { backup_hour: 24 }, /backup_hour must be an integer between 0 and 23/],
    ["hour -1", { backup_hour: -1 }, /backup_hour/],
    ["hour fractional", { backup_hour: 2.5 }, /backup_hour/],
    ["hour as a string", { backup_hour: "2" }, /backup_hour/],
    ["weekday 7", { backup_weekday: 7 }, /backup_weekday must be an integer between 0 and 6/],
    ["retention 0", { backup_retention_days: 0 }, /backup_retention_days must be an integer between 1 and 35/],
    ["retention 36", { backup_retention_days: 36 }, /backup_retention_days/],
    ["retention NaN", { backup_retention_days: Number.NaN }, /backup_retention_days/],
  ];
  for (const [name, update, message] of refused) {
    const stub = await startStub((_req, res) => json(res, { task_id: "t-1", status: "pending" }, 202));
    try {
      await assert.rejects(
        () => clientFor(stub).compute.updateInstance("i-1", update as never),
        message,
        name,
      );
      assert.equal(stub.requests.length, 0, name);
    } finally {
      await stub.close();
    }
  }
});

test("the edges of each backup range are accepted", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t-1", status: "pending" }, 202));
  try {
    const client = clientFor(stub);
    await client.compute.updateInstance("i-1", { backup_hour: 0, backup_weekday: 0, backup_retention_days: 1 });
    await client.compute.updateInstance("i-1", { backup_hour: 23, backup_weekday: 6, backup_retention_days: 35 });
    assert.equal(stub.requests.length, 2);
  } finally {
    await stub.close();
  }
});

test("an instance decodes its backup policy, defaulting to none", async () => {
  const stub = await startStub((req, res) => {
    if (req.path.endsWith("/i-scheduled")) {
      json(res, {
        instance: {
          id: "i-scheduled",
          name: "web",
          status: "running",
          tenant_id: "t",
          sizing: { vcpus: 1, ram_mb: 512, disk_gb: 10 },
          backup_schedule: "weekly",
          backup_hour: 4,
          backup_weekday: 5,
          backup_retention_days: 30,
        },
      });
      return;
    }
    json(res, {
      instance: { id: "i-plain", name: "api", status: "stopped", tenant_id: "t", sizing: { vcpus: 1, ram_mb: 512, disk_gb: 10 }, backup_schedule: "none" },
    });
  });
  try {
    const client = clientFor(stub);
    const scheduled = await client.compute.getInstance("i-scheduled");
    assert.equal(scheduled.backup_schedule, "weekly");
    assert.equal(scheduled.backup_hour, 4);
    assert.equal(scheduled.backup_weekday, 5);
    assert.equal(scheduled.backup_retention_days, 30);

    const plain = await client.compute.getInstance("i-plain");
    assert.equal(plain.backup_schedule, BackupSchedule.None);
    assert.equal(plain.backup_hour, undefined);
    assert.equal(plain.backup_retention_days, undefined);
  } finally {
    await stub.close();
  }
});

test("snapshots decode their origin and expiry", async () => {
  const stub = await startStub((_req, res) =>
    json(res, {
      snapshots: [
        {
          id: "s-1",
          name: "nightly",
          instance_id: "i-1",
          status: "active",
          storage: "object_store",
          restorable: true,
          origin: "scheduled",
          expires_at: "2026-11-20T02:00:00Z",
        },
        { id: "s-2", name: "before-upgrade", instance_id: "i-1", status: "active", storage: "object_store", restorable: true, origin: "manual" },
      ],
    }),
  );
  try {
    const [scheduled, manual] = await clientFor(stub).compute.listSnapshots("i-1");
    assert.equal(scheduled!.origin, SnapshotOrigin.Scheduled);
    assert.equal(scheduled!.expires_at, "2026-11-20T02:00:00Z");
    assert.equal(manual!.origin, SnapshotOrigin.Manual);
    assert.equal(manual!.expires_at, undefined);
  } finally {
    await stub.close();
  }
});
