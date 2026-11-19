// app.ts — the forge's HTTP surface: git smart-HTTP (/info/refs, /git-upload-pack,
// /git-receive-pack), REST v3 (/api/v3/...), GraphQL (/api/graphql), MCP (/mcp), and the health
// probe. Every JSON answer carries a non-empty X-GitHub-Request-Id; unknown routes answer
// GitHub's JSON 404; unparseable bodies answer 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { OWNER_LOGIN, findRepo, viewerContext, type Repo } from './store.ts';
import { handleReceivePack, handleUploadPack, receivePackAdvertisement, uploadPackAdvertisement } from './gitsrv.ts';
import { handleRest } from './rest.ts';
import { runGraphQLBody } from './gql.ts';
import { handleMcpRequest } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The body any single request may carry: 32 MiB (packs are the largest things pushed around). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

let requestCounter = 0;

/** A unique, non-empty request id for one HTTP exchange. */
function requestId(): string {
  requestCounter += 1;
  return `${requestCounter.toString(16)}-${Date.now().toString(16)}`;
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
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

/** Stream one raw byte answer (git protocol and anything else non-JSON). */
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const mark = url.indexOf('?');
  return mark < 0 ? url : url.slice(0, mark);
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const mark = url.indexOf('?');
  if (mark < 0) return new URLSearchParams();
  try {
    return new URLSearchParams(url.slice(mark + 1));
  } catch {
    return new URLSearchParams();
  }
}

/** The Bearer token's login, or null without one. Locally any token maps to the owner. */
function loginOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token === '' ? null : OWNER_LOGIN;
}

/** Read the whole request body, bounded. Empty when the request declares no body. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
  if (!hasBody) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Rewrite relative Link targets into absolute ones on the entry's own origin. */
function absoluteLinks(req: IncomingMessage, headers: Record<string, string>): Record<string, string> {
  const link = headers.link;
  if (link === undefined) return headers;
  const host = req.headers.host ?? '127.0.0.1';
  const origin = `http://${host}`;
  return { ...headers, link: link.replace(/<\//g, `<${origin}/`) };
}

/** `<owner>/<repo>.git` or `<owner>/<repo>` out of a path prefix; null when it does not match. */
/** Strip the git-HTTP suffix so only `/<owner>/<repo>[.git]` remains. */
function repoFromPath(path: string): Repo | null {
  for (const suffix of ['/info/refs', '/git-upload-pack', '/git-receive-pack']) {
    if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  }
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(path);
  if (!match) return null;
  return findRepo(match[1]!, match[2]!) ?? null;
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req, res) => {
    void answer(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = (req.method ?? 'GET').toUpperCase();

  // The env's boot probe (unauthenticated, before any store exists).
  if (path === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const login = loginOf(req);

  // The API root: as api.github.com answers GET /.
  if ((path === '/' || path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/user — the token's identity.
  if (path === '/api/v3/user' && method === 'GET') {
    if (login === null) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    sendJson(res, 200, { login, id: 1001, name: 'Adai Iversen', type: 'User' });
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/info/refs?service=..., /git-upload-pack, /git-receive-pack.
  if (path.endsWith('/info/refs') || path.endsWith('/git-upload-pack') || path.endsWith('/git-receive-pack')) {
    const gitMatch = repoFromPath(path);
    if (!gitMatch) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    await answerGit(req, res, method, path, gitMatch);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (login === null) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const { status, json } = runGraphQLBody(parsed.value, viewerContext());
    sendJson(res, status, json);
    return;
  }

  // MCP: JSON-RPC over POST /mcp (and DELETE to drop a session, which this server never hands out).
  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    const { status, body } = handleMcpRequest(raw.toString('utf8'), login !== null, viewerContext());
    sendJson(res, status, body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
    const raw = await readBody(req);
    let body: unknown = null;
    if (raw.length > 0) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      body = parsed.value;
    }
    const answer = handleRest(method, restPath, queryOf(req), body, raw.length === 0 ? '' : raw.toString('utf8'), login !== null);
    sendJson(res, answer.status, answer.json, absoluteLinks(req, answer.headers ?? {}));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** One git smart-HTTP exchange: the advertisement, upload-pack or receive-pack. */
async function answerGit(req: IncomingMessage, res: ServerResponse, method: string, path: string, repo: Repo): Promise<void> {
  if (path.endsWith('/info/refs')) {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const service = queryOf(req).get('service') ?? '';
    if (service === 'git-upload-pack') {
      // Protocol version negotiation rides the Git-Protocol header.
      sendRaw(res, 200, uploadPackAdvertisement(repo, (req.headers['git-protocol'] ?? '').includes('version=2')), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
      return;
    }
    // Dumb HTTP fallback: the plain ref advertisement.
    sendRaw(res, 200, receivePackAdvertisement(repo), 'application/x-git-advertisement');
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = await readBody(req);
  const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (path.endsWith('/git-upload-pack')) {
    sendRaw(res, 200, handleUploadPack(repo, raw, v2), 'application/x-git-upload-pack-result');
    return;
  }
  sendRaw(res, 200, handleReceivePack(repo, raw), 'application/x-git-receive-pack-result');
}
