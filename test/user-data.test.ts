import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { USER_DATA_MAX_BYTES, type CreateInstanceRequest } from "../src/services/compute.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const accepted = (res: ServerResponse) => {
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ task_id: "task-1", status: "pending" }));
};

const base: CreateInstanceRequest = { name: "web", image_id: "ubuntu", vcpus: 1, ram_mb: 512, disk_gb: 10 };

test("the create body carries user_data only when it is set", async () => {
  const stub = await startStub((_req, res) => accepted(res));
  try {
    const nemau = clientFor(stub);
    await nemau.compute.createInstance(base);
    await nemau.compute.createInstance({ ...base, user_data: "#cloud-config\nruncmd: [echo hi]\n" });
    await nemau.compute.createInstance({ ...base, user_data: "" });
    const [without, withData, empty] = stub.requests.map((r) => JSON.parse(r.body) as Record<string, unknown>);
    assert.equal("user_data" in without!, false);
    assert.equal(withData!.user_data, "#cloud-config\nruncmd: [echo hi]\n");
    assert.equal(empty!.user_data, "");
  } finally {
    await stub.close();
  }
});

test("user_data is accepted up to 16 KiB measured in UTF-8 bytes", async () => {
  const stub = await startStub((_req, res) => accepted(res));
  try {
    const nemau = clientFor(stub);
    assert.equal(USER_DATA_MAX_BYTES, 16384);
    await nemau.compute.createInstance({ ...base, user_data: "a".repeat(16384) });
    // "é" is 2 bytes: 8192 of them fill the limit exactly.
    await nemau.compute.createInstance({ ...base, user_data: "é".repeat(8192) });
    assert.equal(stub.requests.length, 2);
  } finally {
    await stub.close();
  }
});

test("oversized user_data is refused before any request", async () => {
  const stub = await startStub((_req, res) => accepted(res));
  try {
    const nemau = clientFor(stub);
    // 9000 characters but 18000 bytes: a character count would pass, the byte check must not.
    const cases = ["a".repeat(16385), "é".repeat(9000)];
    for (const user_data of cases) {
      await assert.rejects(
        nemau.compute.createInstance({ ...base, user_data }),
        /user_data is \d+ bytes; the limit is 16384/,
      );
    }
    await assert.rejects(
      nemau.compute.createInstanceAndWait({ ...base, user_data: "a".repeat(16385) }),
      /user_data is/,
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("user_data with a NUL, a lone surrogate or a non-string is refused before any request", async () => {
  const stub = await startStub((_req, res) => accepted(res));
  try {
    const nemau = clientFor(stub);
    const bad: unknown[] = ["#!/bin/sh\0echo", "broken \uD800 text", "bad \uDC00", 42, null, { text: "x" }];
    for (const user_data of bad) {
      await assert.rejects(
        nemau.compute.createInstance({ ...base, user_data: user_data as string }),
        /^Error: nemau: user_data must /,
        String(user_data),
      );
    }
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("the error text never repeats the document", async () => {
  const stub = await startStub((_req, res) => accepted(res));
  try {
    const secret = "password=s3cr3t-value\0";
    const error = await clientFor(stub)
      .compute.createInstance({ ...base, user_data: secret })
      .then(() => undefined, (e: unknown) => e as Error);
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /s3cr3t/);
  } finally {
    await stub.close();
  }
});

test("an instance reports user_data_sha256 from get and list, and omits it when unset", async () => {
  const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const stub = await startStub((req, res) => {
    const withData = { id: "i-1", name: "web", status: "running", tenant_id: "t", sizing: {}, user_data_sha256: sha };
    const without = { id: "i-2", name: "db", status: "running", tenant_id: "t", sizing: {} };
    if (req.path === "/api/v1/compute/instances") return json(res, { instances: [withData, without] });
    return json(res, { instance: withData });
  });
  try {
    const nemau = clientFor(stub);
    const [listed, unset] = await nemau.compute.listInstances();
    assert.equal(listed!.user_data_sha256, sha);
    assert.match(listed!.user_data_sha256!, /^[0-9a-f]{64}$/);
    assert.equal(unset!.user_data_sha256, undefined);
    assert.equal((await nemau.compute.getInstance("i-1")).user_data_sha256, sha);
  } finally {
    await stub.close();
  }
});
