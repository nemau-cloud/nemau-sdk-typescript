import { Service } from "./base.ts";
import type {
  InstanceGroup,
  InstanceGroupActivity,
  InstanceGroupDetail,
  TaskRef,
} from "../types.ts";

/**
 * Comfort checks that mirror the API's ranges. The API judges every
 * value again, against the stored group where a field is merged, and its
 * answer wins. The client refuses early; it never decides.
 */
export const INSTANCE_GROUP_MAX_SIZE = 50;
export const INSTANCE_GROUP_MAX_NAME = 56;
const INSTANCE_GROUP_MAX_DESCRIPTION = 256;
export const INSTANCE_GROUP_MAX_POOLS = 4;
export const INSTANCE_GROUP_MAX_SECURITY_GROUPS = 5;
export const INSTANCE_GROUP_MAX_POLICIES = 2;
export const INSTANCE_GROUP_MAX_SCHEDULES = 10;

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CRON_FIELD_PATTERN = /^[0-9A-Za-z*/,-]{1,32}$/;
const CONTROL_PATTERN = /\p{Cc}/u;
const USER_DATA_MAX_BYTES = 16 * 1024;
const KEY_NAME_MAX_BYTES = 128;
const CRON_MAX_LENGTH = 128;
const SERVICE_LEVELS = ["", "besteffort", "best-effort", "best effort", "99.9", "99.9%"];

/** The launch template of a group. `image_id` is required on a create, optional on an update. */
export interface InstanceGroupTemplateRequest {
  /** A catalogue image. Its id is never a path or a URL. */
  image_id?: string;
  /** A catalogue flavor; or all of vcpus, ram_mb and disk_gb. */
  flavor_id?: string;
  vcpus?: number;
  ram_mb?: number;
  disk_gb?: number;
  key_name?: string;
  /** "99.9%" or "best-effort". */
  service_level?: string;
  /**
   * The cloud-init document of each member, at most 16 KiB. It must start with
   * `#cloud-config`, `#!` or a MIME multipart header. It is never echoed back:
   * the read shows only `user_data_present`.
   */
  user_data?: string;
}

export interface InstanceGroupPoolRequest {
  pool_id: string;
  protocol_port: number;
}

/** A target-tracking policy. Only `cpu_percent` is available in this version. */
export interface InstanceGroupPolicyRequest {
  metric: "cpu_percent";
  /** 10 to 90. */
  target: number;
  window_seconds?: number;
  scale_out_cooldown_seconds?: number;
  scale_in_cooldown_seconds?: number;
  scale_in_window_seconds?: number;
  max_step_out?: number;
  max_step_in?: number;
  scale_in_enabled?: boolean;
}

export interface CreateInstanceGroupRequest {
  name: string;
  /** Free text, at most 256 characters, on one line. */
  description?: string;
  network_id: string;
  subnet_id: string;
  min_size: number;
  max_size: number;
  /** Defaults to min_size on the server. */
  desired_capacity?: number;
  security_groups?: string[];
  launch_template: InstanceGroupTemplateRequest & { image_id: string };
  load_balancer_pools?: InstanceGroupPoolRequest[];
  /** Only "instance" is available in this version. */
  health_check?: "instance";
  health_check_grace_seconds?: number;
  drain_seconds?: number;
  scaling_policies?: InstanceGroupPolicyRequest[];
}

/**
 * Every field is optional. A `launch_template` is a new template version. A
 * `schedules` list replaces the previous one; `[]` clears it. A list sent as
 * `[]` clears that list, which is why absence and emptiness are told apart.
 */
export interface UpdateInstanceGroupRequest {
  /** Free text, at most 256 characters, on one line. An empty string clears it. */
  description?: string;
  min_size?: number;
  max_size?: number;
  max_unavailable_pct?: number;
  max_surge?: number;
  security_groups?: string[];
  launch_template?: InstanceGroupTemplateRequest;
  load_balancer_pools?: InstanceGroupPoolRequest[];
  health_check?: "instance";
  health_check_grace_seconds?: number;
  drain_seconds?: number;
  scaling_policies?: InstanceGroupPolicyRequest[];
  schedules?: InstanceGroupScheduleRequest[];
}

/** A scheduled action. `cron` has five fields and runs in UTC. */
export interface InstanceGroupScheduleRequest {
  cron: string;
  min_size?: number;
  max_size?: number;
  desired_capacity?: number;
}

/** Options of a rolling refresh. Both are optional; an absent one takes the group's current value. */
export interface RefreshInstanceGroupRequest {
  /** The share of members that may be out at once, 0 to 50. The share rounds down. */
  max_unavailable_pct?: number;
  /** Members started above the desired capacity before old ones leave, 1 to 10. */
  max_surge?: number;
}

export interface DeleteInstanceGroupOptions {
  /** Delete the members with the group. Without it, a group with members is refused. */
  deleteInstances?: boolean;
}

function refuse(message: string): never {
  throw new Error(`nemau: ${message}`);
}

/** Mirrors the API: at most 256 characters, one line. The API judges it again. */
function checkDescription(description: string | undefined): void {
  if (description === undefined) return;
  if (Array.from(description).length > INSTANCE_GROUP_MAX_DESCRIPTION || CONTROL_PATTERN.test(description)) {
    refuse("description must be at most 256 characters, on one line");
  }
}

function isUUID(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function checkSize(field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > INSTANCE_GROUP_MAX_SIZE) {
    refuse(`${field} must be between 0 and ${INSTANCE_GROUP_MAX_SIZE}`);
  }
}

function checkBounds(min: number, max: number, desired: number): void {
  if (!(min <= desired && desired <= max)) {
    refuse("min_size, desired_capacity and max_size must satisfy min_size <= desired_capacity <= max_size");
  }
}

function checkSecurityGroups(ids: string[] | undefined): void {
  if (ids === undefined) return;
  if (ids.length > INSTANCE_GROUP_MAX_SECURITY_GROUPS) {
    refuse(`security_groups accepts at most ${INSTANCE_GROUP_MAX_SECURITY_GROUPS} groups`);
  }
  for (const id of ids) {
    if (!isUUID(id)) refuse("security_groups must hold security group ids");
  }
}

function checkPools(pools: InstanceGroupPoolRequest[] | undefined): void {
  if (pools === undefined) return;
  if (pools.length > INSTANCE_GROUP_MAX_POOLS) {
    refuse(`load_balancer_pools accepts at most ${INSTANCE_GROUP_MAX_POOLS} pools`);
  }
  const seen = new Set<string>();
  for (const pool of pools) {
    if (!isUUID(pool.pool_id)) refuse("load_balancer_pools pool_id must be a pool id");
    if (!Number.isInteger(pool.protocol_port) || pool.protocol_port < 1 || pool.protocol_port > 65535) {
      refuse("load_balancer_pools protocol_port must be between 1 and 65535");
    }
    if (seen.has(pool.pool_id)) refuse("load_balancer_pools lists a pool twice");
    seen.add(pool.pool_id);
  }
}

function checkRange(field: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    refuse(`scaling policy ${field} must be between ${min} and ${max}`);
  }
}

function checkPolicies(policies: InstanceGroupPolicyRequest[] | undefined): void {
  if (policies === undefined) return;
  if (policies.length > INSTANCE_GROUP_MAX_POLICIES) {
    refuse(`scaling_policies accepts at most ${INSTANCE_GROUP_MAX_POLICIES} policies`);
  }
  const seen = new Set<string>();
  for (const policy of policies) {
    if ((policy.metric as string) === "memory_percent") refuse("the memory_percent metric is not available yet");
    if (policy.metric !== "cpu_percent") refuse("scaling_policies metric must be cpu_percent");
    if (seen.has(policy.metric)) refuse("scaling_policies lists a metric twice");
    seen.add(policy.metric);
    if (policy.target === undefined) refuse("scaling policy target is required");
    checkRange("target", policy.target, 10, 90);
    checkRange("window_seconds", policy.window_seconds, 180, 900);
    checkRange("scale_out_cooldown_seconds", policy.scale_out_cooldown_seconds, 60, 3600);
    checkRange("scale_in_cooldown_seconds", policy.scale_in_cooldown_seconds, 60, 3600);
    checkRange("scale_in_window_seconds", policy.scale_in_window_seconds, 300, 3600);
    checkRange("max_step_out", policy.max_step_out, 1, 10);
    checkRange("max_step_in", policy.max_step_in, 1, 5);
  }
}

function checkHealth(healthCheck: string | undefined, grace: number | undefined, drain: number | undefined): void {
  if (healthCheck === "load_balancer") refuse("health_check load_balancer is not available yet");
  if (healthCheck !== undefined && healthCheck !== "" && healthCheck !== "instance") refuse("health_check must be instance");
  if (grace !== undefined && (!Number.isInteger(grace) || grace < 60 || grace > 1800)) {
    refuse("health_check_grace_seconds must be between 60 and 1800");
  }
  if (drain !== undefined && (!Number.isInteger(drain) || drain < 0 || drain > 300)) {
    refuse("drain_seconds must be between 0 and 300");
  }
}

/** Five whitespace-separated cron fields, in UTC. Six fields and @-descriptors are refused. */
function checkCron(spec: string): void {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5 || fields.join(" ").length > CRON_MAX_LENGTH || !fields.every((f) => CRON_FIELD_PATTERN.test(f))) {
    refuse("schedules cron must be 5 fields, in UTC");
  }
}

function checkSchedules(schedules: InstanceGroupScheduleRequest[] | undefined): void {
  if (schedules === undefined) return;
  if (schedules.length > INSTANCE_GROUP_MAX_SCHEDULES) {
    refuse(`schedules accepts at most ${INSTANCE_GROUP_MAX_SCHEDULES} actions`);
  }
  for (const s of schedules) {
    checkCron(s.cron);
    if (s.min_size === undefined && s.max_size === undefined && s.desired_capacity === undefined) {
      refuse("a schedule sets at least one of min_size, max_size, desired_capacity");
    }
    for (const value of [s.min_size, s.max_size, s.desired_capacity]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > INSTANCE_GROUP_MAX_SIZE)) {
        refuse(`schedule sizes must be between 0 and ${INSTANCE_GROUP_MAX_SIZE}`);
      }
    }
    if (s.min_size !== undefined && s.max_size !== undefined && s.min_size > s.max_size) {
      refuse("a schedule's min_size must not exceed its max_size");
    }
    if (s.min_size !== undefined && s.desired_capacity !== undefined && s.max_size !== undefined) {
      checkBounds(s.min_size, s.max_size, s.desired_capacity);
    }
  }
}

/** The user_data rules of the API: size, no NUL, not blank, a recognised first line. */
export function checkUserData(document: string): void {
  if (new TextEncoder().encode(document).length > USER_DATA_MAX_BYTES) {
    refuse("user_data must not exceed 16384 bytes");
  }
  if (document.includes("\u0000")) refuse("user_data must not contain NUL bytes");
  if (document.trim() === "") refuse("user_data must not be empty");
  const firstLine = (document.split("\n", 1)[0] ?? "").replace(/\r$/, "");
  if (firstLine === "#cloud-config" || firstLine.startsWith("#!")) return;
  if (/^content-type: multipart\//i.test(firstLine)) return;
  refuse("user_data must start with #cloud-config, #! or a MIME multipart header");
}

function checkTemplate(template: InstanceGroupTemplateRequest, create: boolean): void {
  if (template.image_id !== undefined && !IMAGE_REF_PATTERN.test(template.image_id)) {
    refuse("launch_template.image_id is not a valid image id");
  }
  if (create && template.image_id === undefined) refuse("launch_template.image_id is required");
  if (template.flavor_id !== undefined && !IMAGE_REF_PATTERN.test(template.flavor_id)) {
    refuse("launch_template.flavor_id is not a valid flavor id");
  }
  const level = (template.service_level ?? "").trim().toLowerCase();
  if (!SERVICE_LEVELS.includes(level)) refuse("launch_template.service_level must be 99.9% or best-effort");
  if (template.key_name !== undefined) {
    if (new TextEncoder().encode(template.key_name).length > KEY_NAME_MAX_BYTES || CONTROL_PATTERN.test(template.key_name)) {
      refuse("launch_template.key_name is not valid");
    }
  }
  const sized = template.vcpus !== undefined || template.ram_mb !== undefined || template.disk_gb !== undefined;
  if (template.flavor_id === undefined && (create || sized)) {
    if (template.vcpus === undefined || template.ram_mb === undefined || template.disk_gb === undefined) {
      refuse("launch_template needs flavor_id or vcpus, ram_mb and disk_gb together");
    }
    if (!Number.isInteger(template.vcpus) || template.vcpus < 1 || template.vcpus > 64) {
      refuse("launch_template.vcpus must be between 1 and 64");
    }
    if (!Number.isInteger(template.ram_mb) || template.ram_mb < 1024 || template.ram_mb > 262144 || template.ram_mb % 256 !== 0) {
      refuse("launch_template.ram_mb must be a multiple of 256 between 1024 and 262144");
    }
    if (!Number.isInteger(template.disk_gb) || template.disk_gb < 10 || template.disk_gb > 5000) {
      refuse("launch_template.disk_gb must be between 10 and 5000");
    }
  }
  if (template.user_data !== undefined) checkUserData(template.user_data);
}

/** The template as the API reads it: the same keys, only the ones the caller set. */
const TEMPLATE_KEYS = ["image_id", "flavor_id", "vcpus", "ram_mb", "disk_gb", "key_name", "service_level", "user_data"] as const;

function templateBody(template: InstanceGroupTemplateRequest): Record<string, unknown> {
  const json: Record<string, unknown> = {};
  for (const key of TEMPLATE_KEYS) {
    if (template[key] !== undefined) json[key] = template[key];
  }
  return json;
}

const POLICY_KEYS = ["metric", "target", "window_seconds", "scale_out_cooldown_seconds", "scale_in_cooldown_seconds", "scale_in_window_seconds", "max_step_out", "max_step_in", "scale_in_enabled"] as const;

function policyBody(policy: InstanceGroupPolicyRequest): Record<string, unknown> {
  const json: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) {
    if (policy[key] !== undefined) json[key] = policy[key];
  }
  return json;
}

function poolBody(pool: InstanceGroupPoolRequest): Record<string, unknown> {
  return { pool_id: pool.pool_id, protocol_port: pool.protocol_port };
}

function dropUndefined(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function scheduleBody(schedule: InstanceGroupScheduleRequest): Record<string, unknown> {
  return dropUndefined({
    cron: schedule.cron.trim().split(/\s+/).join(" "),
    min_size: schedule.min_size,
    max_size: schedule.max_size,
    desired_capacity: schedule.desired_capacity,
  });
}

/**
 * Instance groups: a set of identical members built from a versioned
 * launch template, kept between a minimum and a maximum, registered in load
 * balancer pools, and scaled by policies or a schedule.
 *
 * Writes answer 202 with a task. A member cannot be changed on its own: a
 * group owns its instances, so deleting or resizing one is refused with 409.
 */
export class InstanceGroupService extends Service {
  async list(): Promise<InstanceGroup[]> {
    const out = await this.client.request<{ instance_groups: InstanceGroup[] }>({
      method: "GET",
      path: "/compute/instance-groups",
    });
    return out.instance_groups ?? [];
  }

  /** The group with its members and its recent activities. */
  async get(id: string): Promise<InstanceGroupDetail> {
    const out = await this.client.request<{ instance_group: InstanceGroupDetail }>({
      method: "GET",
      path: `/compute/instance-groups/${encodeURIComponent(id)}`,
    });
    return out.instance_group;
  }

  /** The 200 most recent decisions of the group, newest first. */
  async activities(id: string): Promise<InstanceGroupActivity[]> {
    const out = await this.client.request<{ activities: InstanceGroupActivity[] }>({
      method: "GET",
      path: `/compute/instance-groups/${encodeURIComponent(id)}/activities`,
    });
    return out.activities ?? [];
  }

  async create(request: CreateInstanceGroupRequest): Promise<TaskRef> {
    if (request.name.length > INSTANCE_GROUP_MAX_NAME || !NAME_PATTERN.test(request.name)) {
      refuse("name must be 1 to 56 lowercase letters, digits or hyphens, starting and ending with a letter or digit");
    }
    if (!isUUID(request.network_id)) refuse("network_id must be a network id");
    if (!isUUID(request.subnet_id)) refuse("subnet_id must be a subnet id");
    checkSize("min_size", request.min_size);
    checkSize("max_size", request.max_size);
    checkSize("desired_capacity", request.desired_capacity);
    checkBounds(request.min_size, request.max_size, request.desired_capacity ?? request.min_size);
    checkTemplate(request.launch_template, true);
    checkSecurityGroups(request.security_groups);
    checkPools(request.load_balancer_pools);
    checkHealth(request.health_check, request.health_check_grace_seconds, request.drain_seconds);
    checkPolicies(request.scaling_policies);
    checkDescription(request.description);

    const json: Record<string, unknown> = {
      name: request.name,
      network_id: request.network_id,
      subnet_id: request.subnet_id,
      min_size: request.min_size,
      max_size: request.max_size,
      launch_template: templateBody(request.launch_template),
    };
    if (request.description !== undefined) json.description = request.description;
    if (request.desired_capacity !== undefined) json.desired_capacity = request.desired_capacity;
    if (request.security_groups !== undefined) json.security_groups = request.security_groups;
    if (request.load_balancer_pools !== undefined) json.load_balancer_pools = request.load_balancer_pools.map(poolBody);
    if (request.health_check) json.health_check = request.health_check;
    if (request.health_check_grace_seconds !== undefined) json.health_check_grace_seconds = request.health_check_grace_seconds;
    if (request.drain_seconds !== undefined) json.drain_seconds = request.drain_seconds;
    if (request.scaling_policies !== undefined) json.scaling_policies = request.scaling_policies.map(policyBody);
    return this.client.submit({ method: "POST", path: "/compute/instance-groups", json });
  }

  async update(id: string, request: UpdateInstanceGroupRequest): Promise<TaskRef> {
    const json: Record<string, unknown> = {};
    if (request.description !== undefined) {
      checkDescription(request.description);
      json.description = request.description;
    }
    if (request.min_size !== undefined) {
      checkSize("min_size", request.min_size);
      json.min_size = request.min_size;
    }
    if (request.max_size !== undefined) {
      checkSize("max_size", request.max_size);
      json.max_size = request.max_size;
    }
    if (request.min_size !== undefined && request.max_size !== undefined && request.min_size > request.max_size) {
      refuse("min_size must not exceed max_size");
    }
    if (request.max_unavailable_pct !== undefined) {
      if (!Number.isInteger(request.max_unavailable_pct) || request.max_unavailable_pct < 0 || request.max_unavailable_pct > 50) {
        refuse("max_unavailable_pct must be between 0 and 50");
      }
      json.max_unavailable_pct = request.max_unavailable_pct;
    }
    if (request.max_surge !== undefined) {
      if (!Number.isInteger(request.max_surge) || request.max_surge < 1 || request.max_surge > 10) {
        refuse("max_surge must be between 1 and 10");
      }
      json.max_surge = request.max_surge;
    }
    checkSecurityGroups(request.security_groups);
    if (request.security_groups !== undefined) json.security_groups = request.security_groups;
    if (request.launch_template !== undefined) {
      checkTemplate(request.launch_template, false);
      json.launch_template = templateBody(request.launch_template);
    }
    checkPools(request.load_balancer_pools);
    if (request.load_balancer_pools !== undefined) json.load_balancer_pools = request.load_balancer_pools.map(poolBody);
    checkHealth(request.health_check, request.health_check_grace_seconds, request.drain_seconds);
    if (request.health_check) json.health_check = request.health_check;
    if (request.health_check_grace_seconds !== undefined) json.health_check_grace_seconds = request.health_check_grace_seconds;
    if (request.drain_seconds !== undefined) json.drain_seconds = request.drain_seconds;
    checkPolicies(request.scaling_policies);
    if (request.scaling_policies !== undefined) json.scaling_policies = request.scaling_policies.map(policyBody);
    checkSchedules(request.schedules);
    if (request.schedules !== undefined) json.schedules = request.schedules.map(scheduleBody);

    if (Object.keys(json).length === 0) refuse("instanceGroup.update was given no field to change");
    return this.client.submit({ method: "PATCH", path: `/compute/instance-groups/${encodeURIComponent(id)}`, json });
  }

  /** Sets the desired capacity, between the group's min and max. */
  async setCapacity(id: string, desiredCapacity: number): Promise<TaskRef> {
    checkSize("desired_capacity", desiredCapacity);
    return this.client.submit({
      method: "PUT",
      path: `/compute/instance-groups/${encodeURIComponent(id)}/capacity`,
      json: { desired_capacity: desiredCapacity },
    });
  }

  /**
   * Starts a rolling refresh: members are replaced one by one, within the
   * shares given, until each runs the group's current template version.
   * Protected members are skipped and counted in `refresh.skipped_protected`.
   */
  async refresh(id: string, request: RefreshInstanceGroupRequest = {}): Promise<TaskRef> {
    const json: Record<string, unknown> = {};
    if (request.max_unavailable_pct !== undefined) {
      if (!Number.isInteger(request.max_unavailable_pct) || request.max_unavailable_pct < 0 || request.max_unavailable_pct > 50) {
        refuse("max_unavailable_pct must be between 0 and 50");
      }
      json.max_unavailable_pct = request.max_unavailable_pct;
    }
    if (request.max_surge !== undefined) {
      if (!Number.isInteger(request.max_surge) || request.max_surge < 1 || request.max_surge > 10) {
        refuse("max_surge must be between 1 and 10");
      }
      json.max_surge = request.max_surge;
    }
    return this.client.submit({
      method: "POST",
      path: `/compute/instance-groups/${encodeURIComponent(id)}/refresh`,
      json,
    });
  }

  /** Cancels the refresh in progress. The members already replaced stay on the new version. */
  async cancelRefresh(id: string): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/compute/instance-groups/${encodeURIComponent(id)}/refresh/cancel`,
    });
  }

  /**
   * Protects one member from scale-in, or lifts the protection. The member must
   * belong to this group.
   */
  async setMemberProtection(groupId: string, instanceId: string, protectedFromScaleIn: boolean): Promise<TaskRef> {
    return this.client.submit({
      method: "PUT",
      path: `/compute/instance-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(instanceId)}/protection`,
      json: { protected: protectedFromScaleIn },
    });
  }

  /** Deletes the group. A group that still has members is refused unless `deleteInstances` is set. */
  async delete(id: string, options: DeleteInstanceGroupOptions = {}): Promise<TaskRef> {
    const path = `/compute/instance-groups/${encodeURIComponent(id)}`;
    return options.deleteInstances
      ? this.client.submit({ method: "DELETE", path, query: { delete_instances: "true" } })
      : this.client.submit({ method: "DELETE", path });
  }
}
