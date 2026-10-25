import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_OBJECT_PAGE_SIZE, METRIC_PERIODS } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const obj = (name: string) => ({ name, size: 3, content_type: "text/plain", last_modified: "2026-10-10T10:00:00Z" });

test("iterateObjects follows next_marker verbatim until it is empty", async () => {
  const stub = await startStub((req, res) => {
    const marker = new URLSearchParams(req.query).get("marker");
    if (!marker) return json(res, { objects: [obj("a"), obj("b")], next_marker: "b64+/=opaque" });
    if (marker === "b64+/=opaque") return json(res, { objects: [obj("c")], next_marker: "" });
    json(res, { error: "invalid marker" }, 400);
  });
  try {
    const names: string[] = [];
    for await (const o of clientFor(stub).storage.iterateObjects("photos", { prefix: "2026/", pageSize: 2 })) {
      names.push(o.name);
      assert.equal(o.size, 3);
    }
    assert.deepEqual(names, ["a", "b", "c"]);
    assert.equal(stub.requests.length, 2);
    const first = new URLSearchParams(stub.requests[0]!.query);
    assert.equal(first.get("prefix"), "2026/");
    assert.equal(first.get("limit"), "2");
    assert.equal(first.get("marker"), null);
    assert.equal(new URLSearchParams(stub.requests[1]!.query).get("marker"), "b64+/=opaque");
  } finally {
    await stub.close();
  }
});

test("breaking out of iterateObjects requests no further page", async () => {
  const stub = await startStub((_req, res) => json(res, { objects: [obj("a"), obj("b")], next_marker: "m1" }));
  try {
    for await (const o of clientFor(stub).storage.iterateObjects("photos")) {
      assert.equal(o.name, "a");
      break;
    }
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

test("a repeated cursor ends the walk with an error", async () => {
  const stub = await startStub((_req, res) => json(res, { objects: [obj("a")], next_marker: "same" }));
  try {
    await assert.rejects(async () => {
      for await (const _ of clientFor(stub).storage.iterateObjects("photos")) void _;
    }, /same cursor twice/);
    assert.equal(stub.requests.length, 2);
  } finally {
    await stub.close();
  }
});

test("a page size outside 1..1000 is refused before any request", async () => {
  const stub = await startStub((_req, res) => json(res, { objects: [], next_marker: "" }));
  try {
    const nemau = clientFor(stub);
    for (const bad of [0, -1, 1001, 1.5, Number.NaN]) {
      await assert.rejects(nemau.storage.listObjects("photos", { limit: bad }), /between 1 and 1000/, String(bad));
      await assert.rejects(async () => {
        for await (const _ of nemau.storage.iterateObjects("photos", { pageSize: bad })) void _;
      }, /between 1 and 1000/);
    }
    assert.equal(stub.requests.length, 0);
    await nemau.storage.listObjects("photos", { limit: MAX_OBJECT_PAGE_SIZE });
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

test("a server refusal of the marker is surfaced", async () => {
  const stub = await startStub((_req, res) => json(res, { error: "invalid marker" }, 400));
  try {
    await assert.rejects(clientFor(stub).storage.listObjects("photos", { marker: "a-raw-key" }), /400 invalid marker/);
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

test("instance metrics accept only the documented periods", async () => {
  const stub = await startStub((_req, res) => json(res, { points: [] }));
  try {
    const nemau = clientFor(stub);
    for (const period of METRIC_PERIODS) await nemau.compute.instanceMetrics("i-1", period);
    await nemau.compute.instanceMetrics("i-1");
    assert.deepEqual(
      stub.requests.map((r) => r.query),
      ["period=1h", "period=6h", "period=24h", "period=7d", ""],
    );
    const before = stub.requests.length;
    for (const bad of ["30d", "1H", "", "1h&x=1"]) {
      await assert.rejects(nemau.compute.instanceMetrics("i-1", bad as never), /period must be one of 1h, 6h, 24h, 7d/, bad);
    }
    assert.equal(stub.requests.length, before);
  } finally {
    await stub.close();
  }
});
