# Asynchronous writes

A create, a delete or an action answers `202` with a `TaskRef`, and the
platform does the work in the background. The resource does not exist yet when
the method returns.

## TaskRef

Every asynchronous write method returns a `TaskRef`:

| Field | Description |
| --- | --- |
| `task_id` | Identifier of the background task. |
| `status` | Status of the task when the request was accepted. |
| `queue`, `message` | Optional details from the API. |
| `replayed` | `true` when the API recognised the request's idempotency key and answered with the original task. See [Errors and retries](errors-and-retries.md#idempotency-keys). |

## Waiting for a task

```ts
const ref = await nemau.compute.createInstance(request); // 202, nothing exists yet
const task = await nemau.waitFor(ref);                   // resolves when the task completes
```

`waitFor(ref)` and `waitForTask(taskId)` read the task every `pollIntervalMs`
(2 seconds by default) until it reaches a terminal state: `completed`,
`failed` or `cancelled`.

- On `completed`, they return the `Task`.
- On `failed` or `cancelled`, they throw a `NemauTaskFailedError` whose `task`
  property holds the task. See [Errors and retries](errors-and-retries.md).
- A `404` right after the `202` means the task is not readable yet, and
  polling continues.

A `Task` has these fields: `id`, `taskType`, `status`, `progress`,
`resourceId`, `resourceType`, `result`, `error`, `errorCode`, `createdAt` and
`completedAt`. `TaskStatus` lists the status values (`pending`, `running`,
`retrying`, `completed`, `failed`, `cancelled`), and `isTerminal(status)` tells
whether a status is final.

## Getting the id of a new resource

```ts
const ref = await nemau.compute.createInstance(request);
const { id, task } = await nemau.waitForResourceId(ref, "instance_id");
```

`waitForResourceId` waits for the task, then returns the task's `resourceId`
when it is set. Otherwise it returns the first of the given `result` keys that
holds a non-empty string. It throws when it finds none.

## Methods that wait for you

These methods send the write, wait for the task, then read the resource back:

| Method | Returns |
| --- | --- |
| `compute.createInstanceAndWait(request)` | `Instance` |
| `network.createNetworkAndWait(name, description?)` | `Network` |
| `storage.createVolumeAndWait(name, sizeGB, description?)` | `Volume` |
| `loadBalancer.createAndWait(request)` | `LoadBalancer` |
| `kubernetes.createClusterAndWait(request)` | `KubernetesCluster` |
| `dns.createZoneAndWait(request)` | `DNSZone` |
| `dns.verifyZoneAndWait(id, signal?)` | `DNSZone` |

Only `verifyZoneAndWait` accepts an `AbortSignal`. To bound the wait of
another write, call the method that returns the `TaskRef` and pass a signal to
`waitFor`.

## Cancelling a wait and timeouts

`waitFor` and `waitForTask` accept an `AbortSignal`:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);
await nemau.waitForTask(taskId, controller.signal);
```

`AbortSignal.timeout(30_000)` gives the same result in one line. Aborting stops
the wait and rejects with the signal's reason. The task keeps running on the
platform: the API has no endpoint to cancel a task.

The `timeoutMs` client option (60 seconds by default) applies to each HTTP
request, polling requests included. A wait has no deadline of its own, so pass
a signal to bound it.

## Reading tasks

```ts
const task = await nemau.tasks.get(taskId);
const history = await nemau.tasks.listForResource(instanceId);
```

`tasks.get` reads one task by id. `tasks.listForResource` returns the tasks
recorded against one resource. The API has no endpoint to list every task of an
organization.

## Synchronous writes

Some writes answer with their result directly and have no task:

- users and access keys (`nemau.iam`);
- object uploads, deletes and copies, presigned URLs, and S3 access keys
  (`nemau.storage`);
- keypair creation (`compute.createKeypair`) and flavors
  (`compute.createFlavor`, `updateFlavor`, `deleteFlavor`);
- TLS certificate import and deletion (`loadBalancer.importCertificate`,
  `deleteCertificate`);
- Kubernetes preflight checks, maintenance windows and kubeconfig rotation.
