import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFor, json, startStub } from "./helpers.ts";

test("load-balancer tiers are listed from their own endpoint", async () => {
  const stub = await startStub((_req, res) =>
    json(res, {
      flavors: [
        { name: "lb-small", appliances: 1, vcpus: 1, ram_mb: 1024, high_availability: false, hourly_price: 0.0074, monthly_price: 5.4, currency: "eur" },
        { name: "lb-ha", appliances: 2, vcpus: 1, ram_mb: 1024, high_availability: true, hourly_price: 0.0141, monthly_price: 10.3, currency: "eur" },
      ],
      default: "lb-small",
    }),
  );
  try {
    const flavors = await clientFor(stub).loadBalancer.listFlavors();
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "GET");
    assert.equal(seen.path, "/api/v1/network/load-balancer-flavors");
    assert.equal(flavors.length, 2);
    assert.equal(flavors[1]!.name, "lb-ha");
    assert.equal(flavors[1]!.high_availability, true);
    assert.equal(flavors[1]!.monthly_price, 10.3);
  } finally {
    await stub.close();
  }
});

test("the tier travels with a create only when it is set", async () => {
  for (const [flavor, expected] of [["lb-large", '"flavor":"lb-large"'], [undefined, undefined]] as const) {
    const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
    try {
      await clientFor(stub).loadBalancer.create({ name: "edge", vip_subnet_id: "sub-1", ...(flavor ? { flavor } : {}) });
      const body = stub.requests[0]!.body;
      if (expected) assert.ok(body.includes(expected), body);
      else assert.ok(!body.includes("flavor"), body);
    } finally {
      await stub.close();
    }
  }
});

test("a create never carries an engine", async () => {
  // There is no engine to choose: the API applies automatic mode.
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).loadBalancer.create({ name: "edge", vip_subnet_id: "sub-1" });
    const body = stub.requests[0]!.body;
    assert.ok(!body.includes("provider"), body);
  } finally {
    await stub.close();
  }
});

test("the HA state of a pair is decoded", async () => {
  const stub = await startStub((_req, res) =>
    json(res, {
      load_balancer: {
        id: "lb-1", name: "edge", provider: "auto", provisioning_status: "ACTIVE", admin_state_up: true,
        listeners: [], pools: [], flavor: "lb-ha",
        high_availability: {
          status: "REDUNDANT",
          appliances: [
            { index: 1, state: "STANDBY", address: "10.0.0.11" },
            { index: 2, state: "ACTIVE", address: "10.0.0.12" },
          ],
        },
      },
    }),
  );
  try {
    const lb = await clientFor(stub).loadBalancer.get("lb-1");
    assert.equal(lb.flavor, "lb-ha");
    assert.equal(lb.provider, "auto");
    assert.equal(lb.high_availability?.status, "REDUNDANT");
    assert.equal(lb.high_availability?.appliances[1]?.state, "ACTIVE");
  } finally {
    await stub.close();
  }
});
