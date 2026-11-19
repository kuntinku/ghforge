// rest.ts — the REST v3 surface (/api/v3): repositories, branches, commits, contents, git refs,
// labels, issues, comments, pulls, files and merge. Pure request-in / answer-out; server.ts sends.

import { buildCommit, oidOf, parseCommit } from './gitobj.ts';
import {
  DEFAULT_BRANCH,
  commitBlob,
  commitChain,
  createRepo,
  deleteRepo,
  findRepo,
  getObject,
  isoStamp,
  listDir,
  lookupPath,
  makeComment,
  makeLabel,
  nextIssueNumber,
  OWNER_ID,
  OWNER_LOGIN,
  OWNER_NAME,
  SERVER_VERSION,
  setPathInTree,
  allRepos,
  commentsOf,
  type Issue,
  type IssueOrPull,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

const OWNER_EMAIL = `${OWNER_LOGIN}@example.invalid`;

export interface RestAnswer {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestAnswer {
  return { status, json, headers };
}

function fail(status: number, message: string): RestAnswer {
  return { status, json: { message, ...(status === 422 ? { errors: [{ resource: 'Issue', field: 'data', code: 'invalid' }] } : {}) } };
}

function notFound(): RestAnswer {
  return fail(404, 'Not Found');
}

function unauthorized(): RestAnswer {
  return fail(401, 'Requires authentication');
}

// ---------------------------------------------------------------- shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: userJson(),
    html_url: `https://forge.invalid/${fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${fullName}`,
    created_at: isoStamp(repo.createdAt),
    updated_at: isoStamp(repo.updatedAt),
    pushed_at: isoStamp(repo.updatedAt),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    size: repo.objects.size,
    language: null,
    is_private: repo.private,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    topics: [],
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

const USER_JSON: Record<string, unknown> = Object.freeze({
    login: OWNER_LOGIN,
    id: OWNER_ID,
    node_id: Buffer.from(`User:${OWNER_ID}`).toString('base64'),
    name: OWNER_NAME,
    email: `${OWNER_LOGIN}@example.invalid`,
    type: 'User',
    site_admin: false,
    url: `/api/v3/users/${OWNER_LOGIN}`,
    html_url: `https://forge.invalid/${OWNER_LOGIN}`,
  });

export function userJson(): Record<string, unknown> {
  return USER_JSON;
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? makeLabel(repo, name, 'ededed', null))),
    user: userJson(),
    comments: commentsOf(repo, issue.number).length,
    created_at: isoStamp(issue.createdAt),
    updated_at: isoStamp(issue.updatedAt),
    closed_at: issue.closedAt ? isoStamp(issue.closedAt) : null,
    author_association: 'OWNER',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: '',
    events_url: '',
    labels_url: '',
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    locked: false,
    active_lock_reason: null,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
  const branch = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    user: userJson(),
    head: branch(pull.head, headSha),
    base: branch(pull.base, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt ? isoStamp(pull.mergedAt) : null,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedAt ? isoStamp(pull.closedAt) : null,
    created_at: isoStamp(pull.createdAt),
    updated_at: isoStamp(pull.updatedAt),
    author_association: 'OWNER',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: '',
    diff_url: '',
    patch_url: '',
    commits_url: '',
    files_url: '',
    review_comments_url: '',
    issue_url: '',
    statuses_url: '',
    mergeable: null,
    merged_by: pull.merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    merge_commit_sha_url: '',
  };
}

function commentJson(repo: Repo, comment: { id: number; issueNumber: number; body: string; user: string; createdAt: Date; updatedAt: Date }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(),
    created_at: isoStamp(comment.createdAt),
    updated_at: isoStamp(comment.updatedAt),
    author_association: 'OWNER',
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}`,
    html_url: '',
    url: '',
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], check_runs: [] } },
    protection_url: '',
  };
}

function commitJson(repo: Repo, oid: string, commit: ReturnType<typeof parseCommit>): Record<string, unknown> {
  const stamp = (line: string): Record<string, unknown> | null => {
    const match = /^(.*) (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return null;
    return { name: match[1].split(' <')[0] ?? '', email: OWNER_EMAIL, date: new Date(Number(match[2]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
    commit: {
      message: commit.message,
      author: stamp(commit.author) ?? { name: OWNER_NAME, email: OWNER_EMAIL, date: new Date().toISOString() },
      committer: stamp(commit.committer) ?? { name: OWNER_NAME, email: OWNER_EMAIL, date: new Date().toISOString() },
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    parents: commit.parents.map((oid2) => ({ sha: oid2, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------- pull files (tree diff)

interface FileDiff {
  path: string;
  sha: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

function flattenTree(repo: Repo, treeOid: string | undefined, prefix: string, into: Map<string, string>): void {
  if (!treeOid) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.kind !== 'tree') return;
  for (const item of listDir(repo, treeOid, '')) {
    const path = prefix === '' ? item.name : `${prefix}/${item.name}`;
    if (item.mode === '40000') flattenTree(repo, item.oid, path, into);
    else into.set(path, item.oid);
  }
}

function lineSet(bytes: Buffer): Set<string> {
  return new Set(bytes.toString('utf8').split('\n'));
}

function diffTrees(repo: Repo, baseTree: string | undefined, headTree: string | undefined): FileDiff[] {
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  flattenTree(repo, baseTree, '', baseFiles);
  flattenTree(repo, headTree, '', headFiles);
  const out: FileDiff[] = [];
  for (const [path, headOid] of headFiles) {
    const baseOid = baseFiles.get(path);
    if (!baseOid) {
      const bytes = repo.objects.get(headOid)?.bytes ?? Buffer.alloc(0);
      const lines = bytes.toString('utf8').split('\n').filter((line) => line !== '').length;
      out.push({ path, sha: headOid, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
      continue;
    }
    if (baseOid === headOid) continue;
    const oldBytes = repo.objects.get(baseOid)?.bytes ?? Buffer.alloc(0);
    const newBytes = repo.objects.get(headOid)?.bytes ?? Buffer.alloc(0);
    const oldLines = lineSet(oldBytes);
    const newLines = lineSet(newBytes);
    let additions = 0;
    for (const line of newLines) if (!oldLines.has(line)) additions += 1;
    let deletions = 0;
    for (const line of oldLines) if (!newLines.has(line)) deletions += 1;
    if (additions === 0) additions = 1;
    if (deletions === 0) deletions = 1;
    out.push({ path, sha: headOid, status: 'modified', additions, deletions, changes: additions + deletions });
  }
  for (const [path, baseOid] of baseFiles) {
    if (headFiles.has(path)) continue;
    const bytes = repo.objects.get(baseOid)?.bytes ?? Buffer.alloc(0);
    const deletions = bytes.toString('utf8').split('\n').filter((line) => line !== '').length;
    out.push({ path, sha: baseOid, status: 'removed', additions: 0, deletions: Math.max(1, deletions), changes: Math.max(1, deletions) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function fileJson(repo: Repo, file: FileDiff): Record<string, unknown> {
  return {
    sha: file.sha,
    filename: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
  };
}

// ---------------------------------------------------------------- helpers

function refHead(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

// ---------------------------------------------------------------- the dispatcher

export function handleRest(
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  rawBody: string,
  authenticated: boolean,
): RestAnswer {
  const segments = path.split('/').filter((s) => s !== '');
  const at = (index: number): string => decodeURIComponent(segments[index] ?? '');
  const from = (index: number): string => segments.slice(index).map(decodeURIComponent).join('/');

  // JSON body validation: an application/json body that does not parse is a 400.
  if (rawBody !== '' && method !== 'GET' && method !== 'DELETE') {
    if (body === undefined) return fail(400, 'Problems parsing JSON');
  } else if (rawBody !== '' && (method === 'GET' || method === 'DELETE') && body === undefined && rawBody.trim().startsWith('{')) {
    return fail(400, 'Problems parsing JSON');
  }
  const input = (body ?? {}) as Record<string, unknown>;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues{/number}',
      pull_request_url: '/api/v3/repos/{owner}/{repo}/pulls{/number}',
      meta_url: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (!authenticated) return unauthorized();

  const first = at(0);
  if (first === 'meta') {
    return ok(200, { installed_version: SERVER_VERSION, verifiable_password_authentication: false });
  }
  if (first === 'user') {
    if (at(1) === 'repos') {
      if (method === 'POST') return createRepository(input);
      if (method === 'GET') return listRepositories(query);
      return notFound();
    }
    if (method === 'GET') return ok(200, userJson());
    return notFound();
  }
  if (first === 'repos' && segments.length >= 3) {
    const owner = at(1);
    const name = at(2);
    const repo = findRepo(owner, name);
    if (!repo) return notFound();
    return dispatchRepo(method, repo, segments.slice(3), query, input);
  }
  if (first === 'users' && segments.length >= 2) {
    if (at(1) === OWNER_LOGIN && method === 'GET') return ok(200, userJson());
    return notFound();
  }
  if (first === 'zen' && method === 'GET') {
    return { status: 200, json: 'Keep the forge simple.' };
  }
  return notFound();
}

export function createRepository(input: Record<string, unknown>): RestAnswer {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
    return fail(422, 'Validation Failed: name is invalid');
  }
  if (findRepo(OWNER_LOGIN, name)) {
    return fail(422, `name already exists on this account`);
  }
  const repo = createRepo(name, {
    description: typeof input.description === 'string' ? input.description : null,
    private: input.private === true,
  });
  return ok(201, repoJson(repo));
}

function listRepositories(query: URLSearchParams): RestAnswer {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const repos = allRepos().slice().sort((a, b) => b.id - a.id);
  const start = (page - 1) * perPage;
  const pageItems = repos.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(repos.length / perPage));
  const base = `/api/v3/user/repos`;
  const link = (targetPage: number, rel: string): string => `<${base}?per_page=${perPage}&page=${targetPage}>; rel="${rel}"`;
  const links: string[] = [];
  if (page > 1) links.push(link(page - 1, 'prev'));
  if (page < lastPage) links.push(link(page + 1, 'next'));
  if (lastPage > 1) {
    links.push(link(1, 'first'));
    links.push(link(lastPage, 'last'));
  }
  const headers: Record<string, string> = links.length > 0 ? { link: links.join(', ') } : {};
  return ok(200, pageItems.map(repoJson), headers);
}

function dispatchRepo(
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  input: Record<string, unknown>,
): RestAnswer {
  const at = (index: number): string => decodeURIComponent(rest[index] ?? '');
  const from = (index: number): string => rest.slice(index).map(decodeURIComponent).join('/');
  const sub = at(0);

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.name === 'string' && input.name !== repo.name) {
        return fail(422, 'Validation Failed: renaming is not supported');
      }
      if (typeof input.private === 'boolean') repo.private = input.private;
      repo.updatedAt = new Date();
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  if (sub === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
      return ok(200, branches.map((name) => branchJson(repo, name.slice('refs/heads/'.length), repo.refs.get(name)!)));
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = refHead(repo, at(1));
      return sha ? ok(200, branchJson(repo, at(1), sha)) : notFound();
    }
    return notFound();
  }

  if (sub === 'commits' && method === 'GET') {
    const branch = query.get('sha') ?? repo.defaultBranch;
    const tip = refHead(repo, branch) ?? repo.refs.get(branch);
    if (!tip) return notFound();
    const path = query.get('path');
    const chain = commitChain(repo, tip);
    const filtered = path
      ? chain.filter(({ commit }) => lookupPath(repo, commit.tree, path) !== undefined)
      : chain;
    return ok(200, filtered.map(({ oid, commit }) => commitJson(repo, oid, commit)));
  }

  if (sub === 'git' && at(1) === 'refs') {
    if (rest.length === 2 && method === 'GET') {
      const refs = [...repo.refs.keys()].sort().map((name) => ({
        ref: name,
        node_id: Buffer.from(`Ref:${repo.id}:${name}`).toString('base64'),
        url: '',
        object: { sha: repo.refs.get(name), type: objectTypeOf(repo, repo.refs.get(name)!), url: '' },
      }));
      return ok(200, refs);
    }
    if (rest.length === 2 && method === 'POST') {
      const refName = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!refName.startsWith('refs/')) return fail(422, 'Validation Failed: ref must start with refs/');
      if (!repo.objects.has(sha)) return fail(422, 'Validation Failed: object does not exist');
      if (repo.refs.has(refName)) return fail(422, 'Reference already exists');
      repo.refs.set(refName, sha);
      repo.packCache.clear();
      return ok(201, {
        ref: refName,
        node_id: Buffer.from(`Ref:${repo.id}:${refName}`).toString('base64'),
        url: '',
        object: { sha, type: objectTypeOf(repo, sha), url: '' },
      });
    }
    if (rest.length >= 3 && method === 'GET') {
      const refName = `refs/${from(2)}`;
      const sha = repo.refs.get(refName);
      if (!sha) return notFound();
      return ok(200, {
        ref: refName,
        node_id: Buffer.from(`Ref:${repo.id}:${refName}`).toString('base64'),
        url: '',
        object: { sha, type: objectTypeOf(repo, sha), url: '' },
      });
    }
    return notFound();
  }

  if (sub === 'contents') {
    const filePath = from(1).replace(/\/+$/, '');
    if (method === 'GET') return readContents(repo, filePath, query.get('ref') ?? undefined);
    if (method === 'PUT') return putContents(repo, filePath, withQueryBranch(input, query));
    if (method === 'DELETE') return deleteContents(repo, filePath, withQueryBranch(input, query));
    return notFound();
  }

  if (sub === 'labels') {
    if (rest.length === 1 && method === 'GET') return ok(200, [...repo.labels.values()].map(labelJson));
    if (rest.length === 1 && method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return fail(422, 'Validation Failed: label name is required');
      const existing = repo.labels.get(name);
      if (existing) return fail(422, 'Label already exists');
      const label = makeLabel(repo, name, typeof input.color === 'string' ? input.color : 'ededed', typeof input.description === 'string' ? input.description : null);
      return ok(201, labelJson(label));
    }
    if (rest.length === 2 && method === 'GET') {
      const label = repo.labels.get(at(1));
      return label ? ok(200, labelJson(label)) : notFound();
    }
    return notFound();
  }

  if (sub === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(repo, query);
      if (method === 'POST') return createIssue(repo, input);
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(at(1), 10);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 2) {
        if (!issue) return notFound();
        if (method === 'GET') return ok(200, issueJson(repo, issue));
        if (method === 'PATCH') return patchIssue(repo, issue, input);
        return notFound();
      }
      if (rest.length === 3 && at(2) === 'comments') {
        if (!issue) return notFound();
        if (method === 'GET') {
          return ok(200, commentsOf(repo, issue.number).map((comment) => commentJson(repo, comment)));
        }
        if (method === 'POST') {
          const body = typeof input.body === 'string' ? input.body : '';
          if (body === '') return fail(422, 'Validation Failed: body is required');
          return ok(201, commentJson(repo, makeComment(repo, issue.number, body)));
        }
      }
    }
    return notFound();
  }

  if (sub === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(repo, query);
      if (method === 'POST') return createPull(repo, input);
      return notFound();
    }
    const number = Number.parseInt(at(1), 10);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (!pull) return notFound();
    if (rest.length === 2 && method === 'GET') return ok(200, pullJson(repo, pull));
    if (rest.length === 3 && at(2) === 'files' && method === 'GET') {
      return ok(200, pullFiles(repo, pull).map((file) => fileJson(repo, file)));
    }
    if (rest.length === 3 && at(2) === 'merge' && method === 'PUT') return mergePull(repo, pull, input);
    if (rest.length === 3 && at(2) === 'commits' && method === 'GET') {
      const headSha = refHead(repo, pull.head);
      const chain = headSha ? commitChain(repo, headSha) : [];
      return ok(200, chain.map(({ oid, commit }) => commitJson(repo, oid, commit)));
    }
    return notFound();
  }

  return notFound();
}

function objectTypeOf(repo: Repo, oid: string): string {
  return repo.objects.get(oid)?.kind ?? 'commit';
}

// ---------------------------------------------------------------- contents

function contentFileJson(repo: Repo, path: string, oid: string, includeContent: boolean): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const bytes = obj?.bytes ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  const entry: Record<string, unknown> = {
    name,
    path,
    sha: oid,
    size: bytes.length,
    type: 'file',
    url: '',
    git_url: '',
    html_url: '',
    download_url: '',
    encoding: 'base64',
    _links: {},
  };
  if (includeContent) entry.content = bytes.toString('base64');
  return entry;
}

function readContents(repo: Repo, filePath: string, ref: string | undefined): RestAnswer {
  const branch = ref ?? repo.defaultBranch;
  const tip = refHead(repo, branch) ?? (branch === '' ? refHead(repo, repo.defaultBranch) : undefined);
  if (tip === undefined || tip === null) return notFound();
  const tree = parseCommit(repo.objects.get(tip)!.bytes).tree;
  if (filePath === '' || filePath === '.') {
    const entries = listDir(repo, tree, '');
    return ok(200, entries.map((item) => entryJson(repo, filePath === '' || filePath === '.' ? item.name : `${filePath}/${item.name}`, item)));
  }
  const found = lookupPath(repo, tree, filePath);
  if (!found) return notFound();
  if (found.mode === '40000') {
    const entries = listDir(repo, tree, filePath);
    return ok(200, entries.map((item) => entryJson(repo, `${filePath}/${item.name}`, item)));
  }
  return ok(200, contentFileJson(repo, filePath, found.oid, true));
}

function entryJson(repo: Repo, path: string, item: { mode: string; name: string; oid: string }): Record<string, unknown> {
  if (item.mode === '40000') {
    return {
      name: item.name,
      path,
      sha: item.oid,
      size: 0,
      type: 'dir',
      url: '',
      git_url: '',
      html_url: '',
      _links: {},
    };
  }
  return contentFileJson(repo, path, item.oid, false);
}

/** Let `?branch=` ride in the query string as well as in the body. */
function withQueryBranch(input: Record<string, unknown>, query: URLSearchParams): Record<string, unknown> {
  const branch = query.get('branch');
  if (branch !== null && input.branch === undefined) return { ...input, branch };
  return input;
}

function putContents(repo: Repo, filePath: string, input: Record<string, unknown>): RestAnswer {
  const message = typeof input.message === 'string' ? input.message : '';
  const contentB64 = typeof input.content === 'string' ? input.content : '';
  if (message === '' || contentB64 === '') return fail(422, 'Validation Failed: message and content are required');
  let blob: Buffer;
  try {
    blob = Buffer.from(contentB64, 'base64');
  } catch {
    return fail(422, 'Validation Failed: content is not valid base64');
  }
  const branchName = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const headName = `refs/heads/${branchName}`;
  const existingTip = repo.refs.get(headName) ?? null;
  const pathExists = existingTip !== null && lookupPath(repo, parseCommit(repo.objects.get(existingTip)!.bytes)?.tree, filePath) !== undefined;
  if (pathExists) {
    const wantedSha = input.sha;
    const currentOid = lookupPath(repo, parseCommit(repo.objects.get(existingTip!)!.bytes).tree, filePath)!.oid;
    if (typeof wantedSha !== 'string' || wantedSha === '') {
      return fail(422, `sha wasn't supplied`);
    }
    if (wantedSha !== currentOid) {
      return fail(409, `${filePath} does not match ${wantedSha}`);
    }
  }
  const result = commitBlob(repo, filePath, blob, message, branchName);
  const tip = repo.refs.get(headName)!;
  return ok(201, {
    content: contentFileJson(repo, filePath, result.blobSha, false),
    commit: {
      sha: result.commitSha,
      node_id: Buffer.from(`Commit:${result.commitSha}`).toString('base64'),
      url: '',
      html_url: '',
      author: { name: OWNER_NAME, email: `${OWNER_LOGIN}@example.invalid`, date: isoStamp(new Date()) },
      committer: { name: OWNER_NAME, email: `${OWNER_LOGIN}@example.invalid`, date: isoStamp(new Date()) },
      message,
      tree: { sha: parseCommit(repo.objects.get(tip)!.bytes).tree, url: '' },
      parents: parseCommit(repo.objects.get(tip)!.bytes).parents.map((sha) => ({ sha, url: '', html_url: '' })),
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
  });
}

function deleteContents(repo: Repo, filePath: string, input: Record<string, unknown>): RestAnswer {
  const message = typeof input.message === 'string' ? input.message : 'delete';
  const branchName = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const headName = `refs/heads/${branchName}`;
  const tip = repo.refs.get(headName);
  if (!tip) return notFound();
  const tree = parseCommit(repo.objects.get(tip)!.bytes).tree;
  const found = lookupPath(repo, tree, filePath);
  if (!found || found.mode === '40000') return notFound();
  if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== found.oid) {
    return fail(409, `${filePath} does not match ${String(input.sha)}`);
  }
  const newTree = setPathInTree(repo, tree, filePath, null);
  const commit = buildCommit({ tree: newTree, parents: [tip], message, timestamp: Math.floor(Date.now() / 1000) });
  const commitSha = oidOf('commit', commit);
  repo.objects.set(commitSha, { kind: 'commit', bytes: commit });
  repo.refs.set(headName, commitSha);
  repo.packCache.clear();
  return ok(200, { commit: { sha: commitSha, node_id: Buffer.from(`Commit:${commitSha}`).toString('base64'), url: '', html_url: '' }, content: null });
}

// ---------------------------------------------------------------- issues and pulls

function normalizeLabels(input: Record<string, unknown>): string[] {
  const value = input.labels;
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
      names.push((entry as Record<string, unknown>).name as string);
    }
  }
  return names;
}

export function createIssue(repo: Repo, input: Record<string, unknown>): RestAnswer {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') return fail(422, 'Validation Failed: title is required');
  const wantedLabels = normalizeLabels(input);
  for (const name of wantedLabels) {
    if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
  }
  const now = new Date();
  const number = nextIssueNumber(repo);
  const issue: Issue = {
    id: 1_000_000 + number * 10,
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: wantedLabels,
    user: OWNER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    isPull: false,
  };
  repo.issues.set(number, issue);
  return ok(201, issueJson(repo, issue));
}

function listIssues(repo: Repo, query: URLSearchParams): RestAnswer {
  const state = query.get('state') ?? 'open';
  const direction = (query.get('direction') ?? 'desc') === 'asc' ? 'asc' : 'desc';
  const issues = [...repo.issues.values()].filter((issue) => {
    if (state !== 'all' && issue.state !== state) return false;
    return true;
  });
  const tie = (a: { number: number }, b: { number: number }): number => a.number - b.number;
  issues.sort((a, b) => (direction === 'asc'
    ? a.createdAt.getTime() - b.createdAt.getTime() || tie(a, b)
    : b.createdAt.getTime() - a.createdAt.getTime() || tie(b, a)));
  return ok(200, issues.map((issue) => issueJson(repo, issue)));
}

function patchIssue(repo: Repo, issue: Issue, input: Record<string, unknown>): RestAnswer {
  if (typeof input.title === 'string') issue.title = input.title;
  if (typeof input.body === 'string') issue.body = input.body;
  if (input.state === 'open' || input.state === 'closed') {
    issue.state = input.state;
    issue.closedAt = input.state === 'closed' ? new Date() : null;
  }
  if (Array.isArray(input.labels)) {
    const names = normalizeLabels(input);
    for (const name of names) if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
    issue.labels = names;
  }
  issue.updatedAt = new Date();
  return ok(200, issueJson(repo, issue));
}

export function createPull(repo: Repo, input: Record<string, unknown>): RestAnswer {
  const title = typeof input.title === 'string' ? input.title : '';
  const head = typeof input.head === 'string' ? input.head : '';
  const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
  if (title === '' || head === '') return fail(422, 'Validation Failed: title and head are required');
  const headSha = refHead(repo, head);
  if (!headSha) return fail(422, `Validation Failed: head ${head} does not exist`);
  const baseSha = refHead(repo, base);
  if (!baseSha) return fail(422, `Validation Failed: base ${base} does not exist`);
  const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
  if (existing) return fail(422, 'Validation Failed: a pull request for this head and base already exists');
  const now = new Date();
  const number = nextIssueNumber(repo);
  const pull: Pull = {
    id: 2_000_000 + number * 10,
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    head,
    base,
    baseShaAtCreation: baseSha,
    user: OWNER_LOGIN,
    createdAt: now,
    updatedAt: now,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    closedAt: null,
    isPull: true,
  };
  repo.pulls.set(number, pull);
  return ok(201, pullJson(repo, pull));
}

function listPulls(repo: Repo, query: URLSearchParams): RestAnswer {
  const state = query.get('state') ?? 'open';
  const pulls = [...repo.pulls.values()].filter((pull) => {
    if (state === 'all') return true;
    if (state === 'open') return pull.state === 'open';
    return pull.state === 'closed';
  });
  pulls.sort((a, b) => b.number - a.number);
  return ok(200, pulls.map((pull) => pullJson(repo, pull)));
}

function pullFiles(repo: Repo, pull: Pull): FileDiff[] {
  const headSha = refHead(repo, pull.head);
  const baseSha = refHead(repo, pull.base);
  const headTree = headSha ? parseCommit(repo.objects.get(headSha)!.bytes).tree : undefined;
  const baseTree = baseSha ? parseCommit(repo.objects.get(baseSha)!.bytes).tree : undefined;
  return diffTrees(repo, baseTree, headTree);
}

export function mergePull(repo: Repo, pull: Pull, input: Record<string, unknown>): RestAnswer {
  const mergeMethod = typeof input.merge_method === 'string' ? input.merge_method : 'merge';
  if (!['merge', 'squash', 'rebase'].includes(mergeMethod)) {
    return fail(422, `Validation Failed: merge_method ${mergeMethod} is not supported`);
  }
  if (pull.merged || pull.state !== 'open') {
    return fail(405, 'Pull Request is not mergeable: it is already merged or closed');
  }
  const baseSha = refHead(repo, pull.base);
  const headSha = refHead(repo, pull.head);
  if (!baseSha || !headSha) return fail(405, 'Pull Request is not mergeable: a branch is missing');
  if (baseSha !== pull.baseShaAtCreation) {
    return fail(405, 'Pull Request is not mergeable: the base branch has moved (merge conflict)');
  }
  const headTree = parseCommit(repo.objects.get(headSha)!.bytes).tree;
  const message = `${pull.title} (#${pull.number})`;
  const commit = buildCommit({ tree: headTree, parents: [baseSha], message, timestamp: Math.floor(Date.now() / 1000) });
  const mergeSha = oidOf('commit', commit);
  repo.objects.set(mergeSha, { kind: 'commit', bytes: commit });
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  repo.packCache.clear();
  const now = new Date();
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  pull.state = 'closed';
  pull.closedAt = now;
  pull.updatedAt = now;
  return ok(200, { merged: true, sha: mergeSha, message: `Pull Request successfully merged (${mergeMethod})` });
}

export type { IssueOrPull };
