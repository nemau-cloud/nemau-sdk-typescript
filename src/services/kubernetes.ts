import { Service } from "./base.ts";
import type {
  ClusterClass,
  KubernetesCluster,
  KubernetesClusterSummary,
  KubernetesPreflight,
  MaintenanceWindow,
  TaskRef,
} from "../types.ts";

const KUBERNETES_VERSION = /^v?\d+\.\d+\.\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Client-side comfort checks mirroring the server rules. The server stays the
// authority and refuses the same inputs with a 400.
const POOL_KEY = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const POOL_VALUE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
const TAINT_EFFECTS = new Set(["NoSchedule", "PreferNoSchedule", "NoExecute"]);
const POOL_CLASSES = new Set(["default-worker"]);
const MAX_POOL_LABELS = 16;
const MAX_POOL_TAINTS = 16;

/**
 * Opens a maintenance window on a cluster. `name` must match
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; the window must end after it starts and
 * last at most 30 days.
 */
export interface MaintenanceWindowRequest {
  name: string;
  starts_at: Date | string;
  ends_at: Date | string;
  reason?: string;
}

const rfc3339 = (value: Date | string) =>
  typeof value === "string" ? value : value.toISOString().replace(/\.\d{3}Z$/, "Z");

function requireUUID(field: string, value: unknown): void {
  if (typeof value !== "string" || value === "") {
    throw new Error(`nemau: ${field} is required and must be the public UUID of the resource`);
  }
  if (!UUID.test(value)) {
    throw new Error(`nemau: ${field} must be a UUID`);
  }
}

/** Refuses a node pool entry the server would reject: its class, labels and taints. */
function validateNodePool(pool: NodePoolInit): void {
  const name = String(pool.name);
  if (pool.class !== undefined && pool.class !== "" && !POOL_CLASSES.has(pool.class)) {
    throw new Error(`nemau: node pool "${name}" class must be default-worker`);
  }
  validateScheduling(name, pool.labels, pool.taints);
}

/** Refuses the labels and taints of a pool the server would reject. Shared by a creation and an added pool. */
function validateScheduling(name: string, labelList: string[] | undefined, taintList: string[] | undefined): void {
  const labels = labelList ?? [];
  if (labels.length > MAX_POOL_LABELS) {
    throw new Error(`nemau: node pool "${name}" may carry at most ${MAX_POOL_LABELS} labels`);
  }
  for (const label of labels) {
    const eq = label.indexOf("=");
    if (eq < 0) {
      throw new Error(`nemau: node pool "${name}" label "${label}" must be key=value`);
    }
    const key = label.slice(0, eq);
    if (!POOL_KEY.test(key)) {
      throw new Error(`nemau: node pool "${name}" label key "${key}" must be a DNS label (lowercase letters, digits, hyphens)`);
    }
    if (!POOL_VALUE.test(label.slice(eq + 1))) {
      throw new Error(`nemau: node pool "${name}" label "${key}" has an invalid value (1 to 63 characters: alphanumerics, "-", "_" or "." inside)`);
    }
  }

  const taints = taintList ?? [];
  if (taints.length > MAX_POOL_TAINTS) {
    throw new Error(`nemau: node pool "${name}" may carry at most ${MAX_POOL_TAINTS} taints`);
  }
  for (const taint of taints) {
    const colon = taint.indexOf(":");
    if (colon < 0 || !TAINT_EFFECTS.has(taint.slice(colon + 1))) {
      throw new Error(`nemau: node pool "${name}" taint "${taint}" must end in :NoSchedule, :PreferNoSchedule or :NoExecute`);
    }
    const head = taint.slice(0, colon);
    const eq = head.indexOf("=");
    const key = eq < 0 ? head : head.slice(0, eq);
    if (!POOL_KEY.test(key)) {
      throw new Error(`nemau: node pool "${name}" taint key "${key}" must be a DNS label (lowercase letters, digits, hyphens)`);
    }
    if (eq >= 0 && !POOL_VALUE.test(head.slice(eq + 1))) {
      throw new Error(`nemau: node pool "${name}" taint "${key}" has an invalid value (1 to 63 characters: alphanumerics, "-", "_" or "." inside)`);
    }
  }
}

/**
 * Description of a new cluster.
 *
 * **Breaking:** `network_id` and `subnet_id` are now required. They are public
 * UUIDs: the project network the cluster lives in, and the subnet its nodes
 * are attached to. A missing or malformed one is refused before any request.
 *
 * `pod_cidr` and `service_cidr` are optional IPv4 CIDRs, sent only when set.
 * The server validates them.
 *
 * The control-plane size is either `control_plane_flavor_id` or the three
 * vcpus/ram_mb/disk_gb values; a partial size is rejected. Any flavor field
 * additionally requires the compute-flavors organization feature.
 *
 * `control_plane_replicas` (1 to 9; use an odd number, etcd needs a quorum) and
 * at least one entry in `node_pools` are required: the API refuses a cluster
 * without them. The console's defaults are 3 control-plane nodes and one pool
 * named "workers", class "default-worker", 3 nodes of 2 vCPU, 4096 MB, 20 GB.
 */
export interface CreateClusterRequest {
  name: string;
  kubernetes_version: string;
  /** Public UUID of the project network the cluster lives in. Required. */
  network_id: string;
  /** Public UUID of the subnet the cluster nodes are attached to. Required. */
  subnet_id: string;
  /** Optional IPv4 CIDR of the pod network. Validated by the server. */
  pod_cidr?: string;
  /** Optional IPv4 CIDR of the service network. Validated by the server. */
  service_cidr?: string;
  control_plane_vcpus?: number;
  control_plane_ram_mb?: number;
  control_plane_disk_gb?: number;
  control_plane_flavor_id?: string;
  worker_flavor_id?: string;
  cluster_class?: string;
  control_plane_replicas: number;
  node_pools: NodePoolInit[];
}

/**
 * A worker group declared at cluster creation.
 *
 * `name` is a DNS label (lowercase letters, digits and hyphens, 63 characters
 * at most), unique within the cluster; `replicas` is 0 to 100. The node size
 * is `flavor_id`, or all three of vcpus/ram_mb/disk_gb, or nothing when the
 * request sets `worker_flavor_id`. With an autoscaler, start `replicas` at
 * `autoscaler_min`.
 *
 * `labels` are `key=value` pairs and `taints` are `key[=value]:Effect`, where
 * Effect is `NoSchedule`, `PreferNoSchedule` or `NoExecute`. Keys are DNS
 * labels; values are 1 to 63 alphanumerics, `-`, `_` or `.`, alphanumeric at
 * both ends. At most 16 of each per pool. `class`, when set, must be
 * `default-worker`. The SDK checks these before sending; the server decides.
 */
export interface NodePoolInit {
  name: string;
  class?: string;
  flavor_id?: string;
  vcpus?: number;
  ram_mb?: number;
  disk_gb?: number;
  replicas: number;
  autoscaler_min?: number;
  autoscaler_max?: number;
  labels?: string[];
  taints?: string[];
}

/**
 * A worker group added to a live cluster. The size is either `flavor_id` (an
 * organization flavor, which then sets the node size) or all three of
 * vcpus/ram_mb/disk_gb. `class` is required by the API.
 */
export interface AddNodePoolRequest {
  pool_name: string;
  class: string;
  flavor_id?: string;
  vcpus?: number;
  ram_mb?: number;
  disk_gb?: number;
  replicas?: number;
  autoscaler_min?: number;
  autoscaler_max?: number;
  /** `key=value` pairs, with the rules of `NodePoolInit.labels`. At most 16. */
  labels?: string[];
  /** `key[=value]:Effect` entries, with the rules of `NodePoolInit.taints`. At most 16. */
  taints?: string[];
}

/**
 * /kubernetes: managed clusters.
 *
 * Clusters are addressed by name, not by id, within the caller's project.
 */
export class KubernetesService extends Service {
  async listVersions(): Promise<string[]> {
    const out = await this.client.request<{ versions: string[] }>({
      method: "GET",
      path: "/kubernetes/versions",
    });
    return out.versions ?? [];
  }

  async listClusterClasses(): Promise<ClusterClass[]> {
    const out = await this.client.request<{ cluster_classes: ClusterClass[] }>({
      method: "GET",
      path: "/kubernetes/cluster-classes",
    });
    return out.cluster_classes ?? [];
  }

  /**
   * The project's clusters, as summaries: the lowercase lifecycle status, and
   * the version, phase and readiness as of the last reconcile in `specs`. Use
   * `getCluster()` for the topology, the conditions and the API endpoint.
   */
  async listClusters(): Promise<KubernetesClusterSummary[]> {
    const out = await this.client.request<{ clusters: KubernetesClusterSummary[] }>({
      method: "GET",
      path: "/kubernetes/clusters",
    });
    return out.clusters ?? [];
  }

  async getCluster(name: string): Promise<KubernetesCluster> {
    return this.client.request<KubernetesCluster>({
      method: "GET",
      path: `/kubernetes/clusters/${encodeURIComponent(name)}`,
    });
  }

  /**
   * A cluster's kubeconfig, as YAML.
   *
   * Reading one is audited (GET_KUBECONFIG) and it carries cluster-admin
   * rights: treat the result as a secret.
   */
  async getKubeconfig(name: string): Promise<string> {
    const out = await this.client.request<{ cluster_name: string; kubeconfig: string }>({
      method: "GET",
      path: `/kubernetes/clusters/${encodeURIComponent(name)}/kubeconfig`,
    });
    return out.kubeconfig;
  }

  /**
   * Starts provisioning. Refuses before any request, with an `Error`, a missing
   * or malformed `network_id` or `subnet_id`, a node pool whose class, labels
   * or taints break the rules on `NodePoolInit`.
   */
  async createCluster(request: CreateClusterRequest): Promise<TaskRef> {
    requireUUID("network_id", request.network_id);
    requireUUID("subnet_id", request.subnet_id);
    for (const pool of request.node_pools ?? []) validateNodePool(pool);

    // Unset CIDRs are left out of the body, not sent as null or an empty string.
    const { pod_cidr, service_cidr, ...rest } = request;
    const body: Record<string, unknown> = { ...rest };
    if (pod_cidr) body["pod_cidr"] = pod_cidr;
    if (service_cidr) body["service_cidr"] = service_cidr;

    return this.client.submit({ method: "POST", path: "/kubernetes/clusters", json: body });
  }

  /** Provisioning takes several minutes. */
  async createClusterAndWait(request: CreateClusterRequest): Promise<KubernetesCluster> {
    const ref = await this.createCluster(request);
    await this.client.waitFor(ref);
    // Read back by name: every cluster endpoint takes the name, not an id.
    return this.getCluster(request.name);
  }

  async deleteCluster(name: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/kubernetes/clusters/${encodeURIComponent(name)}`,
    });
  }

  /** Use an odd number: etcd needs a quorum. */
  async scaleControlPlane(name: string, replicas: number): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/kubernetes/clusters/${encodeURIComponent(name)}/scale-control-plane`,
      json: { replicas },
    });
  }

  /**
   * Adds a worker group to a live cluster. `labels` and `taints` take the same
   * syntax as on `NodePoolInit`, checked before the request is sent.
   */
  async addNodePool(cluster: string, request: AddNodePoolRequest): Promise<TaskRef> {
    validateScheduling(String(request.pool_name), request.labels, request.taints);
    return this.client.submit({
      method: "POST",
      path: `/kubernetes/clusters/${encodeURIComponent(cluster)}/node-pools`,
      json: request,
    });
  }

  async removeNodePool(cluster: string, pool: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/kubernetes/clusters/${encodeURIComponent(cluster)}/node-pools/${encodeURIComponent(pool)}`,
    });
  }

  async scaleNodePool(cluster: string, pool: string, replicas: number): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/kubernetes/clusters/${encodeURIComponent(cluster)}/node-pools/${encodeURIComponent(pool)}/scale`,
      json: { replicas },
    });
  }

  /** Both bounds are required: either 0 < min <= max, or min = max = 0 to turn the autoscaler off. */
  async setAutoscaler(cluster: string, pool: string, min: number, max: number): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/kubernetes/clusters/${encodeURIComponent(cluster)}/node-pools/${encodeURIComponent(pool)}/autoscaler`,
      json: { min, max },
    });
  }

  /**
   * Starts an upgrade of the cluster to `version` (`1.36.0` or `v1.36.0`).
   *
   * The task does the whole job: preflight checks, a maintenance window, then
   * the upgrade. A blocking preflight fails the task (`NemauTaskFailedError`,
   * the message lists the blocking checks) instead of refusing the request, so
   * wait on the returned reference. To look before upgrading, call
   * `preflight()`.
   *
   * When the task completes, the rolling upgrade has started but is not
   * finished yet; follow it with `getCluster()`. The completed task's result carries
   * `from_version`, `to_version`, `preflight_id` and `maintenance_window_id`.
   *
   * A malformed version throws before a request is sent. Requires the
   * `kubernetes-guided-upgrades` organization feature (404 without it).
   */
  async upgradeCluster(name: string, version: string): Promise<TaskRef> {
    if (!KUBERNETES_VERSION.test(version)) {
      throw new Error(`nemau: version "${version}" must look like 1.31.0 or v1.31.0`);
    }
    return this.client.submit({
      method: "POST",
      path: `/kubernetes/clusters/${encodeURIComponent(name)}/upgrade`,
      json: { version },
    });
  }

  /**
   * Pre-upgrade health checks. Without a target version it checks the
   * cluster's health only. Requires the `kubernetes-health-preflight` feature.
   */
  async preflight(name: string, targetVersion?: string): Promise<KubernetesPreflight> {
    return this.client.request<KubernetesPreflight>({
      method: "POST",
      path: `/kubernetes/clusters/${encodeURIComponent(name)}/preflight`,
      json: targetVersion ? { target_version: targetVersion } : {},
    });
  }

  /** Opens a maintenance window on a cluster. */
  async createMaintenanceWindow(name: string, request: MaintenanceWindowRequest): Promise<MaintenanceWindow> {
    return this.client.request<MaintenanceWindow>({
      method: "POST",
      path: `/kubernetes/clusters/${encodeURIComponent(name)}/maintenance`,
      json: {
        name: request.name,
        starts_at: rfc3339(request.starts_at),
        ends_at: rfc3339(request.ends_at),
        reason: request.reason ?? "",
      },
    });
  }

  /** Requires the `kubernetes-kubeconfig-rotation` feature. */
  async rotateKubeconfig(name: string): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({
      method: "POST",
      path: `/kubernetes/clusters/${encodeURIComponent(name)}/kubeconfig/rotate`,
    });
  }
}
