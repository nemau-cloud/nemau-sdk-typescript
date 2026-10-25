import { Service } from "./base.ts";
import { notFound } from "../errors.ts";
import { patch, type ResourceUpdate } from "./update.ts";
import type {
  AllocationPool,
  FloatingIP,
  IPVersion,
  Network,
  NetworkCapabilities,
  NetworkInterface,
  SecurityGroup,
  Subnet,
  TaskRef,
} from "../types.ts";

/**
 * A subnet inside a network.
 *
 * `ip_version` defaults to 4, for which `cidr` is required. For 6, leave
 * `cidr`, `gateway_ip` and `allocation_pools` out: the platform assigns a /64
 * from the region's routed prefix and uses its first address as the gateway.
 * The network must already have an IPv4 subnet, and carries at most one IPv6
 * subnet.
 */
export interface CreateSubnetRequest {
  name: string;
  cidr?: string;
  ip_version?: IPVersion;
  gateway_ip?: string;
  dns_servers?: string[];
  allocation_pools?: AllocationPool[];
}

/**
 * An address allocation. Every field is optional: no `floating_network_id`
 * uses the region's external network, and no `ip_version` means 4.
 */
export interface AllocateFloatingIPRequest {
  floating_network_id?: string;
  description?: string;
  ip_version?: IPVersion;
}

/**
 * A security-group rule.
 *
 * Leave `port_range_min` and `port_range_max` absent for a protocol with no
 * ports: the API forwards them only when one of the two is non-zero.
 */
export interface SecurityGroupRuleRequest {
  /** ingress | egress */
  direction: string;
  protocol?: string;
  port_range_min?: number;
  port_range_max?: number;
  remote_ip_prefix?: string;
}

/** Association targets for a floating IP. */
export const FloatingIPTarget = {
  Instance: "instance",
  LoadBalancer: "load_balancer",
} as const;

export type FloatingIPTargetValue = (typeof FloatingIPTarget)[keyof typeof FloatingIPTarget];

/** /network: networks, subnets, ports, floating IPs, security groups. */
export class NetworkService extends Service {
  async listNetworks(): Promise<Network[]> {
    const out = await this.client.request<{ networks: Network[] }>({
      method: "GET",
      path: "/network/networks",
    });
    return out.networks ?? [];
  }

  /**
   * The API has no per-network read, so this lists and filters. An unknown id
   * throws a 404 `NemauApiError`, which `isNotFound` recognises.
   */
  async getNetwork(id: string): Promise<Network> {
    const found = (await this.listNetworks()).find((n) => n.id === id);
    if (!found) throw notFound("network", id, "/network/networks");
    return found;
  }

  async createNetwork(name: string, description = ""): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: "/network/networks",
      json: { name, description },
    });
  }

  async createNetworkAndWait(name: string, description = ""): Promise<Network> {
    const ref = await this.createNetwork(name, description);
    const { id } = await this.client.waitForResourceId(ref, "network_id");
    return this.getNetwork(id);
  }

  async deleteNetwork(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: `/network/networks/${encodeURIComponent(id)}` });
  }

  async listSubnets(): Promise<Subnet[]> {
    const out = await this.client.request<{ subnets: Subnet[] }>({
      method: "GET",
      path: "/network/subnets",
    });
    return out.subnets ?? [];
  }

  async getSubnet(id: string): Promise<Subnet> {
    const found = (await this.listSubnets()).find((s) => s.id === id);
    if (!found) throw notFound("subnet", id, "/network/subnets");
    return found;
  }

  /**
   * The CIDR must not overlap any other subnet of the project, on this network
   * or another: the API refuses it with a 409 that `isSubnetOverlap` recognises.
   */
  async createSubnet(networkId: string, request: CreateSubnetRequest): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/network/networks/${encodeURIComponent(networkId)}/subnets`,
      json: request,
    });
  }

  async deleteSubnet(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: `/network/subnets/${encodeURIComponent(id)}` });
  }

  async listNetworkInterfaces(): Promise<NetworkInterface[]> {
    const out = await this.client.request<{ interfaces: NetworkInterface[] }>({
      method: "GET",
      path: "/network/interfaces",
    });
    return out.interfaces ?? [];
  }

  /** The platform spells the key `floatingips`, with no separator. */
  async listFloatingIPs(): Promise<FloatingIP[]> {
    const out = await this.client.request<{ floatingips: FloatingIP[] }>({
      method: "GET",
      path: "/network/floating-ips",
    });
    return out.floatingips ?? [];
  }

  async getFloatingIP(id: string): Promise<FloatingIP> {
    const found = (await this.listFloatingIPs()).find((f) => f.id === id);
    if (!found) throw notFound("floating ip", id, "/network/floating-ips");
    return found;
  }

  /**
   * Starts an address allocation. Pass a request to pick the IP version; the
   * two-string form allocates IPv4, and an empty `externalNetworkId` uses the
   * region's external network. An IPv6 allocation is refused with a 400 in a
   * region that does not offer it; see {@link getCapabilities}.
   */
  async allocateFloatingIP(request?: AllocateFloatingIPRequest): Promise<TaskRef>;
  async allocateFloatingIP(externalNetworkId?: string, description?: string): Promise<TaskRef>;
  async allocateFloatingIP(
    requestOrNetworkId: AllocateFloatingIPRequest | string = "",
    description = "",
  ): Promise<TaskRef> {
    const request: AllocateFloatingIPRequest =
      typeof requestOrNetworkId === "string"
        ? { floating_network_id: requestOrNetworkId, description }
        : requestOrNetworkId;
    const json: Record<string, string | number> = {};
    if (request.floating_network_id) json["floating_network_id"] = request.floating_network_id;
    if (request.description) json["description"] = request.description;
    if (request.ip_version) json["ip_version"] = request.ip_version;
    return this.client.submit({ method: "POST", path: "/network/floating-ips", json });
  }

  async releaseFloatingIP(id: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/network/floating-ips/${encodeURIComponent(id)}`,
    });
  }

  async associateFloatingIP(
    id: string,
    targetType: FloatingIPTargetValue,
    targetId: string,
  ): Promise<TaskRef> {
    return this.client.submit({
      method: "PUT",
      path: `/network/floating-ips/${encodeURIComponent(id)}/associate`,
      json: { target_type: targetType, target_id: targetId },
    });
  }

  /** Detaches the address from its target, keeping the allocation. */
  async disassociateFloatingIP(id: string): Promise<TaskRef> {
    return this.client.submit({
      method: "PUT",
      path: `/network/floating-ips/${encodeURIComponent(id)}/disassociate`,
    });
  }

  /** Which optional network features (IPv6 floating IPs, IPv6 subnets) the region offers. */
  async getCapabilities(): Promise<NetworkCapabilities> {
    const out = await this.client.request<{ capabilities: NetworkCapabilities }>({
      method: "GET",
      path: "/network/capabilities",
    });
    return out.capabilities;
  }

  async listSecurityGroups(): Promise<SecurityGroup[]> {
    const out = await this.client.request<{ security_groups: SecurityGroup[] }>({
      method: "GET",
      path: "/network/security-groups",
    });
    return out.security_groups ?? [];
  }

  async getSecurityGroup(id: string): Promise<SecurityGroup> {
    const found = (await this.listSecurityGroups()).find((s) => s.id === id);
    if (!found) throw notFound("security group", id, "/network/security-groups");
    return found;
  }

  async createSecurityGroup(name: string, description = ""): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: "/network/security-groups",
      json: { name, description },
    });
  }

  async deleteSecurityGroup(id: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/network/security-groups/${encodeURIComponent(id)}`,
    });
  }

  async createSecurityGroupRule(groupId: string, request: SecurityGroupRuleRequest): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/network/security-groups/${encodeURIComponent(groupId)}/rules`,
      json: request,
    });
  }

  /**
   * Converts a security group created before egress filtering existed. The
   * group receives two egress rules that allow all outbound traffic
   * (`0.0.0.0/0` and `::/0`), then every instance carrying it has its outbound
   * policy recomputed: an instance whose groups all filter egress only sends
   * what one of their egress rules allows.
   *
   * Traffic is unchanged when the task completes, since the added rules allow
   * everything; removing or narrowing them afterwards takes effect. The
   * conversion cannot be undone, and running it on a group that already
   * filters egress succeeds without adding anything.
   */
  async enableSecurityGroupEgressFiltering(id: string): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/network/security-groups/${encodeURIComponent(id)}/enable-egress-filtering`,
    });
  }

  async deleteSecurityGroupRule(groupId: string, ruleId: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/network/security-groups/${encodeURIComponent(groupId)}/rules/${encodeURIComponent(ruleId)}`,
    });
  }

  /**
   * Changes a network's name or description.
   *
   * The network is not rebuilt: its identifier and its segment stay as they
   * are, so every instance already attached is untouched.
   */
  async updateNetwork(id: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateNetwork", `/network/networks/${encodeURIComponent(id)}`, update);
  }

  /** Changes a subnet's name. */
  async updateSubnet(id: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateSubnet", `/network/subnets/${encodeURIComponent(id)}`, update);
  }

  /**
   * Changes a security group's name or description. Its rules stay immutable:
   * a rule is created and deleted, never edited.
   */
  async updateSecurityGroup(id: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateSecurityGroup", `/network/security-groups/${encodeURIComponent(id)}`, update);
  }

  /** Changes a floating IP's description. The address itself cannot change. */
  async updateFloatingIP(id: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateFloatingIP", `/network/floating-ips/${encodeURIComponent(id)}`, update);
  }
}
