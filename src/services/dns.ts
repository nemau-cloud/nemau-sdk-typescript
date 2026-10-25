import { Service } from "./base.ts";
import { notFound } from "../errors.ts";
import type { DNSRecordSet, DNSZone, TaskRef } from "../types.ts";
import { patch, type ResourceUpdate } from "./update.ts";

/** `email` is the SOA contact. A zero `ttl` becomes 300 server-side. */
export interface CreateZoneRequest {
  name: string;
  email: string;
  description?: string;
  ttl?: number;
}

export interface CreateRecordSetRequest {
  name: string;
  type: string;
  records: string[];
  ttl?: number;
  description?: string;
}

export interface UpdateRecordSetRequest {
  records?: string[];
  ttl?: number;
  description?: string;
}

/** Zone statuses. A zone is created pending until its ownership is proven. */
export const DNS_ZONE_STATUS_PENDING_VERIFICATION = "PENDING_VERIFICATION";
export const DNS_ZONE_STATUS_ACTIVE = "ACTIVE";

/** 400: the name is under a domain the platform keeps (nemau-cloud.fr, nemau-cloud.com). */
export const REASON_DNS_ZONE_RESERVED = "dns_zone_reserved";
/** 409: the zone is already active on the platform, or already claimed in this project. */
export const REASON_DNS_ZONE_EXISTS = "dns_zone_exists";
/** 409: `verifyZone` on a zone that is already active. */
export const REASON_DNS_ZONE_ALREADY_VERIFIED = "dns_zone_already_verified";
/** 409: a record-set write on a zone whose ownership is not proven yet. */
export const REASON_DNS_ZONE_PENDING_VERIFICATION = "dns_zone_pending_verification";

/** /dns: authoritative zones and record sets. */
export class DNSService extends Service {
  async listZones(): Promise<DNSZone[]> {
    const out = await this.client.request<{ zones: DNSZone[] }>({ method: "GET", path: "/dns/zones" });
    return out.zones ?? [];
  }

  /** The API has no per-zone read: list and filter. */
  async getZone(id: string): Promise<DNSZone> {
    const found = (await this.listZones()).find((z) => z.id === id);
    if (!found) throw notFound("dns zone", id, "/dns/zones");
    return found;
  }

  /**
   * The zone comes back pending, with the TXT record that proves ownership of
   * the domain in `verification`; see `verifyZone`. A reserved name is refused
   * with `REASON_DNS_ZONE_RESERVED`, an existing one with `REASON_DNS_ZONE_EXISTS`.
   */
  async createZone(request: CreateZoneRequest): Promise<TaskRef> {
    return this.client.submit({ method: "POST", path: "/dns/zones", json: request });
  }

  /** Returns the created zone, still pending: publish its record, then `verifyZoneAndWait`. */
  async createZoneAndWait(request: CreateZoneRequest): Promise<DNSZone> {
    const ref = await this.createZone(request);
    const { id } = await this.client.waitForResourceId(ref, "zone_id");
    return this.getZone(id);
  }

  /**
   * Starts the ownership check of a pending zone: the platform looks up the TXT
   * record named in `verification` and activates the zone if it holds the
   * expected value.
   *
   * The task fails and the zone stays pending while the record is absent or
   * wrong. This includes the time the record takes to reach the domain's
   * nameservers, so a record published a moment ago may need another try. A
   * zone already active is refused with `REASON_DNS_ZONE_ALREADY_VERIFIED`.
   */
  async verifyZone(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "POST", path: `/dns/zones/${encodeURIComponent(id)}/verify` });
  }

  /**
   * Runs `verifyZone` to completion and returns the zone as it stands
   * afterwards. A record not found yet rejects with `NemauTaskFailedError`.
   */
  async verifyZoneAndWait(id: string, signal?: AbortSignal): Promise<DNSZone> {
    const ref = await this.verifyZone(id);
    await this.client.waitFor(ref, signal);
    return this.getZone(id);
  }

  async deleteZone(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: `/dns/zones/${encodeURIComponent(id)}` });
  }

  /** A zone pending verification has no record sets yet: the list is empty. */
  async listRecordSets(zoneId: string): Promise<DNSRecordSet[]> {
    const out = await this.client.request<{ recordsets: DNSRecordSet[] }>({
      method: "GET",
      path: `/dns/zones/${encodeURIComponent(zoneId)}/recordsets`,
    });
    return out.recordsets ?? [];
  }

  async getRecordSet(zoneId: string, id: string): Promise<DNSRecordSet> {
    const found = (await this.listRecordSets(zoneId)).find((r) => r.id === id);
    if (!found) throw notFound("dns record set", id, `/dns/zones/${zoneId}/recordsets`);
    return found;
  }

  /**
   * The zone must be active: on a zone still pending verification the API
   * refuses with `REASON_DNS_ZONE_PENDING_VERIFICATION`.
   */
  async createRecordSet(zoneId: string, request: CreateRecordSetRequest): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: `/dns/zones/${encodeURIComponent(zoneId)}/recordsets`,
      json: request,
    });
  }

  /**
   * A record-set id is "canonical.name./TYPE" and travels as `?id=`: its slash
   * does not fit in one decoded path segment.
   */
  async updateRecordSet(
    zoneId: string,
    recordSetId: string,
    request: UpdateRecordSetRequest,
  ): Promise<TaskRef> {
    return this.client.submit({
      method: "PUT",
      path: `/dns/zones/${encodeURIComponent(zoneId)}/recordsets`,
      query: { id: recordSetId },
      json: request,
    });
  }

  async deleteRecordSet(zoneId: string, recordSetId: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/dns/zones/${encodeURIComponent(zoneId)}/recordsets`,
      query: { id: recordSetId },
    });
  }

  /**
   * Changes a zone's description, SOA contact or default TTL. Its name is the
   * zone's identity and cannot change.
   */
  async updateZone(id: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateZone", `/dns/zones/${encodeURIComponent(id)}`, update);
  }
}
