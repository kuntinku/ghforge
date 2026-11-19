// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over POST /mcp, speaking both the
// 2026-07-28 revision (server/discover, no handshake, no session) and the legacy handshake
// (initialize + notifications/initialized). Six forge tools over the shared store.

import { OWNER_LOGIN, findRepo, type Repo } from './store.ts';
import { createIssue, createPull, createRepository, issueJson, mergePull, pullJson, repoJson } from './rest.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_NAME = 'ghforge-mcp';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------- tool definitions

interface ToolSpec {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, unknown>;
}

const OWNER_PROP = { type: 'string', description: 'The repository owner login' };
const REPO_PROP = { type: 'string', description: 'The repository name' };

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    required: ['repo'],
    properties: {
      owner: { ...OWNER_PROP, description: 'The owner login (defaults to the authenticated user)' },
      repo: { type: 'string', description: 'The new repository name' },
      description: { type: 'string', description: 'The repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
      auto_init: { type: 'boolean', description: 'Create an initial commit with README' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    required: ['owner', 'repo'],
    properties: { owner: OWNER_PROP, repo: REPO_PROP },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, newest first.',
    required: ['owner', 'repo'],
    properties: {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      state: { type: 'string', description: 'Filter: open, closed or all' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a pushed head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      title: { type: 'string', description: 'The pull request title' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
      body: { type: 'string', description: 'The pull request body' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request (fast-forward) into its base branch.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      pull_number: { type: 'number', description: 'The pull request number' },
    },
  },
];

function toolJson(spec: ToolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    title: spec.name,
    description: spec.description,
    inputSchema: { type: 'object', properties: spec.properties, required: spec.required },
  };
}

const TOOL_LIST_RESULT: Record<string, unknown> = Object.freeze({
  tools: TOOL_SPECS.map(toolJson),
}) as unknown as Record<string, unknown>;

// ---------------------------------------------------------------- JSON-RPC plumbing

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function errorBody(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function resultBody(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function repoByOwner(repo: Repo, owner: unknown, name: unknown): Repo | null {
  const ownerText = typeof owner === 'string' ? owner : '';
  const nameText = typeof name === 'string' ? name : '';
  if (ownerText.toLowerCase() !== repo.owner.toLowerCase()) return null;
  return findRepo(ownerText, nameText);
}

function numberArg(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Run one tool by name; answers the tool result or an RPC error object. */
function runTool(repo: Repo, name: unknown, args: Record<string, unknown>): { result: Record<string, unknown> | null; error: RpcError | null } {
  const spec = TOOL_SPECS.find((entry) => entry.name === name);
  if (!spec) return { result: null, error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(name)}` } };
  for (const key of spec.required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      return { result: null, error: { code: INVALID_PARAMS, message: `Missing required argument: ${key}` } };
    }
  }
  let payload: unknown;
  const restStatus = (answer: { status: number; json: unknown }): unknown => answer.json;
  const ownerOk = (): Repo | null => repoByOwner(repo, args.owner ?? OWNER_LOGIN, args.repo ?? args.name);
  switch (spec.name) {
    case 'create_repo': {
      const nameText = String(args.repo ?? args.name ?? '');
      const answer = createRepository({
        name: nameText,
        description: typeof args.description === 'string' ? args.description : null,
        private: args.private === true,
        auto_init: args.auto_init === true,
      });
      if (answer.status >= 400) return { result: null, error: { code: INVALID_PARAMS, message: String((answer.json as Record<string, unknown>).message ?? 'the repository could not be created') } };
      payload = restStatus(answer);
      break;
    }
    case 'get_repo': {
      const found = ownerOk();
      if (!found) return { result: null, error: { code: INVALID_PARAMS, message: 'the repository was not found' } };
      payload = repoJson(found);
      break;
    }
    case 'create_issue': {
      const found = ownerOk();
      if (!found) return { result: null, error: { code: INVALID_PARAMS, message: 'the repository was not found' } };
      const answer = createIssue(found, { title: String(args.title), body: typeof args.body === 'string' ? args.body : null });
      if (answer.status >= 400) return { result: null, error: { code: INVALID_PARAMS, message: 'the issue could not be created' } };
      payload = restStatus(answer);
      break;
    }
    case 'list_issues': {
      const found = ownerOk();
      if (!found) return { result: null, error: { code: INVALID_PARAMS, message: 'the repository was not found' } };
      const state = typeof args.state === 'string' ? args.state : 'all';
      const items = [...found.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state, created_at: issue.createdAt.toISOString() }));
      payload = { total_count: items.length, issues: items };
      break;
    }
    case 'create_pull_request': {
      const found = ownerOk();
      if (!found) return { result: null, error: { code: INVALID_PARAMS, message: 'the repository was not found' } };
      const answer = createPull(found, { title: String(args.title), body: typeof args.body === 'string' ? args.body : null, head: String(args.head), base: String(args.base) });
      if (answer.status >= 400) return { result: null, error: { code: INVALID_PARAMS, message: String((answer.json as Record<string, unknown>).message ?? 'the pull request could not be created') } };
      payload = restStatus(answer);
      break;
    }
    case 'merge_pull_request': {
      const found = ownerOk();
      if (!found) return { result: null, error: { code: INVALID_PARAMS, message: 'the repository was not found' } };
      const number = numberArg(args.pull_number ?? args.number);
      if (number === null) return { result: null, error: { code: INVALID_PARAMS, message: 'pull_number must be a number' } };
      const pull = found.pulls.get(number);
      if (!pull) return { result: null, error: { code: INVALID_PARAMS, message: 'the pull request was not found' } };
      const answer = mergePull(found, pull, { merge_method: 'squash' });
      if (answer.status >= 400) return { result: null, error: { code: INVALID_PARAMS, message: String((answer.json as Record<string, unknown>).message ?? 'the pull request cannot be merged') } };
      payload = { number: pull.number, merged: true, merge_commit_sha: pull.mergeCommitSha, ...(answer.json as Record<string, unknown>) };
      break;
    }
    default:
      return { result: null, error: { code: METHOD_NOT_FOUND, message: `Unknown tool: ${String(name)}` } };
  }
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    },
    error: null,
  };
}

/**
 * Handle one POST /mcp body. `authed` says an Authorization header was present.
 * Answers { status, body } — body already JSON-shaped.
 */
export function handleMcpRequest(bodyText: string, authed: boolean, store: Repo): { status: number; body: Record<string, unknown> | Array<Record<string, unknown>> } {
  if (!authed) return { status: 401, body: { message: 'Requires authentication' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: errorBody(null, PARSE_ERROR, 'Parse error') };
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const answers: Array<Record<string, unknown> | null> = [];
  for (const entry of entries) {
    answers.push(dispatchRpc(store, entry));
  }
  const real = answers.filter((entry): entry is Record<string, unknown> => entry !== null);
  if (real.length === 0) return { status: 202, body: {} };
  return { status: 200, body: Array.isArray(parsed) ? real : real[0]! };
}

function dispatchRpc(repo: Repo, entry: unknown): Record<string, unknown> | null {
  if (typeof entry !== 'object' || entry === null) return errorBody(null, INVALID_REQUEST, 'Invalid Request');
  const request = entry as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params) ? (request.params as Record<string, unknown>) : {};
  const isNotification = request.id === undefined;
  switch (method) {
    case 'server/discover':
      return resultBody(id, {
        protocolVersion: MCP_REVISION,
        supportedVersions: [MCP_REVISION, ...MCP_LEGACY_REVISIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Forge tools over the shared store: repositories, issues, pull requests.',
      });
    case 'initialize':
      return resultBody(id, {
        protocolVersion: typeof params.protocolVersion === 'string' && MCP_LEGACY_REVISIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_REVISION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return resultBody(id, {});
    case 'tools/list':
      // A frozen, stable object: two answers serialize to identical bytes.
      return resultBody(id, TOOL_LIST_RESULT as unknown as Record<string, unknown>);
    case 'tools/call': {
      const name = params.name;
      const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const run = runTool(repo, name, args);
      if (run.error) return errorBody(id, run.error.code, run.error.message);
      return resultBody(id, run.result!);
    }
    default:
      if (isNotification) return null;
      if (method.startsWith('notifications/')) return null;
      return errorBody(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export { OWNER_LOGIN };
