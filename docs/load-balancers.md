# Load balancers

`nemau.loadBalancer` manages load balancers, their listeners, pools, members
and health monitors, and the TLS certificates that listeners serve.

## Creating a load balancer

```ts
const lb = await nemau.loadBalancer.createAndWait({
  name: "front",
  vip_subnet_id: subnetId,
  flavor: "lb-ha",
});

console.log(lb.vip_address, lb.high_availability?.status);
```

The VIP is allocated in `vip_subnet_id`, which is required.

Every new load balancer runs in automatic mode. It accepts HTTP, HTTPS, TCP and
UDP listeners side by side, and there is no engine to choose. The `provider`
field reports `auto`. An older load balancer may report `haproxy` (no UDP
listeners) or `nginx` (UDP listeners only).

`list()`, `get(id)` and `delete(id)` read and delete load balancers.

## Tiers

`flavor` picks the tier, and is fixed at creation. Without it the tier is
`lb-small`, which runs one appliance. `lb-ha`, `lb-medium` and `lb-large` run
two appliances on two hosts, active and standby behind the same VIP.

```ts
for (const tier of await nemau.loadBalancer.listFlavors()) {
  console.log(tier.name, tier.appliances, tier.vcpus, tier.ram_mb, tier.monthly_price, tier.currency);
}
```

`vcpus` and `ram_mb` size each appliance. A high-availability tier runs
`appliances` of them, billed as one load balancer.

On a high-availability tier, `high_availability` reports the state of the
pair:

- `status` is `REDUNDANT` (one active, one standby, on two hosts), `DEGRADED`
  or `UNKNOWN`;
- `reason` says why a pair is `DEGRADED`: `SPLIT_BRAIN`,
  `NO_ACTIVE_APPLIANCE`, `APPLIANCE_UNAVAILABLE` or `SINGLE_HOST`;
- `appliances[].state` is `ACTIVE` (holds the VIP), `STANDBY`, `DOWN` or
  `UNKNOWN`.

Health checks and proxied connections leave from each appliance's own address,
`high_availability.appliances[].address`. The security groups of the pool
members must admit both appliances.

## Listeners, pools and members

```ts
await nemau.waitFor(
  await nemau.loadBalancer.createListener(lb.id, {
    name: "http",
    protocol: "HTTP",
    protocol_port: 80,
  }),
);

await nemau.waitFor(
  await nemau.loadBalancer.createPool(lb.id, {
    name: "web",
    protocol: "HTTP",
    lb_algorithm: "ROUND_ROBIN",
    listener_id: listenerId,
  }),
);

await nemau.waitFor(
  await nemau.loadBalancer.addPoolMember(poolId, {
    name: "web-1",
    address: "10.0.1.10",
    protocol_port: 8080,
  }),
);
```

A member's `weight` defaults to 1 when absent. On a listener,
`admin_state_up` is optional, and the API treats an absent value as `true`.

Reading and deleting:

| Resource | List | Get | Delete |
| --- | --- | --- | --- |
| Listener | `listListeners(lbId)` | `getListener(lbId, id)` | `deleteListener(id)` |
| Pool | `listPools(lbId)` | `getPool(lbId, id)` | `deletePool(poolId)` |
| Member | `listPoolMembers(poolId)` | `getPoolMember(poolId, id)` | `removePoolMember(poolId, memberId)` |
| Health monitor | `listPoolHealthMonitors(poolId)` | `getHealthMonitor(poolId, id)` | `deleteHealthMonitor(poolId, monitorId)` |

Listeners and pools are listed per load balancer: there is no global list.

## Health monitors

```ts
await nemau.waitFor(
  await nemau.loadBalancer.createHealthMonitor(poolId, {
    type: "HTTP",
    delay: 5,
    timeout: 3,
    max_retries: 3,
    url_path: "/healthz",
    expected_codes: "200",
  }),
);
```

`type` is `HTTP`, `HTTPS`, `TCP` or `UDP_CONNECT`. UDP pools report
`UDP_CONNECT`: failures on them are detected passively, and no active probe is
sent.

## TLS certificates

A `TERMINATED_HTTPS` listener decrypts on the load balancer with a certificate
imported into the project. Import is synchronous, and the private key never
comes back.

```ts
const cert = await nemau.loadBalancer.importCertificate({
  name: "www",
  certificate: fullchainPem, // leaf first, chain optional
  private_key: keyPem,       // RSA 2048 to 4096 bits, or ECDSA P-256 or P-384
});

await nemau.loadBalancer.createListener(lbId, {
  name: "https",
  protocol: "TERMINATED_HTTPS",
  protocol_port: 443,
  tls_certificate_ref: cert.id,
});
```

`certificate` holds the leaf, optionally followed by its chain, as in a
`fullchain.pem`. `chain` adds intermediates. The private key must not be
protected by a passphrase.

`tls_certificate_ref` is required for `TERMINATED_HTTPS` and refused for other
protocols.

`listCertificates()` returns the project's certificates, each with the
listeners that serve it in `used_by`. `getCertificate(id)` returns one. A
certificate carries its `fingerprint_sha256`, `subject`, `domains`, `issuer`,
`not_before`, `not_after`, `key_algorithm` and `chain_length`.

A certificate is immutable. To renew one, import the new certificate, point the
listener at it, then delete the old one:

```ts
const renewed = await nemau.loadBalancer.importCertificate({
  name: "www-2027",
  certificate: newFullchainPem,
  private_key: newKeyPem,
});
await nemau.waitFor(
  await nemau.loadBalancer.updateListener(listenerId, { tls_certificate_ref: renewed.id }),
);
await nemau.loadBalancer.deleteCertificate(oldCertificateId);
```

Pointing the listener at the new certificate renews it without downtime.
Deleting a certificate that a listener still serves is refused with a `409`
that `isCertificateInUse` recognises. Other refusals carry a `certificate_*`
`reason` on the `NemauApiError`.

## Updates

`updateLoadBalancer`, `updateListener`, `updatePool`, `updatePoolMember` and
`updateHealthMonitor` change a resource in place. See
[Updating resources](updating-resources.md) for the fields each one accepts.
