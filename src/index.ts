/**
 * TypeScript client for the Nemau Cloud public API.
 *
 * @example
 * ```ts
 * import { NemauClient } from "@nemau-cloud/sdk";
 *
 * const nemau = new NemauClient();            // reads the environment
 * const instance = await nemau.compute.createInstanceAndWait({
 *   name: "web-1",
 *   image_id: "ubuntu-24.04",
 *   vcpus: 2,
 *   ram_mb: 4096,
 *   disk_gb: 40,
 * });
 * ```
 */

export {
  NemauClient,
  DEFAULT_BASE_URL,
  DEFAULT_RETRY,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  PROJECT_SCOPE_HEADER,
  VERSION,
  isTerminal,
} from "./client.ts";
export type { ClientOptions, RequestOptions, RetryPolicy } from "./client.ts";

export {
  AccessKey,
  BearerToken,
  SessionToken,
  credentialFromEnv,
  ENV_ACCESS_KEY_ID,
  ENV_ACCESS_KEY_SECRET,
  ENV_TOKEN,
  ENV_API_URL,
  ENV_PROJECT,
} from "./auth.ts";
export type { Credential } from "./auth.ts";

export {
  NemauApiError,
  NemauTaskFailedError,
  isNotFound,
  isUnauthorized,
  isForbidden,
  hasReason,
  isResourceInUse,
  isCredentialLimit,
  isIdempotencyKeyMismatch,
  isRateLimited,
  isAccessKeyLimit,
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_UNAVAILABLE,
  ERROR_CODE_IDEMPOTENCY_KEY_MISMATCH,
  REASON_ACCESS_KEY_LIMIT,
  isOrganizationReadOnly,
  ERROR_CODE_CREDENTIAL_LIMIT,
  ERROR_CODE_ORGANIZATION_READ_ONLY,
  ERROR_CODE_INVALID_REQUEST,
  isSubnetOverlap,
  REASON_SUBNET_OVERLAP,
  isCertificateInUse,
  REASON_CERTIFICATE_IN_USE,
} from "./errors.ts";

export * from "./types.ts";

export { METRIC_PERIODS, USER_DATA_MAX_BYTES } from "./services/compute.ts";
export type {
  CreateInstanceRequest,
  CreatedKeypair,
  FlavorRequest,
  InstanceUpdate,
  MetricPeriod,
} from "./services/compute.ts";
export {
  DEFAULT_ACCESS_KEY_TTL_MS,
  MAX_ACCESS_KEY_TTL_MS,
  MAX_ACCESS_KEYS_PER_USER,
} from "./services/iam.ts";
export type { CreateAccessKeyRequest, CreateUserRequest, UpdateUserRequest } from "./services/iam.ts";
export { FloatingIPTarget } from "./services/network.ts";
export type {
  AllocateFloatingIPRequest,
  CreateSubnetRequest,
  FloatingIPTargetValue,
  SecurityGroupRuleRequest,
} from "./services/network.ts";
export type {
  CreateDatabaseRequest,
  DatabaseMaintenanceWindowRequest,
  DeleteDatabaseOptions,
  RestoreDatabaseRequest,
  ResizeDatabaseRequest,
  UpdateDatabaseRequest,
} from "./services/databases.ts";
export {
  DATABASE_RETENTION_MAX_DAYS,
  DATABASE_RETENTION_MIN_DAYS,
  DATABASE_STORAGE_MAX_GB,
  DATABASE_STORAGE_MIN_GB,
} from "./services/databases.ts";
export {
  INSTANCE_GROUP_MAX_POLICIES,
  INSTANCE_GROUP_MAX_POOLS,
  INSTANCE_GROUP_MAX_SCHEDULES,
  INSTANCE_GROUP_MAX_SIZE,
} from "./services/instance-groups.ts";
export type {
  CreateInstanceGroupRequest,
  DeleteInstanceGroupOptions,
  InstanceGroupPolicyRequest,
  InstanceGroupPoolRequest,
  InstanceGroupScheduleRequest,
  InstanceGroupTemplateRequest,
  RefreshInstanceGroupRequest,
  UpdateInstanceGroupRequest,
} from "./services/instance-groups.ts";
export type {
  AddPoolMemberRequest,
  CreateHealthMonitorRequest,
  CreateListenerRequest,
  CreateLoadBalancerRequest,
  CreatePoolRequest,
  ImportCertificateRequest,
} from "./services/loadbalancer.ts";
export {
  DEFAULT_OBJECT_PAGE_SIZE,
  MAX_COPY_SIZE,
  MAX_OBJECT_PAGE_SIZE,
  MAX_OBJECT_SIZE,
  PRESIGN_TTL_CAP_SECONDS,
  RETENTION_COMPLIANCE,
  RETENTION_GOVERNANCE,
  isContainerImmutable,
} from "./services/storage.ts";
export { IssuedCredential } from "./services/storage.ts";
export type {
  CopiedObject,
  CopyObjectOptions,
  CreateContainerRequest,
  CreateCredentialRequest,
  CredentialAccess,
  ObjectPage,
  ObjectRetention,
  PresignedObject,
  StorageCredential,
  UploadedObject,
} from "./services/storage.ts";
export type {
  AddNodePoolRequest,
  CreateClusterRequest,
  MaintenanceWindowRequest,
  NodePoolInit,
} from "./services/kubernetes.ts";
export {
  DNS_ZONE_STATUS_ACTIVE,
  DNS_ZONE_STATUS_PENDING_VERIFICATION,
  REASON_DNS_ZONE_ALREADY_VERIFIED,
  REASON_DNS_ZONE_EXISTS,
  REASON_DNS_ZONE_PENDING_VERIFICATION,
  REASON_DNS_ZONE_RESERVED,
} from "./services/dns.ts";
export type {
  CreateRecordSetRequest,
  CreateZoneRequest,
  UpdateRecordSetRequest,
} from "./services/dns.ts";
export type { ResourceUpdate } from "./services/update.ts";
export type { UsageQuery } from "./services/metering.ts";
export { isProjectReady } from "./services/projects.ts";
export { bindingQuota, quotaAvailable, quotaScope } from "./services/quotas.ts";
