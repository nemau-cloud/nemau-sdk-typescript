import { test } from "node:test";
import assert from "node:assert/strict";
import { bindingQuota, quotaAvailable, quotaScope } from "../src/index.ts";
import type { QuotaList } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const QUOTAS: QuotaList = {
  quotas: [
    {
      scope: "tenant",
      dimensions: [
        { name: "cores", unit: "count", used: 95, reserved: 0, limit: 100 },
        { name: "ram", unit: "MB", used: 0, reserved: 0, limit: 51200 },
      ],
    },
    {
      scope: "project",
      project_id: "11111111-1111-1111-1111-111111111111",
      dimensions: [
        { name: "cores", unit: "count", used: 8, reserved: 4, limit: 32 },
        { name: "objectStorage", unit: "bytes", used: 4096, reserved: 0, limit: 107374182400 },
      ],
    },
  ],
};

test("reads both scopes from the quota route", async () => {
  const stub = await startStub((_req, res) => json(res, QUOTAS));
  try {
    const quotas = await clientFor(stub).quotas.get();
    assert.equal(stub.requests[0]!.path, "/api/v1/quotas");
    assert.equal(quotas.quotas.length, 2);
    assert.equal(quotaScope(quotas, "project")?.project_id, "11111111-1111-1111-1111-111111111111");
    assert.equal(quotaScope(quotas, "nowhere"), undefined);
  } finally {
    await stub.close();
  }
});

test("headroom subtracts reservations and never goes negative", () => {
  // The API compares used + reserved + requested to the limit.
  assert.equal(quotaAvailable({ name: "cores", unit: "count", used: 8, reserved: 4, limit: 32 }), 20);
  assert.equal(quotaAvailable({ name: "cores", unit: "count", used: 40, reserved: 5, limit: 32 }), 0);
});

test("the binding dimension is the least headroom, not the smallest limit", () => {
  // A write needs room in both scopes: the organization has the larger limit
  // and still refuses first, with 5 left against the project's 20.
  const cores = bindingQuota(QUOTAS, "cores");
  assert.equal(cores?.limit, 100);
  assert.equal(quotaAvailable(cores!), 5);

  // Reported by one scope only: that one binds.
  assert.equal(bindingQuota(QUOTAS, "objectStorage")?.limit, 107374182400);
  assert.equal(bindingQuota(QUOTAS, "nothing"), undefined);
});
