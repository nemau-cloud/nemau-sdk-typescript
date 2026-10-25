import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NemauClient, type ClientOptions } from "../src/index.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Stub {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type Handler = (req: RecordedRequest, res: ServerResponse) => void;

/** Starts a test server and returns its URL along with the requests it saw. */
export async function startStub(handler: Handler): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Short JSON response. */
export function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** Client aimed at the stub, with retries and polling sped up. */
export function clientFor(stub: Stub, options: Partial<ClientOptions> = {}): NemauClient {
  return new NemauClient({
    baseUrl: stub.url,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    pollIntervalMs: 1,
    ...options,
  });
}
