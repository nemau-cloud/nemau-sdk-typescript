import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DNS_ZONE_STATUS_ACTIVE,
  DNS_ZONE_STATUS_PENDING_VERIFICATION,
  NemauApiError,
  NemauTaskFailedError,
  REASON_DNS_ZONE_ALREADY_VERIFIED,
  REASON_DNS_ZONE_EXISTS,
  REASON_DNS_ZONE_PENDING_VERIFICATION,
  REASON_DNS_ZONE_RESERVED,
  hasReason,
} from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

/** A zone's id is a UUID, not its name. */
const ZONE_ID = "3f1c9a2e-7b4d-4e8a-9c61-2d5f0b8e4a17";
const OTHER_ZONE_ID = "8a2b6c4d-1e3f-4a5b-8c7d-9e0f1a2b3c4d";

test("a pending zone carries its verification record", async () => {
  const stub = await startStub((_req, res) =>
    json(res, {
      zones: [
        {
          id: ZONE_ID,
          name: "example.com.",
          status: "PENDING_VERIFICATION",
          verification: {
            name: "_nemau-challenge.example.com.",
            type: "TXT",
            value: "nemau-verification=abc123",
          },
        },
        { id: OTHER_ZONE_ID, name: "example.org.", status: "ACTIVE" },
      ],
      count: 2,
    }),
  );
  try {
    const nemau = clientFor(stub);
    const pending = await nemau.dns.getZone(ZONE_ID);
    assert.equal(pending.status, DNS_ZONE_STATUS_PENDING_VERIFICATION);
    assert.deepEqual(pending.verification, {
      name: "_nemau-challenge.example.com.",
      type: "TXT",
      value: "nemau-verification=abc123",
    });
    const active = await nemau.dns.getZone(OTHER_ZONE_ID);
    assert.equal(active.status, DNS_ZONE_STATUS_ACTIVE);
    assert.equal(active.verification, undefined);
  } finally {
    await stub.close();
  }
});

test("verifyZone posts to the zone's verify action", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    const ref = await clientFor(stub).dns.verifyZone(ZONE_ID);
    assert.equal(ref.task_id, "t");
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, `/api/v1/dns/zones/${ZONE_ID}/verify`);
    assert.equal(seen.body, "");
  } finally {
    await stub.close();
  }
});

/** Serves the verify write, its task, then the zone list. */
function verifyStub(terminal: "completed" | "failed") {
  return startStub((req, res) => {
    if (req.method === "POST" && req.path.endsWith("/verify")) {
      return json(res, { task_id: "task-1", status: "pending" }, 202);
    }
    if (req.path.startsWith("/api/v1/tasks/")) {
      return json(res, {
        id: "task-1",
        taskType: "dns:verify_zone",
        status: terminal,
        progress: 100,
        ...(terminal === "failed"
          ? { error: "TXT record _nemau-challenge.example.com. not found" }
          : { result: { zone_id: ZONE_ID, status: "ACTIVE" } }),
      });
    }
    json(res, { zones: [{ id: ZONE_ID, name: "example.com.", status: "ACTIVE" }], count: 1 });
  });
}

test("verifyZoneAndWait returns the active zone", async () => {
  const stub = await verifyStub("completed");
  try {
    const zone = await clientFor(stub).dns.verifyZoneAndWait(ZONE_ID);
    assert.equal(zone.status, DNS_ZONE_STATUS_ACTIVE);
    assert.equal(zone.verification, undefined);
  } finally {
    await stub.close();
  }
});

test("verifyZoneAndWait reports a missing record as a failed task", async () => {
  const stub = await verifyStub("failed");
  try {
    await assert.rejects(
      () => clientFor(stub).dns.verifyZoneAndWait(ZONE_ID),
      (error: unknown) => error instanceof NemauTaskFailedError && /not found/.test(error.message),
    );
    // No zone read after a failed check.
    assert.ok(stub.requests.every((r) => r.path !== "/api/v1/dns/zones"));
  } finally {
    await stub.close();
  }
});

test("DNS refusals are recognisable by their reason", async () => {
  const cases: Array<[number, string, (c: ReturnType<typeof clientFor>) => Promise<unknown>]> = [
    [400, REASON_DNS_ZONE_RESERVED, (c) => c.dns.createZone({ name: "x.nemau-cloud.fr.", email: "a@b.c" })],
    [409, REASON_DNS_ZONE_EXISTS, (c) => c.dns.createZone({ name: "example.com.", email: "a@b.c" })],
    [409, REASON_DNS_ZONE_ALREADY_VERIFIED, (c) => c.dns.verifyZone(ZONE_ID)],
    [
      409,
      REASON_DNS_ZONE_PENDING_VERIFICATION,
      (c) => c.dns.createRecordSet(ZONE_ID, { name: "www", type: "A", records: ["203.0.113.7"] }),
    ],
  ];
  for (const [status, reason, call] of cases) {
    const stub = await startStub((_req, res) => json(res, { error: "refused", reason }, status));
    try {
      await assert.rejects(
        () => call(clientFor(stub)),
        (error: unknown) => hasReason(error, reason) && !hasReason(error, "some_other_reason"),
      );
    } finally {
      await stub.close();
    }
  }
  assert.equal(hasReason(new Error("dns_zone_exists"), REASON_DNS_ZONE_EXISTS), false);
  assert.equal(
    hasReason(new NemauApiError({ statusCode: 409, message: "x", method: "POST", path: "/" }), ""),
    false,
  );
});

test("createZoneAndWait returns the pending zone by its UUID", async () => {
  const stub = await startStub((req, res) => {
    if (req.method === "POST") return json(res, { task_id: "task-1", status: "pending" }, 202);
    if (req.path.startsWith("/api/v1/tasks/")) {
      return json(res, {
        id: "task-1",
        taskType: "dns:create_zone",
        status: "completed",
        progress: 100,
        result: { zone_id: ZONE_ID, status: "PENDING_VERIFICATION" },
      });
    }
    json(res, {
      zones: [
        {
          id: ZONE_ID,
          name: "example.com.",
          status: "PENDING_VERIFICATION",
          verification: { name: "_nemau-challenge.example.com.", type: "TXT", value: "nemau-verification=abc123" },
        },
      ],
      count: 1,
    });
  });
  try {
    const zone = await clientFor(stub).dns.createZoneAndWait({ name: "example.com.", email: "dns@example.com" });
    assert.equal(zone.id, ZONE_ID);
    assert.equal(zone.status, DNS_ZONE_STATUS_PENDING_VERIFICATION);
    assert.ok(zone.verification);
  } finally {
    await stub.close();
  }
});
