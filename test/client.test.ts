import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessKey,
  BearerToken,
  credentialFromEnv,
  isForbidden,
  isSubnetOverlap,
  NemauApiError,
  NemauClient,
  REASON_SUBNET_OVERLAP,
} from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

test("an access key sets its two headers and nothing else", async () => {
  const stub = await startStub((_req, res) => json(res, { instances: [] }));
  try {
    const nemau = clientFor(stub, { credential: new AccessKey("AKIA", "s3cr3t") });
    await nemau.compute.listInstances();

    const seen = stub.requests[0]!;
    assert.equal(seen.path, "/api/v1/compute/instances");
    assert.equal(seen.headers["x-access-key-id"], "AKIA");
    assert.equal(seen.headers["x-access-key-secret"], "s3cr3t");
    // The SDK sends exactly one credential: a leftover Authorization header
    // would make the API authenticate the wrong one.
    assert.equal(seen.headers["authorization"], undefined);
    assert.match(String(seen.headers["user-agent"]), /^nemau-sdk-js\//);
  } finally {
    await stub.close();
  }
});

test("a service-account token goes in Bearer", async () => {
  const stub = await startStub((_req, res) => json(res, { zones: [] }));
  try {
    await clientFor(stub, { credential: new BearerToken("jwt") }).dns.listZones();
    assert.equal(stub.requests[0]!.headers["authorization"], "Bearer jwt");
  } finally {
    await stub.close();
  }
});

test("the access key wins over NEMAU_TOKEN", () => {
  // A stale NEMAU_TOKEN left in a shell must not replace the long-lived
  // credential.
  const both = credentialFromEnv({
    NEMAU_ACCESS_KEY_ID: "id",
    NEMAU_ACCESS_KEY_SECRET: "secret",
    NEMAU_TOKEN: "token",
  });
  assert.ok(both instanceof AccessKey);

  const tokenOnly = credentialFromEnv({ NEMAU_TOKEN: "token" });
  assert.ok(tokenOnly instanceof BearerToken);

  assert.equal(credentialFromEnv({}), undefined);
});

test("an API error keeps its message and reason", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { error: "not authorized for compute:Write", reason: "permission_denied" }, 403),
  );
  try {
    const nemau = clientFor(stub);
    await assert.rejects(
      () => nemau.compute.createInstance({ name: "x", image_id: "img" }),
      (error: unknown) => {
        assert.ok(error instanceof NemauApiError);
        assert.ok(isForbidden(error));
        assert.match(error.message, /not authorized for compute:Write/);
        assert.match(error.message, /permission_denied/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("a subnet overlap is recognisable and names the conflict", async () => {
  const stub = await startStub((_req, res) =>
    json(
      res,
      {
        error:
          'cidr 10.0.1.0/24 overlaps subnet "app" (10.0.0.0/16) on network "backend"; the subnets of a project are routed together, so their ranges must not overlap',
        reason: REASON_SUBNET_OVERLAP,
      },
      409,
    ),
  );
  try {
    const nemau = clientFor(stub);
    await assert.rejects(
      () => nemau.network.createSubnet("net-1", { name: "web", cidr: "10.0.1.0/24" }),
      (error: unknown) => {
        assert.ok(isSubnetOverlap(error));
        assert.ok(error instanceof NemauApiError);
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /overlaps subnet "app" \(10\.0\.0\.0\/16\) on network "backend"/);
        return true;
      },
    );
    assert.equal(stub.requests.length, 1, "a refusal must not be retried");
  } finally {
    await stub.close();
  }

  const others: unknown[] = [
    new NemauApiError({ statusCode: 409, message: "listener already has a pool", method: "POST", path: "/x" }),
    new NemauApiError({ statusCode: 403, message: "no", reason: "permission_denied", method: "POST", path: "/x" }),
    new Error("subnet_overlap"),
    undefined,
  ];
  for (const other of others) assert.equal(isSubnetOverlap(other), false);
});

test("a 503 is retried, a 400 is not", async () => {
  let calls = 0;
  const stub = await startStub((_req, res) => {
    calls += 1;
    if (calls < 3) return json(res, { error: "upstream unavailable" }, 503);
    json(res, { networks: [{ id: "net-1", name: "prod" }] });
  });
  try {
    const networks = await clientFor(stub).network.listNetworks();
    assert.equal(networks.length, 1);
    assert.equal(calls, 3);
  } finally {
    await stub.close();
  }

  const bad = await startStub((_req, res) => json(res, { error: "sizing required" }, 400));
  try {
    const nemau = clientFor(bad);
    await assert.rejects(() => nemau.compute.createInstance({ name: "x", image_id: "i" }));
    assert.equal(bad.requests.length, 1, "a 400 must not be retried");
  } finally {
    await bad.close();
  }
});

test("a write with no task id is an error", async () => {
  // Returning an empty reference would turn this into a wait that never
  // resolves.
  const stub = await startStub((_req, res) => json(res, {}, 202));
  try {
    const nemau = clientFor(stub);
    await assert.rejects(
      () => nemau.network.createNetwork("prod"),
      /returned no task id/,
    );
  } finally {
    await stub.close();
  }
});

test("an invalid baseUrl is refused at construction", () => {
  assert.throws(() => new NemauClient({ baseUrl: "not-a-url" }));
});
