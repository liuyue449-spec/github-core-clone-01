// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4
// and MCP over a single in-memory store. Node built-ins only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { handleGraphQL } from './src/graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/githttp.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, parseQuery } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req_${requestCounter.toString(16)}_${randomBytes(4).toString('hex')}`;
}

/** The bearer token this process accepts: MAKEFUN_SHOP_TOKEN when set, else any non-empty token. */
function tokenIsValid(authorization: string | string[] | undefined): boolean {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return token === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function sendNoBody(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): Record<string, string> {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return parseQuery(url.search);
  } catch {
    return {};
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. Public.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const authorized = tokenIsValid(req.headers.authorization);

        // MCP: POST /mcp (JSON-RPC; parse errors are its own 400/-32700).
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = (await readBody(req)).toString('utf8');
          const reply = handleMcp(store, raw, authorized);
          if (reply.noBody) {
            sendNoBody(res, reply.status);
            return;
          }
          sendJson(res, reply.status, reply.body);
          return;
        }

        // GraphQL: POST /api/graphql.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = (await readBody(req)).toString('utf8');
          let parsed: unknown = null;
          if (raw.trim() !== '') {
            try {
              parsed = JSON.parse(raw);
            } catch {
              sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
              return;
            }
          }
          const reply = handleGraphQL(store, parsed);
          sendJson(res, reply.status, reply.body);
          return;
        }

        // REST v3: /api/v3/*
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          let parsed: unknown = undefined;
          if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
            const raw = (await readBody(req)).toString('utf8');
            if (raw.trim() !== '') {
              try {
                parsed = JSON.parse(raw);
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const host = req.headers.host ?? '127.0.0.1';
          const absoluteBase = `http://${host}`;
          const reply = handleRest(store, method, path, queryOf(req), parsed, absoluteBase);
          if (reply.noBody) {
            sendNoBody(res, reply.status);
            return;
          }
          sendJson(res, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/*
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const service = gitMatch[3]!;
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (service === 'info/refs' && method === 'GET') {
            const query = queryOf(req);
            const serviceName = query.service;
            if (serviceName !== 'git-upload-pack' && serviceName !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'Missing or invalid service parameter' });
              return;
            }
            const wantsV2 = req.headers['git-protocol'] === 'version=2';
            const reply = handleInfoRefs(store, owner, repoName, serviceName, wantsV2);
            if (reply.status !== 200) {
              sendJson(res, reply.status, { message: reply.body.toString('utf8') });
              return;
            }
            sendBuffer(res, 200, reply.contentType, reply.body);
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const reply = handleUploadPack(store, owner, repoName, body);
            if (reply.status !== 200) {
              sendJson(res, reply.status, { message: reply.body.toString('utf8') });
              return;
            }
            sendBuffer(res, 200, reply.contentType, reply.body);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const reply = handleReceivePack(store, owner, repoName, body);
            if (reply.status !== 200) {
              sendJson(res, reply.status, { message: reply.body.toString('utf8') });
              return;
            }
            sendBuffer(res, 200, reply.contentType, reply.body);
            return;
          }
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }

        // Everything else: GitHub's JSON 404.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
