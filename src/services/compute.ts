import { Service } from "./base.ts";
import type { BackupScheduleValue, Flavor, Image, Instance, Keypair, Sizing, Snapshot, Task, TaskRef } from "../types.ts";
import { BackupSchedule } from "../types.ts";
import { patch } from "./update.ts";

/** The periods the metrics endpoint accepts. */
export const METRIC_PERIODS = ["1h", "6h", "24h", "7d"] as const;
export type MetricPeriod = (typeof METRIC_PERIODS)[number];

/**
 * Description of a new instance.
 *
 * The size is either `flavor_id` or the three vcpus/ram_mb/disk_gb values:
 * the API rejects a partial custom size. `flavor_id` additionally requires the
 * compute-flavors organization feature.
 */
export interface CreateInstanceRequest {
  name: string;
  description?: string;
  vcpus?: number;
  ram_mb?: number;
  disk_gb?: number;
  flavor_id?: string;
  service_level?: string;
  image_id: string;
  network_id?: string;
  security_groups?: string[];
  key_name?: string;
  /**
   * cloud-init document (`#cloud-config`, a `#!` script or multipart MIME), run
   * on the first boot. UTF-8, at most {@link USER_DATA_MAX_BYTES} bytes, no NUL.
   * The API never returns it: the instance reports only `user_data_sha256`.
   */
  user_data?: string;
}

/** Largest `user_data` the API accepts, in UTF-8 bytes. */
export const USER_DATA_MAX_BYTES = 16 * 1024;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Client-side comfort check, run before any request. The API is the authority;
 * the error never includes the document itself.
 */
function checkUserData(userData: unknown): void {
  if (typeof userData !== "string") throw new Error("nemau: user_data must be a string");
  if (userData.includes("\0")) throw new Error("nemau: user_data must not contain NUL");
  if (LONE_SURROGATE.test(userData)) {
    throw new Error("nemau: user_data must be well-formed Unicode (no lone surrogates)");
  }
  const bytes = new TextEncoder().encode(userData).byteLength;
  if (bytes > USER_DATA_MAX_BYTES) {
    throw new Error(`nemau: user_data is ${bytes} bytes; the limit is ${USER_DATA_MAX_BYTES}`);
  }
}

/**
 * The fields {@link ComputeService.updateInstance} changes. Every field is
 * optional; an absent field is left unchanged.
 *
 * The backup fields are checked against the API's ranges before a request is
 * sent. The API checks the merged state: a `daily` or `weekly` schedule needs
 * `backup_retention_days`, which may come from an earlier update.
 */
export interface InstanceUpdate {
  name?: string;
  /** Pass `""` to clear it. */
  description?: string;
  /** `none` turns scheduled backups off. */
  backup_schedule?: BackupScheduleValue;
  /** UTC hour, 0 to 23. */
  backup_hour?: number;
  /** 0 (Sunday) to 6 (Saturday). Only read for `weekly`. */
  backup_weekday?: number;
  /** Days each scheduled backup is kept, 1 to 35. */
  backup_retention_days?: number;
}

export interface FlavorRequest {
  name: string;
  vcpus: number;
  ram_mb: number;
  disk_gb: number;
  service_level?: string;
}

/**
 * The answer to a keypair creation.
 *
 * `privateKey` is set only when the platform generated the key. The platform
 * does not store it, and it cannot be fetched again.
 */
export interface CreatedKeypair {
  name: string;
  publicKey: string;
  privateKey: string;
  task: Task;
}

/** /compute: instances, lifecycle, snapshots and restore, images, flavors, keypairs. */
export class ComputeService extends Service {
  async listInstances(): Promise<Instance[]> {
    const out = await this.client.request<{ instances: Instance[] }>({
      method: "GET",
      path: "/compute/instances",
    });
    return out.instances ?? [];
  }

  async getInstance(id: string): Promise<Instance> {
    const out = await this.client.request<{ instance: Instance }>({
      method: "GET",
      path: `/compute/instances/${encodeURIComponent(id)}`,
    });
    return out.instance;
  }

  async createInstance(request: CreateInstanceRequest): Promise<TaskRef> {
    if (request.user_data !== undefined) checkUserData(request.user_data);
    return this.client.submit({ method: "POST", path: "/compute/instances", json: request });
  }

  /** Creates an instance and waits for it to be built. */
  async createInstanceAndWait(request: CreateInstanceRequest): Promise<Instance> {
    const ref = await this.createInstance(request);
    const { id } = await this.client.waitForResourceId(ref, "instance_id");
    return this.getInstance(id);
  }

  async deleteInstance(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: `/compute/instances/${encodeURIComponent(id)}` });
  }

  async start(id: string): Promise<TaskRef> {
    return this.#action(id, "start");
  }

  async stop(id: string): Promise<TaskRef> {
    return this.#action(id, "stop");
  }

  /** `type` is `SOFT` (default) or `HARD`. */
  async reboot(id: string, type?: "SOFT" | "HARD"): Promise<TaskRef> {
    return this.#action(id, "reboot", type ? { type } : {});
  }

  async pause(id: string): Promise<TaskRef> {
    return this.#action(id, "pause");
  }

  async unpause(id: string): Promise<TaskRef> {
    return this.#action(id, "unpause");
  }

  async suspend(id: string): Promise<TaskRef> {
    return this.#action(id, "suspend");
  }

  async resume(id: string): Promise<TaskRef> {
    return this.#action(id, "resume");
  }

  /**
   * All three values are required and bounded by the API: 1-64 vCPUs,
   * 1024-262144 MB, 10-5000 GB.
   */
  async resize(id: string, sizing: Sizing): Promise<TaskRef> {
    return this.#action(id, "resize", sizing);
  }

  /**
   * Replaces the instance's security groups with `groupIds`.
   *
   * An empty list is accepted: it removes every group, so the instance's
   * traffic is no longer filtered.
   */
  async setSecurityGroups(id: string, groupIds: string[]): Promise<TaskRef> {
    return this.#action(id, "security-groups", { security_groups: groupIds ?? [] });
  }

  /** Every lifecycle action is a PUT. */
  async #action(id: string, action: string, json?: unknown): Promise<TaskRef> {
    return this.client.submit({
      method: "PUT",
      path: `/compute/instances/${encodeURIComponent(id)}/${action}`,
      ...(json !== undefined ? { json } : {}),
    });
  }

  async listSnapshots(instanceId?: string): Promise<Snapshot[]> {
    const out = await this.client.request<{ snapshots: Snapshot[] }>({
      method: "GET",
      path: "/compute/snapshots",
      ...(instanceId ? { query: { instance_id: instanceId } } : {}),
    });
    return out.snapshots ?? [];
  }

  /**
   * Starts a snapshot of the instance's system disk. The task stays running
   * until the upload to the object store ends (minutes, or hours for a large
   * disk), and the snapshot is listed as `creating` meanwhile.
   */
  async createSnapshot(instanceId: string, name: string): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/compute/instances/${encodeURIComponent(instanceId)}/snapshot`,
      json: { name },
    });
  }

  /** A snapshot being created or restored cannot be deleted (409). */
  async deleteSnapshot(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: `/compute/snapshots/${encodeURIComponent(id)}` });
  }

  /**
   * Restores a snapshot onto the instance it was taken from.
   *
   * The data is restored beside the running instance first, then its system
   * disk is swapped: the instance stops only for the swap and restarts if it
   * was running. Everything written since the snapshot is lost; addresses,
   * security groups and attached volumes are kept, and the disk keeps its
   * current size. Only snapshots with `restorable` set can be restored.
   */
  async restoreSnapshot(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "POST", path: `/compute/snapshots/${encodeURIComponent(id)}/restore` });
  }

  async listImages(): Promise<Image[]> {
    const out = await this.client.request<{ images: Image[] }>({ method: "GET", path: "/compute/images" });
    return out.images ?? [];
  }

  /** Requires the `compute-flavors` organization feature, else 403. */
  async listFlavors(): Promise<Flavor[]> {
    const out = await this.client.request<{ flavors: Flavor[] }>({ method: "GET", path: "/compute/flavors" });
    return out.flavors ?? [];
  }

  /** Synchronous, unlike most writes. */
  async createFlavor(request: FlavorRequest): Promise<Flavor> {
    const out = await this.client.request<{ flavor: Flavor }>({
      method: "POST",
      path: "/compute/flavors",
      json: request,
    });
    return out.flavor;
  }

  async updateFlavor(id: string, request: FlavorRequest): Promise<Flavor> {
    const out = await this.client.request<{ flavor: Flavor }>({
      method: "PATCH",
      path: `/compute/flavors/${encodeURIComponent(id)}`,
      json: request,
    });
    return out.flavor;
  }

  async deleteFlavor(id: string): Promise<void> {
    await this.client.request<void>({
      method: "DELETE",
      path: `/compute/flavors/${encodeURIComponent(id)}`,
    });
  }

  async getPricing(): Promise<Record<string, unknown>> {
    const out = await this.client.request<{ pricing: Record<string, unknown> }>({
      method: "GET",
      path: "/compute/pricing",
    });
    return out.pricing;
  }

  async listKeypairs(): Promise<Keypair[]> {
    const out = await this.client.request<{ keypairs: Keypair[] }>({
      method: "GET",
      path: "/compute/keypairs",
    });
    return out.keypairs ?? [];
  }

  /**
   * Registers a public key, or generates one when `publicKey` is absent.
   *
   * Synchronous, unlike other writes: a generated private key exists only in
   * this one response.
   */
  async createKeypair(name: string, publicKey?: string): Promise<CreatedKeypair> {
    const task = await this.client.request<Task>({
      method: "POST",
      path: "/compute/keypairs",
      json: publicKey ? { name, public_key: publicKey } : { name },
    });
    const result = task.result ?? {};
    return {
      name,
      publicKey: typeof result["public_key"] === "string" ? result["public_key"] : "",
      privateKey: typeof result["private_key"] === "string" ? result["private_key"] : "",
      task,
    };
  }

  /**
   * Deletes a keypair by name, not by id.
   *
   * A name containing a slash cannot be deleted with this method: the API
   * routes on the decoded path, where the slash splits the name in two.
   */
  async deleteKeypair(name: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: `/compute/keypairs/${encodeURIComponent(name)}` });
  }

  /**
   * RRD metrics of an instance. `period` is one of {@link METRIC_PERIODS}
   * (`1h` by default); any other value throws before a request is sent, where
   * the API would answer 400.
   */
  async instanceMetrics(id: string, period?: MetricPeriod): Promise<Record<string, unknown>> {
    if (period !== undefined && !(METRIC_PERIODS as readonly string[]).includes(period)) {
      throw new Error(`nemau: period must be one of ${METRIC_PERIODS.join(", ")}`);
    }
    return this.client.request<Record<string, unknown>>({
      method: "GET",
      path: `/compute/instances/${encodeURIComponent(id)}/metrics`,
      ...(period ? { query: { period } } : {}),
    });
  }

  /**
   * Changes an instance's name, description or scheduled backup policy.
   *
   * The instance keeps running: nothing addresses it by name, so only its
   * label changes. A scheduled backup is a snapshot of the system disk, taken
   * as if the power were cut: attached block volumes are not in it, and a
   * database must dump itself.
   *
   * Throws before any request if a backup field is outside its range.
   */
  async updateInstance(id: string, update: InstanceUpdate): Promise<TaskRef> {
    checkBackupFields(update);
    return patch(this.client, "updateInstance", `/compute/instances/${encodeURIComponent(id)}`, update);
  }
}

const BACKUP_SCHEDULES: readonly string[] = Object.values(BackupSchedule);

/** Refuses a backup field outside the API's range; mirrors the server's check. */
function checkBackupFields(update: InstanceUpdate): void {
  const { backup_schedule, backup_hour, backup_weekday, backup_retention_days } = update;
  if (backup_schedule !== undefined && !BACKUP_SCHEDULES.includes(backup_schedule)) {
    throw new Error(`nemau: backup_schedule must be "none", "daily" or "weekly"`);
  }
  requireInteger("backup_hour", backup_hour, 0, 23);
  requireInteger("backup_weekday", backup_weekday, 0, 6);
  requireInteger("backup_retention_days", backup_retention_days, 1, 35);
}

function requireInteger(name: string, value: number | undefined, min: number, max: number): void {
  if (value !== undefined && !(Number.isInteger(value) && value >= min && value <= max)) {
    throw new Error(`nemau: ${name} must be an integer between ${min} and ${max}`);
  }
}
