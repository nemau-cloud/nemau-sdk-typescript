import { Service } from "./base.ts";
import { notFound } from "../errors.ts";
import type {
  Certificate,
  HealthMonitor,
  Listener,
  LoadBalancer,
  LoadBalancerFlavor,
  Pool,
  PoolMember,
  TaskRef,
} from "../types.ts";
import { patch, type ResourceUpdate } from "./update.ts";

/**
 * A new load balancer runs in automatic mode, which serves HTTP, HTTPS, TCP and
 * UDP listeners side by side. There is no engine to choose.
 */
export interface CreateLoadBalancerRequest {
  name: string;
  description?: string;
  /** The VIP is allocated in this subnet. Required. */
  vip_subnet_id: string;
  /**
   * The tier; absent means lb-small. lb-ha, lb-medium and lb-large run two
   * appliances on two hosts behind the same VIP. Fixed at creation.
   */
  flavor?: string;
}

/**
 * `admin_state_up` is optional and keeps "unset" distinct from "false": the
 * API defaults an absent value to true.
 */
export interface CreateListenerRequest {
  name: string;
  description?: string;
  protocol: string;
  protocol_port: number;
  default_pool_id?: string;
  connection_limit?: number;
  /**
   * Required for TERMINATED_HTTPS, refused otherwise: the ID of a certificate
   * imported with {@link LoadBalancerService.importCertificate}.
   */
  tls_certificate_ref?: string;
  admin_state_up?: boolean;
}

/**
 * PEM-encoded material. `certificate` holds the leaf, optionally followed by
 * its chain (a fullchain.pem); `chain` adds intermediates. The key must not be
 * passphrase-protected: RSA 2048 to 4096 bits, ECDSA P-256 or P-384.
 */
export interface ImportCertificateRequest {
  name: string;
  certificate: string;
  chain?: string;
  private_key: string;
}

const CERTIFICATES_PATH = "/network/load-balancer-certificates";

export interface CreatePoolRequest {
  name: string;
  description?: string;
  protocol: string;
  lb_algorithm: string;
  listener_id?: string;
  session_persistence?: Record<string, string>;
  admin_state_up?: boolean;
}

/** `weight` defaults to 1 server-side when absent. */
export interface AddPoolMemberRequest {
  name: string;
  address: string;
  protocol_port: number;
  weight?: number;
  subnet_id?: string;
  admin_state_up?: boolean;
}

/** `type` is HTTP, HTTPS, TCP or UDP_CONNECT. */
export interface CreateHealthMonitorRequest {
  type: string;
  delay: number;
  timeout: number;
  max_retries: number;
  http_method?: string;
  url_path?: string;
  expected_codes?: string;
  admin_state_up?: boolean;
}

/** The load-balancer half of /network. */
export class LoadBalancerService extends Service {
  async list(): Promise<LoadBalancer[]> {
    const out = await this.client.request<{ load_balancers: LoadBalancer[] }>({
      method: "GET",
      path: "/network/load-balancers",
    });
    return out.load_balancers ?? [];
  }

  /** The load-balancer tiers, with their sizing and price. */
  async listFlavors(): Promise<LoadBalancerFlavor[]> {
    const out = await this.client.request<{ flavors: LoadBalancerFlavor[] }>({
      method: "GET",
      path: "/network/load-balancer-flavors",
    });
    return out.flavors ?? [];
  }

  async get(id: string): Promise<LoadBalancer> {
    const out = await this.client.request<{ load_balancer: LoadBalancer }>({
      method: "GET",
      path: `/network/load-balancers/${encodeURIComponent(id)}`,
    });
    return out.load_balancer;
  }

  async create(request: CreateLoadBalancerRequest): Promise<TaskRef> {
    return this.client.submit({ method: "POST", path: "/network/load-balancers", json: request });
  }

  async createAndWait(request: CreateLoadBalancerRequest): Promise<LoadBalancer> {
    const ref = await this.create(request);
    const { id } = await this.client.waitForResourceId(ref, "load_balancer_id");
    return this.get(id);
  }

  async delete(id: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/network/load-balancers/${encodeURIComponent(id)}`,
    });
  }

  /** `lbId` is required: there is no global listener list. */
  async listListeners(lbId: string): Promise<Listener[]> {
    const out = await this.client.request<{ listeners: Listener[] }>({
      method: "GET",
      path: "/network/listeners",
      query: { lb_id: lbId },
    });
    return out.listeners ?? [];
  }

  async getListener(lbId: string, id: string): Promise<Listener> {
    const found = (await this.listListeners(lbId)).find((l) => l.id === id);
    if (!found) throw notFound("listener", id, "/network/listeners");
    return found;
  }

  async createListener(lbId: string, request: CreateListenerRequest): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/network/load-balancers/${encodeURIComponent(lbId)}/listeners`,
      json: request,
    });
  }

  async deleteListener(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: `/network/listeners/${encodeURIComponent(id)}` });
  }

  async listPools(lbId: string): Promise<Pool[]> {
    const out = await this.client.request<{ pools: Pool[] }>({
      method: "GET",
      path: "/network/pools",
      query: { lb_id: lbId },
    });
    return out.pools ?? [];
  }

  async getPool(lbId: string, id: string): Promise<Pool> {
    const found = (await this.listPools(lbId)).find((p) => p.id === id);
    if (!found) throw notFound("pool", id, "/network/pools");
    return found;
  }

  async createPool(lbId: string, request: CreatePoolRequest): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/network/load-balancers/${encodeURIComponent(lbId)}/pools`,
      json: request,
    });
  }

  async deletePool(poolId: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: `/network/pools/${encodeURIComponent(poolId)}` });
  }

  async listPoolMembers(poolId: string): Promise<PoolMember[]> {
    const out = await this.client.request<{ members: PoolMember[] }>({
      method: "GET",
      path: `/network/pools/${encodeURIComponent(poolId)}/members`,
    });
    return out.members ?? [];
  }

  async getPoolMember(poolId: string, id: string): Promise<PoolMember> {
    const found = (await this.listPoolMembers(poolId)).find((m) => m.id === id);
    if (!found) throw notFound("pool member", id, `/network/pools/${poolId}/members`);
    return found;
  }

  async addPoolMember(poolId: string, request: AddPoolMemberRequest): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/network/pools/${encodeURIComponent(poolId)}/members`,
      json: request,
    });
  }

  async removePoolMember(poolId: string, memberId: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/network/pools/${encodeURIComponent(poolId)}/members/${encodeURIComponent(memberId)}`,
    });
  }

  async listPoolHealthMonitors(poolId: string): Promise<HealthMonitor[]> {
    const out = await this.client.request<{ health_monitors: HealthMonitor[] }>({
      method: "GET",
      path: `/network/pools/${encodeURIComponent(poolId)}/health-monitors`,
    });
    return out.health_monitors ?? [];
  }

  async getHealthMonitor(poolId: string, id: string): Promise<HealthMonitor> {
    const found = (await this.listPoolHealthMonitors(poolId)).find((m) => m.id === id);
    if (!found) throw notFound("health monitor", id, `/network/pools/${poolId}/health-monitors`);
    return found;
  }

  async createHealthMonitor(poolId: string, request: CreateHealthMonitorRequest): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/network/pools/${encodeURIComponent(poolId)}/health-monitors`,
      json: request,
    });
  }

  async deleteHealthMonitor(poolId: string, monitorId: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/network/pools/${encodeURIComponent(poolId)}/health-monitors/${encodeURIComponent(monitorId)}`,
    });
  }

  /** Changes a load balancer's name or description. */
  async updateLoadBalancer(id: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateLoadBalancer", `/network/load-balancers/${encodeURIComponent(id)}`, update);
  }

  /**
   * Validates and stores a certificate. Synchronous: a listener can use it as
   * soon as this resolves. The private key is not part of the response.
   */
  async importCertificate(request: ImportCertificateRequest): Promise<Certificate> {
    return this.client.request<Certificate>({ method: "POST", path: CERTIFICATES_PATH, json: request });
  }

  /** The project's certificates and the listeners that serve them. */
  async listCertificates(): Promise<Certificate[]> {
    const out = await this.client.request<{ certificates: Certificate[] }>({ method: "GET", path: CERTIFICATES_PATH });
    return out.certificates ?? [];
  }

  async getCertificate(id: string): Promise<Certificate> {
    return this.client.request<Certificate>({ method: "GET", path: `${CERTIFICATES_PATH}/${encodeURIComponent(id)}` });
  }

  /**
   * Removes a certificate no listener serves any more. While one does, the API
   * answers 409; see {@link isCertificateInUse}.
   */
  async deleteCertificate(id: string): Promise<void> {
    await this.client.request<void>({ method: "DELETE", path: `${CERTIFICATES_PATH}/${encodeURIComponent(id)}` });
  }

  /**
   * Changes a listener's name, description, connection limit or, on a
   * TERMINATED_HTTPS listener, its certificate. Pointing the listener at a new
   * certificate renews it without downtime.
   */
  async updateListener(id: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateListener", `/network/listeners/${encodeURIComponent(id)}`, update);
  }

  /**
   * Changes a pool's name, description or balancing algorithm. The appliance
   * config is rewritten in place; established connections are not dropped.
   */
  async updatePool(id: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updatePool", `/network/pools/${encodeURIComponent(id)}`, update);
  }

  /** Changes a member's name or weight. */
  async updatePoolMember(poolId: string, memberId: string, update: ResourceUpdate): Promise<TaskRef> {
    const path = `/network/pools/${encodeURIComponent(poolId)}/members/${encodeURIComponent(memberId)}`;
    return patch(this.client, "updatePoolMember", path, update);
  }

  /** Changes a monitor's probe timings or expected codes. */
  async updateHealthMonitor(poolId: string, monitorId: string, update: ResourceUpdate): Promise<TaskRef> {
    const path = `/network/pools/${encodeURIComponent(poolId)}/health-monitors/${encodeURIComponent(monitorId)}`;
    return patch(this.client, "updateHealthMonitor", path, update);
  }
}
