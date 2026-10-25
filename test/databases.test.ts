import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFor, json, startStub, type RecordedRequest } from "./helpers.ts";
import { IDEMPOTENCY_KEY_HEADER, type Database } from "../src/index.ts";

const SUBNET = "0b5f3c1e-2d4a-4f6b-8c9d-1e2f3a4b5c6d";
const SG = "7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d";
const DB = "11111111-2222-4333-8444-555555555555";
const PASSWORD = "Qx7mP2vL9nR4tY6wZ1aB3cD5eF8gH0jK2lM4nP6rS8tU";

const validCreate = {
  name: "orders-db",
  version: "17",
  flavor: "db-medium",
  storage_gb: 50,
  subnet_id: SUBNET,
  admin_username: "app_admin",
};

function headerOf(req: RecordedRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Runs a call against a stub that answers 202 with a task; the call must refuse before any request. */
async function assertRefusedLocally(call: (client: ReturnType<typeof clientFor>) => Promise<unknown>, message: RegExp): Promise<void> {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await assert.rejects(call(clientFor(stub)), message);
    assert.equal(stub.requests.length, 0, "no request must leave the client");
  } finally {
    await stub.close();
  }
}

test("lists, reads and fetches the CA of the databases", async () => {
  const stub = await startStub((req, res) => {
    if (req.path.endsWith("/ca-certificate")) return json(res, { ca_certificate_pem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n" });
    if (req.path === "/api/v1/databases") return json(res, { databases: [{ id: DB, name: "orders-db" }], count: 1 });
    return json(res, { id: DB, name: "orders-db", port: 5432, status: "active" });
  });
  try {
    const client = clientFor(stub);
    const list = await client.databases.list();
    assert.equal(list[0]?.id, DB);
    const db = await client.databases.get(DB);
    assert.equal(db.port, 5432);
    const pem = await client.databases.caCertificate();
    assert.match(pem, /BEGIN CERTIFICATE/);
    assert.deepEqual(
      stub.requests.map((r) => `${r.method} ${r.path}`),
      ["GET /api/v1/databases", `GET /api/v1/databases/${DB}`, "GET /api/v1/databases/ca-certificate"],
    );
  } finally {
    await stub.close();
  }
});

test("create sends exactly the fields it was given and returns the password once", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t-1", username: "app_admin", password: PASSWORD }, 202));
  try {
    const out = await clientFor(stub).databases.create({
      ...validCreate,
      security_group_ids: [SG],
      backup_retention_days: 14,
      maintenance_window: { weekday: 0, hour: 3 },
    });
    assert.equal(out.password, PASSWORD);
    assert.equal(out.task_id, "t-1");
    const req = stub.requests[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/api/v1/databases");
    assert.deepEqual(JSON.parse(req.body), {
      ...validCreate,
      security_group_ids: [SG],
      backup_retention_days: 14,
      maintenance_window: { weekday: 0, hour: 3 },
    });
  } finally {
    await stub.close();
  }
});

test("a password route never carries an Idempotency-Key, even under withIdempotencyKey", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", username: "app_admin", password: PASSWORD }, 202));
  try {
    await clientFor(stub).withIdempotencyKey("op-42").databases.create(validCreate);
    assert.equal(headerOf(stub.requests[0]!, IDEMPOTENCY_KEY_HEADER), undefined);
  } finally {
    await stub.close();
  }
});

test("a 202 without a password is refused, and the error names no part of the answer", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", username: "app_admin" }, 202));
  try {
    await assert.rejects(clientFor(stub).databases.create(validCreate), (error: Error) => {
      assert.match(error.message, /without a database password/);
      return true;
    });
  } finally {
    await stub.close();
  }
});

test("create refuses out-of-range and reserved values before any request", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ name: "Orders" }, /database name/],
    [{ name: "1db" }, /database name/],
    [{ storage_gb: 9 }, /storage_gb must be between 10 and 2000/],
    [{ storage_gb: 2001 }, /storage_gb/],
    [{ storage_gb: 10.5 }, /storage_gb/],
    [{ admin_username: "postgres" }, /reserved/],
    [{ admin_username: "pg_monitor" }, /reserved/],
    [{ admin_username: "nemau_ops" }, /reserved/],
    [{ admin_username: "ab" }, /admin_username/],
    [{ subnet_id: "not-a-uuid" }, /subnet_id must be a UUID/],
    [{ security_group_ids: [SG, SG, SG, SG, SG, SG] }, /at most 5/],
    [{ security_group_ids: ["nope"] }, /must hold UUIDs/],
    [{ backup_retention_days: 0 }, /backup_retention_days must be between 1 and 35/],
    [{ backup_retention_days: 36 }, /backup_retention_days/],
    [{ maintenance_window: { weekday: 7, hour: 3 } }, /maintenance_window/],
    [{ maintenance_window: { weekday: 1, hour: 24 } }, /maintenance_window/],
    [{ description: "line\nbreak" }, /control characters/],
    [{ description: "x".repeat(257) }, /too long/],
  ];
  for (const [patch, message] of cases) {
    await assertRefusedLocally((client) => client.databases.create({ ...validCreate, ...patch } as never), message);
  }
});

test("update sends only the fields it names, and refuses an empty update", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    const client = clientFor(stub);
    await client.databases.update(DB, { backup_retention_days: 30 });
    assert.equal(stub.requests[0]!.method, "PATCH");
    assert.equal(stub.requests[0]!.path, `/api/v1/databases/${DB}`);
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { backup_retention_days: 30 });
  } finally {
    await stub.close();
  }
  await assertRefusedLocally((client) => client.databases.update(DB, {}), /no field to change/);
  await assertRefusedLocally((client) => client.databases.update(DB, { backup_retention_days: 0 }), /between 1 and 35/);
});

test("resize needs a flavor or a storage size, and a known apply_at", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).databases.resize(DB, { flavor: "db-large", apply_at: "maintenance_window" });
    assert.equal(stub.requests[0]!.path, `/api/v1/databases/${DB}/resize`);
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { flavor: "db-large", apply_at: "maintenance_window" });
  } finally {
    await stub.close();
  }
  await assertRefusedLocally((client) => client.databases.resize(DB, {}), /needs a flavor, a storage_gb, or both/);
  await assertRefusedLocally((client) => client.databases.resize(DB, { storage_gb: 5 }), /storage_gb/);
  await assertRefusedLocally((client) => client.databases.resize(DB, { flavor: "db-large", apply_at: "later" as never }), /apply_at/);
});

test("rotatePassword returns the new password once and sends no Idempotency-Key", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", database_id: DB, username: "app_admin", password: PASSWORD }, 202));
  try {
    const out = await clientFor(stub).databases.rotatePassword(DB);
    assert.equal(out.password, PASSWORD);
    assert.equal(out.database_id, DB);
    assert.equal(stub.requests[0]!.path, `/api/v1/databases/${DB}/rotate-password`);
    assert.equal(headerOf(stub.requests[0]!, IDEMPOTENCY_KEY_HEADER), undefined);
  } finally {
    await stub.close();
  }
});

test("restore posts to the source and converts a Date to RFC 3339", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", username: "app_admin", password: PASSWORD }, 202));
  try {
    const target = new Date("2026-10-20T10:30:00Z");
    await clientFor(stub).databases.restore(DB, {
      name: "orders-restored",
      target_time: target,
      flavor: "db-medium",
      storage_gb: 50,
      subnet_id: SUBNET,
      admin_username: "app_admin",
    });
    const req = stub.requests[0]!;
    assert.equal(req.path, `/api/v1/databases/${DB}/restore`);
    assert.deepEqual(JSON.parse(req.body), {
      name: "orders-restored",
      target_time: "2026-10-20T10:30:00.000Z",
      flavor: "db-medium",
      storage_gb: 50,
      subnet_id: SUBNET,
      admin_username: "app_admin",
    });
    assert.equal(headerOf(req, IDEMPOTENCY_KEY_HEADER), undefined);
  } finally {
    await stub.close();
  }
  await assertRefusedLocally(
    (client) => client.databases.restore(DB, { name: "x", target_time: new Date(Date.now() + 60_000), flavor: "db-medium", storage_gb: 50, subnet_id: SUBNET, admin_username: "app_admin" }),
    /not be in the future/,
  );
  await assertRefusedLocally(
    (client) => client.databases.restore(DB, { name: "x", target_time: "yesterday", flavor: "db-medium", storage_gb: 50, subnet_id: SUBNET, admin_username: "app_admin" }),
    /RFC 3339/,
  );
});

test("delete keeps its backups unless purgeBackups is set", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    const client = clientFor(stub);
    await client.databases.delete(DB);
    await client.databases.delete(DB, { purgeBackups: true });
    assert.equal(stub.requests[0]!.method, "DELETE");
    assert.equal(stub.requests[0]!.query, "");
    assert.equal(stub.requests[1]!.query, "purge_backups=true");
  } finally {
    await stub.close();
  }
});

/** The view of a database as GET returns it, with a deferred resize and a restore window. */
const VIEW: Database = {
  id: DB,
  name: "orders-db",
  description: "Orders",
  status: "active",
  version: "17",
  flavor: "db-medium",
  storage_gb: 50,
  subnet_id: SUBNET,
  security_group_ids: [SG],
  admin_username: "app_admin",
  address: "10.20.0.12",
  port: 5432,
  backup_retention_days: 7,
  maintenance_window: { weekday: 0, hour: 3 },
  earliest_restorable_time: "2026-10-18T00:00:00Z",
  latest_restorable_time: "2026-10-25T09:12:00Z",
  pending_resize: { flavor: "db-large", storage_gb: 100, apply_at: "2026-10-26T03:00:00Z" },
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-25T09:00:00Z",
};

test("the view decodes the status, the restore window and a pending resize; a deleted one closes its window", async () => {
  const deleted = { ...VIEW, status: "deleted", pending_resize: null, latest_restorable_time: undefined, restorable_until: "2026-11-01T00:00:00Z" };
  const stub = await startStub((req, res) => json(res, req.path.endsWith("/gone") ? deleted : VIEW));
  try {
    const client = clientFor(stub);
    const live = await client.databases.get(DB);
    assert.deepEqual(live, VIEW);
    assert.equal(live.pending_resize?.apply_at, "2026-10-26T03:00:00Z");
    const gone = await client.databases.get("gone");
    assert.equal(gone.status, "deleted");
    assert.equal(gone.pending_resize, null);
    assert.equal(gone.restorable_until, "2026-11-01T00:00:00Z");
  } finally {
    await stub.close();
  }
});

test("resize sends no apply_at by default, so the server applies it now", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).databases.resize(DB, { storage_gb: 60 });
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { storage_gb: 60 });
  } finally {
    await stub.close();
  }
});

test("flavors and versions read the region's catalogs", async () => {
  const stub = await startStub((req, res) => {
    if (req.path.endsWith("/database-flavors")) {
      return json(res, { flavors: [{ name: "db-small", vcpus: 2, memory_mb: 4096 }] });
    }
    return json(res, { versions: ["16", "17"] });
  });
  try {
    const client = clientFor(stub);
    assert.deepEqual(await client.databases.flavors(), [{ name: "db-small", vcpus: 2, memory_mb: 4096 }]);
    assert.deepEqual(await client.databases.versions(), ["16", "17"]);
    assert.deepEqual(
      stub.requests.map((r) => `${r.method} ${r.path}`),
      ["GET /api/v1/database-flavors", "GET /api/v1/database-versions"],
    );
  } finally {
    await stub.close();
  }
});

test("restart posts to the database's restart route with no body", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).databases.restart(DB);
    assert.equal(stub.requests[0]!.method, "POST");
    assert.equal(stub.requests[0]!.path, `/api/v1/databases/${DB}/restart`);
    assert.equal(stub.requests[0]!.body, "");
  } finally {
    await stub.close();
  }
});

test("update sends an explicit null to clear the maintenance window", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).databases.update(DB, { maintenance_window: null });
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { maintenance_window: null });
  } finally {
    await stub.close();
  }
  await assertRefusedLocally((client) => client.databases.update(DB, { maintenance_window: { weekday: 7, hour: 3 } }), /maintenance_window needs/);
});
