import { test } from "node:test";
import assert from "node:assert/strict";
import { isNotFound, isProjectReady, PROJECT_SCOPE_HEADER } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const PROJECTS = {
  projects: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "staging",
      slug: "staging",
      region: "fr-occitanie-1",
      is_active: true,
      provisioning_status: "active",
      current: false,
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      name: "prod",
      slug: "prod",
      region: "fr-occitanie-1",
      is_active: true,
      provisioning_status: "pending",
      current: true,
    },
  ],
  count: 2,
  current_project_id: "22222222-2222-2222-2222-222222222222",
};

test("no project header until one is selected", async () => {
  // An empty header would read as an empty selector; with no choice made, the
  // credential's own scope must apply as-is.
  const stub = await startStub((_req, res) => json(res, { instances: [] }));
  try {
    await clientFor(stub).compute.listInstances();
    assert.equal(stub.requests[0]!.headers[PROJECT_SCOPE_HEADER.toLowerCase()], undefined);
  } finally {
    await stub.close();
  }
});

test("the selected project travels as a header", async () => {
  const stub = await startStub((_req, res) => json(res, { instances: [] }));
  try {
    await clientFor(stub, { project: "proj-42" }).compute.listInstances();
    assert.equal(stub.requests[0]!.headers[PROJECT_SCOPE_HEADER.toLowerCase()], "proj-42");
  } finally {
    await stub.close();
  }
});

test("forProject returns a new client and leaves the original unchanged", async () => {
  // A client can be shared between concurrent callers, so changing its project
  // in place would affect calls already in flight.
  const stub = await startStub((_req, res) => json(res, { networks: [] }));
  try {
    const base = clientFor(stub);
    const staging = base.forProject("proj-staging");
    const prod = base.forProject("proj-prod");

    for (const client of [base, staging, prod, base]) {
      await client.network.listNetworks();
    }

    const seen = stub.requests.map((r) => r.headers[PROJECT_SCOPE_HEADER.toLowerCase()]);
    assert.deepEqual(seen, [undefined, "proj-staging", "proj-prod", undefined]);
    assert.equal(base.project, "");
  } finally {
    await stub.close();
  }
});

test("forProject keeps the credential and the URL", async () => {
  const stub = await startStub((_req, res) => json(res, { zones: [] }));
  try {
    const { AccessKey } = await import("../src/index.ts");
    const base = clientFor(stub, { credential: new AccessKey("AKIA", "s3cr3t") });
    await base.forProject("proj-9").dns.listZones();

    const seen = stub.requests[0]!;
    assert.equal(seen.headers["x-access-key-id"], "AKIA");
    assert.equal(seen.headers[PROJECT_SCOPE_HEADER.toLowerCase()], "proj-9");
  } finally {
    await stub.close();
  }
});

test("the project comes from the environment when no option is given", async () => {
  const stub = await startStub((_req, res) => json(res, { instances: [] }));
  try {
    const previous = process.env["NEMAU_PROJECT_ID"];
    process.env["NEMAU_PROJECT_ID"] = "proj-env";
    try {
      const { NemauClient } = await import("../src/index.ts");
      const client = new NemauClient({ baseUrl: stub.url });
      assert.equal(client.project, "proj-env");
      // The explicit option must win.
      assert.equal(new NemauClient({ baseUrl: stub.url, project: "proj-opt" }).project, "proj-opt");
    } finally {
      if (previous === undefined) delete process.env["NEMAU_PROJECT_ID"];
      else process.env["NEMAU_PROJECT_ID"] = previous;
    }
  } finally {
    await stub.close();
  }
});

test("list, lookup and current project", async () => {
  const stub = await startStub((_req, res) => json(res, PROJECTS));
  try {
    const nemau = clientFor(stub);

    const list = await nemau.projects.list();
    assert.equal(stub.requests[0]!.path, "/api/v1/projects");
    assert.equal(list.current_project_id, PROJECTS.current_project_id);

    const byId = await nemau.projects.get(PROJECTS.projects[0]!.id);
    assert.equal(byId.name, "staging");

    const byName = await nemau.projects.get("prod");
    assert.equal(byName.id, PROJECTS.projects[1]!.id);

    const current = await nemau.projects.current();
    assert.equal(current?.name, "prod");

    // A project still provisioning is listed but refuses every write.
    assert.equal(isProjectReady(PROJECTS.projects[0]!), true);
    assert.equal(isProjectReady(PROJECTS.projects[1]!), false);
  } finally {
    await stub.close();
  }
});

test("an unknown project yields a 404", async () => {
  const stub = await startStub((_req, res) => json(res, PROJECTS));
  try {
    const nemau = clientFor(stub);
    await assert.rejects(
      () => nemau.projects.get("qa"),
      (error: unknown) => {
        assert.ok(isNotFound(error));
        assert.match((error as Error).message, /: 404 project "qa" not found in this project$/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("current is undefined when nothing resolves", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { projects: [{ ...PROJECTS.projects[0], current: false }], count: 1, current_project_id: "" }),
  );
  try {
    assert.equal(await clientFor(stub).projects.current(), undefined);
  } finally {
    await stub.close();
  }
});
