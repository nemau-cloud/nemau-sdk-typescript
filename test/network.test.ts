import { test } from "node:test";
import assert from "node:assert/strict";
import type { AllocateFloatingIPRequest } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const accepted = { task_id: "t", status: "pending" };

test("the two-string allocation sends no ip_version", async () => {
  // A region without IPv6 receives a request with no ip_version field.
  const stub = await startStub((_req, res) => json(res, accepted, 202));
  try {
    await clientFor(stub).network.allocateFloatingIP("", "front");
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/v1/network/floating-ips");
    assert.equal(seen.body, '{"description":"front"}');
  } finally {
    await stub.close();
  }
});

test("a request object carries the IP version", async () => {
  const cases: Array<[AllocateFloatingIPRequest | undefined, string]> = [
    [{ ip_version: 6 }, '{"ip_version":6}'],
    [{ floating_network_id: "ext-1", ip_version: 4 }, '{"floating_network_id":"ext-1","ip_version":4}'],
    [{}, "{}"],
    [undefined, "{}"],
  ];
  for (const [request, body] of cases) {
    const stub = await startStub((_req, res) => json(res, accepted, 202));
    try {
      await clientFor(stub).network.allocateFloatingIP(request);
      assert.equal(stub.requests[0]!.body, body);
    } finally {
      await stub.close();
    }
  }
});

test("an IPv6 subnet is created without a CIDR", async () => {
  // The platform assigns the /64: the body names the version, not a range.
  const stub = await startStub((_req, res) => json(res, accepted, 202));
  try {
    await clientFor(stub).network.createSubnet("net-1", { name: "v6", ip_version: 6 });
    const seen = stub.requests[0]!;
    assert.equal(seen.path, "/api/v1/network/networks/net-1/subnets");
    assert.deepEqual(JSON.parse(seen.body), { name: "v6", ip_version: 6 });
  } finally {
    await stub.close();
  }
});

test("ip_version is decoded on floating IPs and subnets", async () => {
  const stub = await startStub((req, res) => {
    if (req.path.endsWith("/floating-ips")) {
      json(res, {
        floatingips: [
          { id: "fip-4", address: "203.0.113.7", status: "available" },
          { id: "fip-6", address: "2001:db8:f::10", ip_version: 6, private_address: "10.0.0.5", status: "attached" },
        ],
      });
      return;
    }
    json(res, {
      subnets: [{ id: "sub-6", cidr: "2001:db8:100:1::/64", gateway_ip: "2001:db8:100:1::1", ip_version: 6, allocation_pools: [] }],
    });
  });
  try {
    const nemau = clientFor(stub);
    const fips = await nemau.network.listFloatingIPs();
    assert.equal(fips[0]!.ip_version, undefined);
    assert.equal(fips[1]!.ip_version, 6);
    const subnet = await nemau.network.getSubnet("sub-6");
    assert.equal(subnet.ip_version, 6);
    assert.equal(subnet.cidr, "2001:db8:100:1::/64");
  } finally {
    await stub.close();
  }
});

test("network capabilities are read", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { capabilities: { ipv6_floating_ips: true, ipv6_subnets: false } }),
  );
  try {
    const caps = await clientFor(stub).network.getCapabilities();
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "GET");
    assert.equal(seen.path, "/api/v1/network/capabilities");
    assert.deepEqual(caps, { ipv6_floating_ips: true, ipv6_subnets: false });
  } finally {
    await stub.close();
  }
});

test("a security group is converted to egress filtering without a body", async () => {
  const stub = await startStub((_req, res) => json(res, accepted, 202));
  try {
    const ref = await clientFor(stub).network.enableSecurityGroupEgressFiltering("sg-1");
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/v1/network/security-groups/sg-1/enable-egress-filtering");
    assert.equal(seen.body, "");
    assert.equal(ref.task_id, "t");
  } finally {
    await stub.close();
  }
});

test("a security group reports whether it filters egress", async () => {
  const stub = await startStub((_req, res) =>
    json(res, {
      security_groups: [
        { id: "sg-old", name: "old", egress_filtering: false, rules: [] },
        { id: "sg-new", name: "new", egress_filtering: true, rules: [] },
      ],
      count: 2,
    }),
  );
  try {
    const groups = await clientFor(stub).network.listSecurityGroups();
    assert.deepEqual(
      groups.map((g) => [g.id, g.egress_filtering]),
      [
        ["sg-old", false],
        ["sg-new", true],
      ],
    );
  } finally {
    await stub.close();
  }
});
