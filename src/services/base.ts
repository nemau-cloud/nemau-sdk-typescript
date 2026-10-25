import type { NemauClient } from "../client.ts";

/** Shared base for services: holds the client reference. */
export abstract class Service {
  protected readonly client: NemauClient;

  constructor(client: NemauClient) {
    this.client = client;
  }
}
