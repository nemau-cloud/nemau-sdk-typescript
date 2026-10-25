# @nemau-cloud/sdk guide

This guide covers the TypeScript SDK for the Nemau Cloud public API. The
[README](../README.md) shows how to install the package and configure
credentials.

The examples assume a client created from the environment:

```ts
import { NemauClient } from "@nemau-cloud/sdk";

const nemau = new NemauClient();
```

Identifiers such as `instanceId` or `networkId` in the examples stand for
values from your own project.

## Using the client

- [Authentication](authentication.md): credential types, environment variables
  and client options.
- [Organizations and projects](projects.md): which project a call acts on,
  `forProject`, and listing projects.
- [Asynchronous writes](asynchronous-writes.md): `TaskRef`, waiting for tasks,
  `AbortSignal` and timeouts.
- [Updating resources](updating-resources.md): how the `update` methods change
  a resource in place.
- [Errors and retries](errors-and-retries.md): error classes, error helpers,
  the retry policy, idempotency keys and rate limits.

## Services

- [Compute](compute.md): instances, lifecycle actions, resizing, images,
  flavors, keypairs, pricing and metrics.
- [Snapshots](snapshots.md): instance snapshots and restore.
- [Networking](networking.md): networks, subnets, IPv6, floating IPs and
  security groups.
- [Load balancers](load-balancers.md): tiers, listeners, pools, members,
  health monitors and TLS certificates.
- [Managed PostgreSQL](databases.md): databases, the one-time password,
  connecting over TLS, restore from a point in time and password rotation.
- [Instance groups](instance-groups.md): launch templates, membership, target
  tracking, schedules and deletion.
- [Block storage](block-storage.md): volumes.
- [Object storage](object-storage.md): containers, object lock, objects,
  copies, presigned URLs and S3 access keys.
- [DNS](dns.md): zones, ownership verification and record sets.
- [Kubernetes](kubernetes.md): clusters, node pools, kubeconfig and upgrades.
- [IAM](iam.md): users and access keys.
- [Quotas](quotas.md): limits, usage and headroom.
- [Metering](metering.md): consumption, costs and events.
- [Regions](regions.md): regions and their health.
