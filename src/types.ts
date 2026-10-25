/**
 * The shapes the API returns.
 *
 * Field names match the API's JSON exactly. Most resources use snake_case;
 * tasks, Kubernetes clusters and IAM objects use camelCase.
 */

/** Status of a background task. */
export const TaskStatus = {
  Pending: "pending",
  Running: "running",
  Retrying: "retrying",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;

export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * The 202 answer to a write. It identifies the background task; the resource
 * does not exist yet when this returns.
 */
export interface TaskRef {
  task_id: string;
  status: string;
  queue?: string;
  message?: string;
  /**
   * True when the API recognised the write's Idempotency-Key and answered with
   * the original task instead of creating a new one. Absent otherwise.
   */
  replayed?: boolean;
}

/**
 * The public view of a background task.
 *
 * The API leaves out internal details: parameters, retry counters, idempotency
 * key, the user who started the task, and the raw infrastructure error.
 */
export interface Task {
  id: string;
  taskType: string;
  status: string;
  progress: number;
  resourceId?: string;
  resourceType?: string;
  result?: Record<string, unknown>;
  error?: string;
  /**
   * Classifies a failure the API chose to explain, so a caller can react without
   * reading `error`. Today: {@link ERROR_CODE_RESOURCE_IN_USE}. Absent for any
   * other failure and on a task that did not fail.
   */
  errorCode?: string;
  createdAt: string;
  completedAt?: string;
}

/**
 * A delete the platform refused because something still depends on the resource
 * (a volume attached to an instance, a subnet on a network). Remove the
 * dependant first, then retry; repeating the same call cannot succeed.
 */
export const ERROR_CODE_RESOURCE_IN_USE = "resource_in_use";

/** The { id, name } envelope used for image, flavor and security groups. */
export interface Ref {
  id?: string;
  name?: string;
}

/** A node's CPU/RAM/disk shape. */
export interface Sizing {
  vcpus: number;
  ram_mb: number;
  disk_gb: number;
}

/**
 * When an instance's scheduled backups run. `none` (the default) takes no
 * scheduled backup.
 */
export const BackupSchedule = {
  None: "none",
  Daily: "daily",
  Weekly: "weekly",
} as const;

export type BackupScheduleValue = (typeof BackupSchedule)[keyof typeof BackupSchedule];

/**
 * Why a snapshot exists: taken by hand (`manual`, never expires), or by an
 * instance's backup schedule (`scheduled`, expires at `expires_at`).
 */
export const SnapshotOrigin = {
  Manual: "manual",
  Scheduled: "scheduled",
} as const;

export type SnapshotOriginValue = (typeof SnapshotOrigin)[keyof typeof SnapshotOrigin];

/**
 * A compute instance.
 *
 * A field the platform cannot report is left out instead of set to zero. An
 * empty `addresses` means the addresses are unknown; it does not mean the
 * instance has none.
 */
export interface Instance {
  id: string;
  name: string;
  description?: string;
  /** running | stopped | paused | pending */
  status: string;
  tenant_id: string;
  project_id?: string;
  user_id?: string;
  flavor?: Ref;
  sizing: Sizing;
  image?: Ref;
  key_name?: string;
  addresses?: string[];
  security_groups?: Ref[];
  /** The instance group the instance belongs to, null when it belongs to none. */
  instance_group_id: string | null;
  created?: string;
  /** Scheduled backup policy. Always present: `none` when no schedule is set. */
  backup_schedule: BackupScheduleValue;
  /** UTC hour (0 to 23) the scheduled backup starts. Present when the instance has backup settings. */
  backup_hour?: number;
  /** 0 (Sunday) to 6 (Saturday). Meaningful for `weekly` only. */
  backup_weekday?: number;
  /** Days a scheduled backup is kept (1 to 35). Present when a schedule is set. */
  backup_retention_days?: number;
  /**
   * SHA-256 of the `user_data` the instance was created with, lowercase hex.
   * Absent when none was set. The content is never returned.
   */
  user_data_sha256?: string;
}

/**
 * A crash-consistent copy of an instance's system disk.
 *
 * `object_store` snapshots are compressed archives on the platform's object
 * store: billed on `size_bytes`, and restorable. `hypervisor` snapshots are
 * older ones: they can be listed and deleted, are not billed, and cannot be
 * restored. Attached block volumes are never part of a snapshot.
 */
export interface Snapshot {
  id: string;
  name: string;
  instance_id: string;
  status: "creating" | "active" | "restoring" | string;
  storage: "object_store" | "hypervisor" | string;
  /** Bytes the object store actually holds (the compressed archive). Set once an object-store snapshot is active. */
  size_bytes?: number;
  /** Capacity of the system disk that was captured. */
  source_disk_gb?: number;
  /** Price excluding VAT of keeping `size_bytes` stored for a 730-hour month. Present with `size_bytes`. */
  monthly_cost?: number;
  currency?: string;
  restorable: boolean;
  created_at?: string;
  /** `manual` for a snapshot taken by hand, `scheduled` for a scheduled backup. */
  origin?: SnapshotOriginValue;
  /** RFC 3339 time a scheduled backup is deleted. Set for `scheduled` snapshots only. */
  expires_at?: string;
}

export interface Image {
  id: string;
  name: string;
  os_name: string;
  status: string;
  disk_format: string;
}

/** An organization-defined flavor. Behind the compute-flavors feature. */
export interface Flavor {
  id: string;
  tenant_id: string;
  name: string;
  vcpus: number;
  ram_mb: number;
  disk_gb: number;
  service_level: string;
  created_by: string;
}

export interface Keypair {
  id: string;
  name: string;
  public_key?: string;
  fingerprint?: string;
  type?: string;
}

export interface Network {
  id: string;
  name: string;
  description?: string;
  status: string;
  tenant_id?: string;
  project_id?: string;
  external?: boolean;
}

export interface AllocationPool {
  start: string;
  end: string;
}

/** 4 or 6. A region that predates IPv6 omits the field, which means 4. */
export type IPVersion = 4 | 6;

/**
 * An IPv6 subnet is a /64 the platform assigns from the region's routed
 * prefix: its CIDR and gateway come back here, and it has no allocation pools.
 */
export interface Subnet {
  id: string;
  name: string;
  network_id: string;
  cidr: string;
  ip_version?: IPVersion;
  gateway_ip: string;
  address_assignment: string;
  dns_servers: string[];
  allocation_pools: AllocationPool[];
}

export interface InterfaceAddress {
  subnet_id: string;
  address: string;
}

export interface NetworkInterface {
  id: string;
  slot: string;
  network_id: string;
  instance_id: string;
  instance_name: string;
  mac_address?: string;
  status: string;
  addresses: InterfaceAddress[];
}

/**
 * An IPv6 floating IP is translated to the target's private IPv4 address on
 * the region's exit node: the guest keeps an IPv4-only configuration and sees
 * IPv6 clients as addresses of the translation range. A target holds at most
 * one.
 */
export interface FloatingIP {
  id: string;
  address: string;
  ip_version?: IPVersion;
  description?: string;
  external_network_id?: string;
  private_address?: string;
  /** instance | load_balancer */
  target_type?: string;
  target_id?: string;
  status: string;
}

/**
 * Optional network features the region offers. Both are off where the
 * operator has not configured an IPv6 prefix.
 */
export interface NetworkCapabilities {
  ipv6_floating_ips: boolean;
  ipv6_subnets: boolean;
}

export interface SecurityGroupRule {
  id: string;
  security_group_id: string;
  direction: string;
  action: string;
  protocol?: string;
  port_range_min?: number;
  port_range_max?: number;
  remote_ip_prefix?: string;
}

export interface SecurityGroup {
  id: string;
  name: string;
  description?: string;
  tenant_id?: string;
  project_id?: string;
  /**
   * Read-only. `true` for a group whose egress rules are enforced: every group
   * created now, and older groups once converted with
   * `network.enableSecurityGroupEgressFiltering`. `false` for a group created
   * before egress filtering existed: it lets all outbound traffic through and
   * its egress rules have no effect.
   */
  egress_filtering: boolean;
  rules: SecurityGroupRule[];
}

export interface VolumeAttachment {
  id: string;
  server_id: string;
  server_name?: string;
  device: string;
  attached_at: string;
}

/** A block volume. `size` is in GiB. */
export interface Volume {
  id: string;
  name: string;
  description?: string;
  size: number;
  status: string;
  tenant_id?: string;
  project_id?: string;
  attachments: VolumeAttachment[];
  created_at?: string;
  updated_at?: string;
}

export interface Container {
  id: string;
  name: string;
  bytes: number;
  count: number;
  /**
   * The bucket name an S3 tool addresses with one of this container's keys.
   * It differs from `name`: the object store knows each container under an
   * opaque name of its own.
   */
  s3_bucket?: string;
  /**
   * The protection requested at creation, absent for an ordinary container.
   * For what the store actually enforces, see `storage.containerProtection()`.
   */
  protection?: ContainerProtection;
}

/** A container's versioning and object-lock state. */
export interface ContainerProtection {
  /** `Enabled`, `Suspended`, or empty. */
  versioning: string;
  object_lock: boolean;
  retention_mode?: string;
  retention_days?: number;
}

export interface StoredObject {
  name: string;
  /** Size in bytes. */
  size: number;
  content_type: string;
  last_modified: string;
}

export interface Listener {
  id: string;
  name: string;
  description?: string;
  loadbalancer_id?: string;
  protocol: string;
  protocol_port: number;
  default_pool_id?: string;
  connection_limit: number;
  /** ID of the {@link Certificate} a TERMINATED_HTTPS listener serves. */
  tls_certificate_ref?: string;
  admin_state_up: boolean;
  provisioning_status: string;
  operating_status: string;
}

/**
 * A TLS certificate imported into the project, for TERMINATED_HTTPS
 * listeners. It carries what the certificate says about itself and never the
 * private key, which cannot be read back.
 */
export interface Certificate {
  id: string;
  name: string;
  /** In the form `openssl x509 -fingerprint -sha256` prints. */
  fingerprint_sha256: string;
  subject: string;
  domains: string[];
  issuer: string;
  not_before: string;
  not_after: string;
  /** RSA-2048 to RSA-4096, ECDSA-P256 or ECDSA-P384. */
  key_algorithm: string;
  /** Intermediate certificates served with the leaf. */
  chain_length: number;
  used_by: CertificateUse[];
  created_at: string;
}

/** A listener that serves a certificate. */
export interface CertificateUse {
  listener_id: string;
  listener_name: string;
  load_balancer_id?: string;
}

export interface SessionPersistence {
  type: string;
  cookie_name?: string;
}

export interface PoolMember {
  id: string;
  name: string;
  pool_id?: string;
  address: string;
  subnet_id?: string;
  protocol_port: number;
  weight: number;
  admin_state_up: boolean;
  provisioning_status: string;
  operating_status: string;
}

/**
 * A pool's health probe.
 *
 * UDP pools report UDP_CONNECT: failures on them are detected passively, and
 * no active probe is sent.
 */
export interface HealthMonitor {
  id: string;
  pool_id: string;
  type: string;
  delay: number;
  timeout: number;
  max_retries: number;
  http_method?: string;
  url_path?: string;
  expected_codes?: string;
  admin_state_up: boolean;
  provisioning_status: string;
}

export interface Pool {
  id: string;
  name: string;
  description?: string;
  loadbalancer_id?: string;
  listener_id?: string;
  protocol: string;
  lb_algorithm: string;
  session_persistence?: SessionPersistence;
  admin_state_up: boolean;
  provisioning_status: string;
  operating_status: string;
  members: PoolMember[];
  health_monitors: HealthMonitor[];
}

export interface LoadBalancer {
  id: string;
  name: string;
  description?: string;
  vip_address?: string;
  vip_subnet_id?: string;
  /**
   * The engine, read-only. New balancers are always "auto", which serves every
   * listener protocol; older ones may report "haproxy" (no UDP listeners) or
   * "nginx" (UDP listeners only).
   */
  provider: string;
  provisioning_status: string;
  operating_status?: string;
  tenant_id?: string;
  project_id?: string;
  admin_state_up: boolean;
  listeners: Listener[];
  pools: Pool[];
  created_at?: string;
  /** The tier: lb-small, lb-ha, lb-medium or lb-large. Fixed at creation. */
  flavor?: string;
  /**
   * Live state of the active/standby pair of a high-availability tier. Absent
   * on a single-appliance tier.
   */
  high_availability?: LoadBalancerHA;
}

/**
 * Observed state of a high-availability load balancer's two appliances.
 *
 * `status` is REDUNDANT (one active, one standby, on two hosts), DEGRADED or
 * UNKNOWN. `reason` says why a pair is DEGRADED: SPLIT_BRAIN,
 * NO_ACTIVE_APPLIANCE, APPLIANCE_UNAVAILABLE or SINGLE_HOST.
 */
export interface LoadBalancerHA {
  status: string;
  reason?: string;
  appliances: LoadBalancerAppliance[];
}

/**
 * One appliance of a high-availability pair. `state` is ACTIVE (holds the VIP),
 * STANDBY, DOWN or UNKNOWN. `address` is the appliance's own address: health
 * checks and proxied connections leave from it, so members' security groups
 * must admit both appliances.
 */
export interface LoadBalancerAppliance {
  index: number;
  state: string;
  address?: string;
}

/**
 * One load-balancer tier. `vcpus` and `ram_mb` size each appliance; a
 * high-availability tier runs `appliances` of them, billed as one load balancer.
 */
export interface LoadBalancerFlavor {
  name: string;
  appliances: number;
  vcpus: number;
  ram_mb: number;
  high_availability: boolean;
  hourly_price: number;
  monthly_price: number;
  currency: string;
}

/**
 * An authoritative DNS zone. `id` is the platform's identifier (a UUID) and is
 * what every zone method takes; `name` is the canonical zone name
 * ("example.com."), which is not an identifier.
 *
 * A new zone is not served until its owner proves control of the domain:
 * `status` is `PENDING_VERIFICATION` and `verification` names the TXT record to
 * publish at the current DNS host. Once `dns.verifyZone` has found it, `status`
 * becomes `ACTIVE` and `verification` disappears.
 */
export interface DNSZone {
  id: string;
  name: string;
  email?: string;
  description?: string;
  ttl?: number;
  status: string;
  /** Present only while the zone is pending verification. */
  verification?: DNSZoneVerification;
  tenant_id?: string;
  project_id?: string;
  created_at?: string;
}

/**
 * The record that proves control of a pending zone's domain. `name` is fully
 * qualified ("_nemau-challenge.example.com."), `type` is "TXT" and `value` is
 * the exact text the record must hold.
 */
export interface DNSZoneVerification {
  name: string;
  type: string;
  value: string;
}

/**
 * A DNS record set.
 *
 * Its id is "canonical.name./TYPE". Because it contains a slash, it travels as
 * a query parameter and never as a path segment.
 */
export interface DNSRecordSet {
  id: string;
  name: string;
  type: string;
  ttl?: number;
  records?: string[];
  description?: string;
  protected?: boolean;
  status: string;
  zone_id?: string;
}

export interface NodePoolSpec {
  name: string;
  class: string;
  flavor_id?: string;
  vcpus: number;
  ram_mb: number;
  disk_gb: number;
  replicas: number;
  autoscalerMin?: number;
  autoscalerMax?: number;
  /** `key=value` pairs, as set at creation or on a pool added later. */
  labels?: string[];
  /** `key[=value]:Effect` entries, as set at creation or on a pool added later. */
  taints?: string[];
}

export interface KubernetesTopology {
  version: string;
  class: string;
  controlPlaneFlavorId?: string;
  controlPlaneSizing?: Sizing;
  controlPlaneReplicas: number;
  nodePools: NodePoolSpec[];
}

export interface KubernetesAPIEndpoint {
  host: string;
  port: number;
}

export interface KubernetesClusterCondition {
  type: string;
  status: string;
  reason?: string;
  lastTransitionTime?: string;
}

export interface KubernetesClusterStatus {
  phase: string;
  infrastructureReady: boolean;
  controlPlaneReady: boolean;
  controlPlaneEndpoint?: KubernetesAPIEndpoint;
  conditions: KubernetesClusterCondition[];
}

/** The spec of a cluster: its topology, and the network it lives in. */
export interface KubernetesClusterSpec {
  topology: KubernetesTopology;
  /** Public UUID of the project network the cluster lives in. */
  network_id: string;
  /** Public UUID of the subnet the nodes are attached to. */
  subnet_id: string;
  /** IPv4 CIDR of the pod network, as set at creation. */
  pod_cidr?: string;
  /** IPv4 CIDR of the service network, as set at creation. */
  service_cidr?: string;
}

export interface KubernetesCluster {
  id: string;
  name: string;
  createdAt?: string;
  spec: KubernetesClusterSpec;
  status: KubernetesClusterStatus;
}

/**
 * One row of the cluster listing.
 *
 * The platform's own record of the cluster, which differs from the live
 * cluster object: `status` is the lowercase lifecycle status, and the
 * capitalised phase is in `specs.phase`. The specs are refreshed
 * periodically, so a cluster created a moment ago may not have all of them yet.
 */
export interface KubernetesClusterSummary {
  id: string;
  name: string;
  status: KubernetesClusterStatusName | (string & {});
  resourceType?: string;
  projectId?: string;
  specs: KubernetesClusterSummarySpecs;
  createdAt?: string;
  updatedAt?: string;
}

export type KubernetesClusterStatusName = "active" | "building" | "upgrading" | "deleting" | "error";

/** Figures the listing carries about a cluster. All optional; unknown keys pass through. */
export interface KubernetesClusterSummarySpecs {
  phase?: string;
  infrastructure_ready?: boolean;
  control_plane_ready?: boolean;
  kubernetes_version?: string;
  cluster_class?: string;
  node_pools_count?: number;
  control_plane_replicas?: number;
  control_plane_vcpus?: number;
  control_plane_ram_mb?: number;
  control_plane_disk_gb?: number;
  worker_replicas?: number;
  worker_vcpus?: number;
  worker_ram_mb?: number;
  worker_disk_gb?: number;
  [key: string]: unknown;
}

/** The answer to a preflight request. */
export interface KubernetesPreflight {
  preflight_id: string;
  report: KubernetesPreflightReport;
}

/** Whether a cluster may be upgraded now. */
export interface KubernetesPreflightReport {
  clusterName: string;
  currentVersion: string;
  targetVersion?: string;
  ready: boolean;
  checks: Array<{ name: string; passed: boolean; details?: string }>;
  blockingIssues?: string[];
}

/** A period during which a cluster may be upgraded. */
export interface MaintenanceWindow {
  id: string;
  clusterName: string;
  name: string;
  startsAt: string;
  endsAt: string;
  reason?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface ClusterClass {
  name: string;
  namespace: string;
}

export interface Region {
  slug: string;
  displayName: string;
  country: string;
  enabled: boolean;
}

export interface RegionStatus {
  slug: string;
  healthy: boolean;
  checkedAt: string;
  error?: string;
}

/** A quota dimension name. Every write is checked against these before it is admitted. */
export type QuotaName =
  | "instances"
  | "cores"
  | "ram"
  | "volumes"
  | "volumeSize"
  | "snapshots"
  | "networks"
  | "subnets"
  | "floatingIps"
  | "securityGroups"
  | "loadBalancers"
  | "objectStorage";

/** A write needs room in both scopes. */
export type QuotaScopeName = "tenant" | "project";

export interface QuotaDimension {
  name: QuotaName | string;
  /**
   * `"count"`, `"MB"`, `"GB"` or `"bytes"`. RAM is counted in MB and volume
   * size in GB.
   */
  unit: string;
  used: number;
  /**
   * Capacity claimed by tasks admitted but not yet settled. The API compares
   * used + reserved + requested to the limit, so headroom is
   * limit - used - reserved.
   */
  reserved: number;
  limit: number;
}

export interface QuotaScope {
  scope: QuotaScopeName | string;
  project_id?: string;
  dimensions: QuotaDimension[];
}

export interface QuotaList {
  quotas: QuotaScope[];
}

/** A project a credential can act on. */
export interface Project {
  id: string;
  name: string;
  slug: string;
  region: string;
  is_active: boolean;
  provisioning_status: string;
  /** True for the project the listing request was itself scoped to. */
  current: boolean;
}

export interface ProjectList {
  projects: Project[];
  count: number;
  /**
   * The scope the request resolved to. It can name a project that is absent
   * from `projects`, for example when the credential points at a deleted
   * project.
   */
  current_project_id: string;
}

/** A page of a list that paginates by page number (`/iam/users`). */
export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
  has_more: boolean;
}

/** A member of the organization. */
export interface IamUser {
  id: string;
  email?: string;
  username?: string;
  name?: string;
  surname?: string;
  /** `owner` or `member`. */
  type: string;
  status: string;
  organizationId: string;
  passwordEnabled: boolean;
  totpEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An IAM access key as listed: the secret is never part of it. */
export interface AccessKeyInfo {
  id: string;
  /** The public half, sent as `X-Access-Key-Id`. */
  accessKeyId: string;
  description?: string;
  userId: string;
  organizationId: string;
  /** `active` or `inactive`. */
  status: string;
  /** Always set: every key expires. */
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** The answer to creating or rotating an access key. */
export interface CreatedAccessKey {
  accessKey: AccessKeyInfo;
  /** Returned here only; the platform keeps a hash. */
  secretAccessKey: string;
}

export interface AccessKeyLimits {
  /** The cap on active keys per user. */
  maxAccessKeys: number;
  /** Active keys the user holds now. */
  current: number;
}

/** One UTC hour a week, when a database takes its maintenance. */
export interface DatabaseMaintenanceWindow {
  /** 0 (Sunday) to 6 (Saturday). */
  weekday: number;
  /** 0 to 23, UTC. */
  hour: number;
}

/** A managed database size the region offers. */
export interface DatabaseFlavor {
  /** The name to pass as `flavor`, such as "db-small". */
  name: string;
  vcpus: number;
  memory_mb: number;
}

/**
 * The lifecycle of a database. `building` is being provisioned, `active` is
 * serving, `error` failed and needs an operator, `deleted` is retired and its
 * backups may still sit inside their restore window.
 */
export type DatabaseStatus = "building" | "active" | "error" | "deleted";

/** A resize the database holds until it applies. */
export interface DatabasePendingResize {
  flavor: string;
  storage_gb: number;
  /** RFC 3339. The instant the deferred resize applies, at the next maintenance window. */
  apply_at: string;
}

/**
 * A managed PostgreSQL database. The API names no internal identifier, no
 * management address and no hypervisor reference: `address` and `port` are the
 * only way in, over TLS.
 */
export interface Database {
  id: string;
  name: string;
  description?: string;
  status: DatabaseStatus;
  version: string;
  flavor: string;
  storage_gb: number;
  subnet_id: string;
  security_group_ids: string[];
  admin_username: string;
  address?: string;
  port: number;
  backup_retention_days: number;
  maintenance_window?: DatabaseMaintenanceWindow;
  /** RFC 3339. The oldest instant a point-in-time restore can reach. */
  earliest_restorable_time?: string;
  /** RFC 3339. The last archived WAL; absent until the agent has reported it. */
  latest_restorable_time?: string;
  /** RFC 3339. Closes the restore window of a deleted database; absent for a live one. */
  restorable_until?: string;
  /** The deferred resize, or null when none is held. */
  pending_resize: DatabasePendingResize | null;
  created_at: string;
  updated_at: string;
}

/**
 * The 202 of a write that issues a password. `password` is returned once, by
 * the request that made it: it is never readable again.
 */
export interface DatabaseCredentials {
  task_id: string;
  /** Set on a rotation; absent on a create or a restore, whose task names it. */
  database_id?: string;
  username: string;
  password: string;
}

/** The launch template of a group, as read back. `user_data` is a flag, never the document. */
export interface InstanceGroupLaunchTemplate {
  /** The template version the group runs now. */
  version: number;
  flavor_id?: string;
  image_id: string;
  vcpus: number;
  ram_mb: number;
  disk_gb: number;
  network_id: string;
  subnet_id: string;
  security_group_ids: string[];
  key_name: string;
  user_data_present: boolean;
  /** SHA-256 of the cloud-init document, or null when the template has none. */
  user_data_sha256: string | null;
}

/** A load balancer pool a group registers its members in. */
export interface InstanceGroupPoolTarget {
  pool_id: string;
  protocol_port: number;
}

/** A target-tracking scaling policy, with the server's defaults filled in. */
export interface InstanceGroupScalingPolicy {
  metric: string;
  target: number;
  window_seconds: number;
  scale_out_cooldown_seconds: number;
  scale_in_cooldown_seconds: number;
  scale_in_window_seconds: number;
  max_step_out: number;
  max_step_in: number;
  scale_in_enabled: boolean;
}

/** A scheduled action: a UTC cron and the bounds it sets when it fires. */
export interface InstanceGroupSchedule {
  id: string;
  cron: string;
  min_size?: number;
  max_size?: number;
  desired_capacity?: number;
  /** RFC 3339. The last slot the schedule fired for; absent before its first firing. */
  last_slot?: string;
}

/**
 * The state of a rolling refresh. `idle` is a group that never refreshed;
 * `in_progress` replaces members; `blocked` waits for room in the group or for a
 * member allowed out, and resumes by itself; `hold` is paused by a billing hold;
 * `completed`, `cancelled` and `failed` are final.
 */
export type InstanceGroupRefreshStatus =
  | "idle"
  | "in_progress"
  | "blocked"
  | "hold"
  | "completed"
  | "cancelled"
  | "failed";

/** The rolling refresh of a group: its replacement of members onto the current template. */
export interface InstanceGroupRefresh {
  status: InstanceGroupRefreshStatus;
  /** The template version the refresh rolls to. 0 before any refresh. */
  target_version: number;
  /** RFC 3339. Null before the refresh starts. */
  started_at: string | null;
  /** RFC 3339. Null while the refresh is not finished. */
  completed_at: string | null;
  /** Protected members the refresh leaves on an older template version. */
  skipped_protected: number;
}

/** An instance group as the list returns it: no members, no activities. */
export interface InstanceGroup {
  id: string;
  name: string;
  description: string;
  status: string;
  health_check: string;
  health_check_grace_seconds: number;
  drain_seconds: number;
  min_size: number;
  max_size: number;
  desired_capacity: number;
  instance_count: number;
  max_surge: number;
  max_unavailable_pct: number;
  template_version: number;
  launch_template: InstanceGroupLaunchTemplate;
  pools: InstanceGroupPoolTarget[];
  scaling_policies: InstanceGroupScalingPolicy[];
  schedules: InstanceGroupSchedule[];
  refresh: InstanceGroupRefresh;
  /** RFC 3339. */
  created_at: string;
  /** RFC 3339. */
  updated_at: string;
}

export interface InstanceGroupMember {
  instance_id: string;
  status: string;
  protected_from_scale_in: boolean;
  template_version: number;
  /** RFC 3339. */
  joined_at: string;
}

/** One decision of the group's controller: a scale step, a refusal, a skipped slot. */
export interface InstanceGroupActivity {
  id: number;
  type: string;
  /** Empty when the decision carries no reason. */
  reason: string;
  /** Null when the decision concerns no single member. */
  instance_id: string | null;
  /** RFC 3339. */
  created_at: string;
}

/** An instance group with its members and its recent activities, as GET returns it. */
export interface InstanceGroupDetail extends InstanceGroup {
  members: InstanceGroupMember[];
  activities: InstanceGroupActivity[];
}
