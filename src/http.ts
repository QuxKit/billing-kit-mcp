// The HTTP transport: the MCP SDK's Streamable HTTP over node:http, behind a
// bearer token.
//
// stdio is the default and stays it — a local host spawns the bin and talks
// over stdin/stdout. `--http :port` is for the other case: a hosted assistant
// or a shared team deployment that cannot spawn a process on this machine.
// Two rules make that safe enough to ship:
//
//   1. No token, no listener. HTTP is refused at startup unless
//      BILLING_KIT_MCP_TOKEN is set; there is no unauthenticated mode, not
//      even on loopback, because "just for now" listeners are the ones that
//      stay.
//   2. Every request carries `Authorization: Bearer <token>`, compared in
//      constant time (`timingSafeEqual` over equal-length buffers; a length
//      mismatch still runs a comparison so it costs the same). Anything else
//      is 401 with a WWW-Authenticate challenge and no body worth reading.
//
// Stateless: each request gets its own McpServer + transport pair (the SDK's
// documented stateless mode, `sessionIdGenerator: undefined`), so there is no
// session table to leak or to guess. The database pools are shared across
// requests — they are what is expensive; a McpServer is not.

import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface HttpOptions {
  /** e.g. ":3100" → all interfaces; "127.0.0.1:3100" → loopback only; "3100" is ":3100". */
  listen: string;
  /** BILLING_KIT_MCP_TOKEN. Required; an empty token refuses to start. */
  token: string | undefined;
  /** Builds the McpServer for one request. */
  serverFactory: () => McpServer;
  /** Only /mcp is served; anything else is 404. */
  path?: string;
  log?: (line: string) => void;
}

export interface HttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Parse the `--http` value. `:3100`, `3100`, `127.0.0.1:3100`, `[::1]:3100`. */
export function parseListen(value: string): { host: string | undefined; port: number } {
  const v = value.trim();
  // Bare digits ("3100") and ":3100" are port-only; otherwise host:port, with
  // [..] for an IPv6 host.
  const m = /^(?:(?:\[([^\]]+)\]|([^:]+)))?:(\d+)$/.exec(v);
  const portText = /^\d+$/.test(v) ? v : m?.[3];
  if (!portText) throw new Error(`--http expects :port or host:port, got "${value}"`);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--http port out of range: "${value}"`);
  const host = /^\d+$/.test(v) ? undefined : (m?.[1] ?? m?.[2]) || undefined;
  return { host, port };
}

/** Constant-time bearer check. `header` is the raw Authorization header value. */
export function checkBearer(header: string | undefined, token: string): boolean {
  const presented = header && /^Bearer\s+(.+)$/i.exec(header.trim())?.[1];
  const a = Buffer.from(presented ?? '', 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) {
    // Same cost as a real comparison, then false: the length must not leak through timing.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function startHttp(options: HttpOptions): Promise<HttpHandle> {
  const token = options.token?.trim();
  if (!token) {
    throw new Error(
      '--http needs BILLING_KIT_MCP_TOKEN: the HTTP transport never listens without a bearer token to check.',
    );
  }
  const path = options.path ?? '/mcp';
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { host, port } = parseListen(options.listen);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    if (!checkBearer(req.headers.authorization, token)) {
      log(`billing-kit-mcp: http 401 ${req.method} ${url.pathname} from ${req.socket.remoteAddress ?? '?'}`);
      res
        .writeHead(401, { 'www-authenticate': 'Bearer realm="billing-kit-mcp"', 'content-type': 'text/plain' })
        .end('unauthorized\n');
      return;
    }
    const server = options.serverFactory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`billing-kit-mcp: http error ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error\n');
    }
  };

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });
  const addr = httpServer.address() as AddressInfo;
  const shownHost = host ?? '0.0.0.0';
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${addr.port}${path}`;
  log(`billing-kit-mcp: listening on ${url} (Streamable HTTP, bearer auth)`);
  return {
    url,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        httpServer.closeAllConnections?.();
      }),
  };
}
