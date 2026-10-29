/**
 * Evaluator-owned HTTP fixture servers.
 *
 * A case declares one or more fixture servers; the evaluator starts each on
 * 127.0.0.1, exposes its base URL through an env var, and records every request.
 * The subject keeps calling its normal client code — only the base URL changes —
 * so a business MCP that normally talks to a SaaS API can be graded offline
 * without editing the subject's source.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface HttpMockRoute {
  method?: string;
  path: string;
  status?: number;
  headers?: Record<string, string>;
  /** JSON value, or a raw string body. */
  body?: unknown;
}

export interface HttpMockServer {
  /** Environment variable that receives this server's base URL. */
  env: string;
  routes: HttpMockRoute[];
}

export interface HttpMockCall {
  method: string;
  path: string;
  body: string;
}

export interface RunningHttpMock {
  environment: Record<string, string>;
  calls: HttpMockCall[];
  stop: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => done(''));
  });
}

function reply(response: ServerResponse, route: HttpMockRoute): void {
  const headers = { 'content-type': 'application/json', ...(route.headers ?? {}) };
  response.writeHead(route.status ?? 200, headers);
  const body = route.body;
  response.end(typeof body === 'string' ? body : JSON.stringify(body ?? null));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ready());
  });
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

export async function startHttpMocks(specs: HttpMockServer[]): Promise<RunningHttpMock> {
  const environment: Record<string, string> = {};
  const calls: HttpMockCall[] = [];
  const servers: Server[] = [];
  const closeAll = async (): Promise<void> => {
    await Promise.all(
      servers.map((server) => new Promise<void>((done) => { server.close(() => done()); })),
    );
  };
  try {
    for (const spec of specs) {
    const server = createServer((request, response) => {
      void readBody(request).then((body) => {
        const method = (request.method ?? 'GET').toUpperCase();
        const path = request.url ?? '/';
        calls.push({ method, path, body });
        const route = spec.routes.find(
          (item) => (item.method ?? 'GET').toUpperCase() === method && item.path === path,
        );
        if (route === undefined) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'no_route', method, path }));
          return;
        }
        reply(response, route);
      });
    });
      const port = await listen(server);
      environment[spec.env] = `http://127.0.0.1:${port}`;
      servers.push(server);
    }
  } catch (error) {
    await closeAll();
    throw error;
  }
  return {
    environment,
    calls,
    stop: closeAll,
  };
}
