import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFor, json, startStub } from "./helpers.ts";
import type { CreateInstanceGroupRequest, InstanceGroupDetail } from "../src/index.ts";

/** The read contract API clients rely on: the detail of one group. */
const GOLDEN_TEXT = readFileSync(new URL("./fixtures/instance_group.golden.json", import.meta.url), "utf8");
const GOLDEN = JSON.parse(GOLDEN_TEXT) as InstanceGroupDetail;

const NET = "0b5f3c1e-2d4a-4f6b-8c9d-1e2f3a4b5c6d";
const SUBNET = "1c6f4d2f-3e5b-4a7c-9d0e-2f3a4b5c6d7e";
const SG = "7a8b9c0d-1e2f-4a3b-9c8d-7e6f5a4b3c2d";
const POOL = "2d7a5e3a-4f6c-4b8d-8e1f-3a4b5c6d7e8f";
const GROUP = "33333333-4444-4555-8666-777777777777";
const INSTANCE = "88888888-9999-4aaa-8bbb-cccccccccccc";

const CLOUD_CONFIG = "#cloud-config\npackages:\n  - nginx\n";

const validCreate: CreateInstanceGroupRequest = {
  name: "web-tier",
  network_id: NET,
  subnet_id: SUBNET,
  min_size: 1,
  max_size: 5,
  launch_template: { image_id: "ubuntu-24.04", flavor_id: "gp.small", key_name: "ops", service_level: "99.9%", user_data: CLOUD_CONFIG },
  load_balancer_pools: [{ pool_id: POOL, protocol_port: 443 }],
  scaling_policies: [{ metric: "cpu_percent", target: 60 }],
};

test("lists, reads and lists the activities of a group", async () => {
  const stub = await startStub((req, res) => {
    if (req.path.endsWith("/activities")) {
      return json(res, { activities: [{ id: 7, type: "scale_out", reason: "", instance_id: null, created_at: "2026-10-25T10:00:00Z" }], count: 1 });
    }
    if (req.path.endsWith(`/${GROUP}`)) return json(res, { instance_group: { ...GOLDEN, id: GROUP, name: "web-tier" } });
    return json(res, { instance_groups: [{ id: GROUP, name: "web-tier" }], count: 1 });
  });
  try {
    const client = clientFor(stub);
    assert.equal((await client.instanceGroups.list())[0]?.id, GROUP);
    assert.equal((await client.instanceGroups.get(GROUP)).name, "web-tier");
    assert.equal((await client.instanceGroups.activities(GROUP))[0]?.type, "scale_out");
    assert.deepEqual(
      stub.requests.map((r) => r.path),
      ["/api/v1/compute/instance-groups", `/api/v1/compute/instance-groups/${GROUP}`, `/api/v1/compute/instance-groups/${GROUP}/activities`],
    );
  } finally {
    await stub.close();
  }
});

test("the detail decodes the golden contract, field for field", async () => {
  const stub = await startStub((_req, res) => json(res, { instance_group: GOLDEN }));
  try {
    const group = await clientFor(stub).instanceGroups.get(GOLDEN.id);
    assert.deepEqual(group, GOLDEN);
    assert.equal(group.launch_template.user_data_sha256, "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    assert.equal(group.members[1]?.protected_from_scale_in, true);
    assert.equal(group.activities[0]?.instance_id, "e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7");
    assert.equal(group.activities[1]?.instance_id, null);
  } finally {
    await stub.close();
  }
});

test("the list answers the golden group without its members and activities", async () => {
  const { members: _members, activities: _activities, ...summary } = GOLDEN;
  const stub = await startStub((_req, res) => json(res, { instance_groups: [summary], count: 1 }));
  try {
    const [group] = await clientFor(stub).instanceGroups.list();
    assert.deepEqual(Object.keys(group!).sort(), Object.keys(summary).sort());
    assert.deepEqual(group, summary);
  } finally {
    await stub.close();
  }
});

test("create and update carry the description; an over-long or multi-line one is refused locally", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    const client = clientFor(stub);
    await client.instanceGroups.create({ ...validCreate, description: "Public web tier" });
    await client.instanceGroups.update(GROUP, { description: "" });
    assert.equal(JSON.parse(stub.requests[0]!.body).description, "Public web tier");
    assert.deepEqual(JSON.parse(stub.requests[1]!.body), { description: "" });
  } finally {
    await stub.close();
  }
  await assertRefused((client) => client.instanceGroups.create({ ...validCreate, description: "x".repeat(257) }), /description must be at most 256/);
  await assertRefused((client) => client.instanceGroups.create({ ...validCreate, description: "two\nlines" }), /on one line/);
  await assertRefused((client) => client.instanceGroups.update(GROUP, { description: "tab\there" }), /on one line/);
});

test("create sends the launch template with its user_data and the defaults left to the server", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).instanceGroups.create(validCreate);
    const req = stub.requests[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/api/v1/compute/instance-groups");
    assert.deepEqual(JSON.parse(req.body), {
      name: "web-tier",
      network_id: NET,
      subnet_id: SUBNET,
      min_size: 1,
      max_size: 5,
      launch_template: { image_id: "ubuntu-24.04", flavor_id: "gp.small", key_name: "ops", service_level: "99.9%", user_data: CLOUD_CONFIG },
      load_balancer_pools: [{ pool_id: POOL, protocol_port: 443 }],
      scaling_policies: [{ metric: "cpu_percent", target: 60 }],
    });
  } finally {
    await stub.close();
  }
});

test("create refuses the values the API refuses, before any request", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ name: "Web_Tier" }, /name must be/],
    [{ name: "x".repeat(57) }, /name must be/],
    [{ network_id: "net-1" }, /network_id/],
    [{ subnet_id: "sub-1" }, /subnet_id/],
    [{ max_size: 51 }, /max_size must be between 0 and 50/],
    [{ min_size: 3, max_size: 2 }, /min_size, desired_capacity and max_size/],
    [{ min_size: 1, max_size: 5, desired_capacity: 6 }, /min_size, desired_capacity and max_size/],
    [{ security_groups: [SG, SG, SG, SG, SG, SG] }, /at most 5/],
    [{ load_balancer_pools: [{ pool_id: POOL, protocol_port: 0 }] }, /protocol_port/],
    [{ load_balancer_pools: [{ pool_id: POOL, protocol_port: 80 }, { pool_id: POOL, protocol_port: 81 }] }, /twice/],
    [{ health_check: "load_balancer" }, /not available yet/],
    [{ health_check_grace_seconds: 59 }, /60 and 1800/],
    [{ drain_seconds: 301 }, /0 and 300/],
    [{ scaling_policies: [{ metric: "memory_percent", target: 60 }] }, /not available yet/],
    [{ scaling_policies: [{ metric: "cpu_percent", target: 95 }] }, /target must be between 10 and 90/],
    [{ scaling_policies: [{ metric: "cpu_percent", target: 50 }, { metric: "cpu_percent", target: 60 }] }, /twice/],
    [{ launch_template: { image_id: "ubuntu-24.04", vcpus: 2, ram_mb: 1000, disk_gb: 20 } }, /multiple of 256/],
    [{ launch_template: { image_id: "ubuntu-24.04", vcpus: 2 } }, /together/],
    [{ launch_template: { image_id: "ubuntu-24.04", vcpus: 2, ram_mb: 2048, disk_gb: 20, service_level: "gold" } }, /service_level/],
    [{ launch_template: { image_id: "ubuntu-24.04", flavor_id: "gp.small", user_data: "#!/bin/sh\n" + "x".repeat(16384) } }, /16384 bytes/],
    [{ launch_template: { image_id: "ubuntu-24.04", flavor_id: "gp.small", user_data: "echo hi" } }, /must start with/],
    [{ launch_template: { image_id: "ubuntu-24.04", flavor_id: "gp.small", user_data: "  \n " } }, /must start with|must not be empty/],
  ];
  for (const [patch, message] of cases) {
    const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
    try {
      await assert.rejects(clientFor(stub).instanceGroups.create({ ...validCreate, ...patch } as unknown as CreateInstanceGroupRequest), message);
      assert.equal(stub.requests.length, 0, `no request for ${JSON.stringify(patch)}`);
    } finally {
      await stub.close();
    }
  }
});

test("a refused user_data never shows its document in the error", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    const bad = "echo SECRET-TOKEN-7731\n";
    await assert.rejects(
      clientFor(stub).instanceGroups.create({ ...validCreate, launch_template: { image_id: "ubuntu-24.04", flavor_id: "gp.small", user_data: bad } }),
      (error: Error) => {
        assert.match(error.message, /user_data must start with/);
        assert.ok(!error.message.includes("SECRET"), error.message);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("update sends the fields it names; an empty schedules list clears the schedules", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).instanceGroups.update(GROUP, { schedules: [], max_surge: 2 });
    const req = stub.requests[0]!;
    assert.equal(req.method, "PATCH");
    assert.equal(req.path, `/api/v1/compute/instance-groups/${GROUP}`);
    assert.deepEqual(JSON.parse(req.body), { schedules: [], max_surge: 2 });
  } finally {
    await stub.close();
  }
  await assertRefused((client) => client.instanceGroups.update(GROUP, {}), /no field to change/);
  await assertRefused((client) => client.instanceGroups.update(GROUP, { min_size: 4, max_size: 3 }), /must not exceed max_size/);
  await assertRefused((client) => client.instanceGroups.update(GROUP, { max_surge: 11 }), /max_surge/);
  await assertRefused((client) => client.instanceGroups.update(GROUP, { max_unavailable_pct: 51 }), /max_unavailable_pct/);
  await assertRefused((client) => client.instanceGroups.update(GROUP, { health_check: "load_balancer" } as never), /not available yet/);
  await assertRefused(
    (client) => client.instanceGroups.update(GROUP, { schedules: [{ cron: "0 3 * * *", min_size: 2, max_size: 1 }] }),
    /min_size must not exceed its max_size/,
  );
  await assertRefused((client) => client.instanceGroups.update(GROUP, { schedules: [{ cron: "", min_size: 2 }] }), /cron must be 5 fields/);
});

test("setCapacity, member protection and delete reach their routes", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    const client = clientFor(stub);
    await client.instanceGroups.setCapacity(GROUP, 3);
    await client.instanceGroups.setMemberProtection(GROUP, INSTANCE, true);
    await client.instanceGroups.delete(GROUP);
    await client.instanceGroups.delete(GROUP, { deleteInstances: true });
    const [capacity, protection, plain, withInstances] = stub.requests;
    assert.equal(capacity!.method, "PUT");
    assert.equal(capacity!.path, `/api/v1/compute/instance-groups/${GROUP}/capacity`);
    assert.deepEqual(JSON.parse(capacity!.body), { desired_capacity: 3 });
    assert.equal(protection!.path, `/api/v1/compute/instance-groups/${GROUP}/members/${INSTANCE}/protection`);
    assert.deepEqual(JSON.parse(protection!.body), { protected: true });
    assert.equal(plain!.query, "");
    assert.equal(withInstances!.query, "delete_instances=true");
  } finally {
    await stub.close();
  }
  await assertRefused((client) => client.instanceGroups.setCapacity(GROUP, 51), /desired_capacity must be between 0 and 50/);
});

async function assertRefused(call: (client: ReturnType<typeof clientFor>) => Promise<unknown>, message: RegExp): Promise<void> {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await assert.rejects(call(clientFor(stub)), message);
    assert.equal(stub.requests.length, 0, "no request must leave the client");
  } finally {
    await stub.close();
  }
}

test("refresh posts the shares it is given; an absent one is left to the group", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    const client = clientFor(stub);
    await client.instanceGroups.refresh(GROUP, { max_unavailable_pct: 25, max_surge: 2 });
    await client.instanceGroups.refresh(GROUP);
    await client.instanceGroups.refresh(GROUP, { max_surge: 1 });
    const [full, bare, surge] = stub.requests;
    assert.equal(full!.method, "POST");
    assert.equal(full!.path, `/api/v1/compute/instance-groups/${GROUP}/refresh`);
    assert.deepEqual(JSON.parse(full!.body), { max_unavailable_pct: 25, max_surge: 2 });
    assert.deepEqual(JSON.parse(bare!.body), {});
    assert.deepEqual(JSON.parse(surge!.body), { max_surge: 1 });
  } finally {
    await stub.close();
  }
  await assertRefused((client) => client.instanceGroups.refresh(GROUP, { max_unavailable_pct: 51 }), /max_unavailable_pct must be between 0 and 50/);
  await assertRefused((client) => client.instanceGroups.refresh(GROUP, { max_unavailable_pct: 1.5 }), /max_unavailable_pct must be between 0 and 50/);
  await assertRefused((client) => client.instanceGroups.refresh(GROUP, { max_surge: 0 }), /max_surge must be between 1 and 10/);
  await assertRefused((client) => client.instanceGroups.refresh(GROUP, { max_surge: 11 }), /max_surge must be between 1 and 10/);
});

test("cancelRefresh posts to the cancel route", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).instanceGroups.cancelRefresh(GROUP);
    assert.equal(stub.requests[0]!.method, "POST");
    assert.equal(stub.requests[0]!.path, `/api/v1/compute/instance-groups/${GROUP}/refresh/cancel`);
  } finally {
    await stub.close();
  }
});
