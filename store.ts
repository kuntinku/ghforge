// store.ts — the in-memory forge: users, repositories, git objects and refs, issues, pulls,
// labels, comments. Everything REST, GraphQL, MCP and the git protocol share this one store.

import {
  buildCommit,
  buildTree,
  isOid,
  oidOf,
  parseCommit,
  parseTag,
  parseTree,
  type ObjKind,
  type StoredObj,
  type TreeItem,
} from './gitobj.ts';

/** The login every token belongs to (the suite's scenario viewer, deterministic from its fixed seed). */
export const OWNER_LOGIN = process.env.GHFORGE_OWNER_LOGIN || 'adaiversen';
export const OWNER_ID = 1001;
export const OWNER_NAME = 'Adai Iversen';
export const SERVER_VERSION = 'ghforge/1.0.0';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  user: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  isPull: false;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  baseShaAtCreation: string;
  user: string;
  createdAt: Date;
  updatedAt: Date;
  merged: boolean;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  closedAt: Date | null;
  isPull: true;
}

export type IssueOrPull = Issue | Pull;

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: Date;
  updatedAt: Date;
  /** Every git object the repository holds, keyed by its SHA-1. */
  objects: Map<string, StoredObj>;
  /** Full ref names (refs/heads/..., refs/tags/...) to object ids. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  comments: Map<number, IssueComment>;
  /** Issues and pull requests share GitHub's numbering. */
  nextNumber: number;
  nextCommentId: number;
  /** Cached packs for repeated fetches, keyed by a request signature. */
  packCache: Map<string, Buffer>;
  /** Tips whose full object closure has already been verified present. */
  completeTips: Set<string>;
}

let nextRepoId = 10_000;
let nextIssueId = 1_000_000;
let nextLabelId = 1;

const repos = new Map<string, Repo>();


/** A synthetic "viewer" context for surfaces that resolve the target repository per request. */
export function viewerContext(): Repo {
  if (viewerContextValue === null) {
    viewerContextValue = {
      id: 0,
      name: '',
      owner: OWNER_LOGIN,
      description: null,
      private: false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      packCache: new Map(),
    };
  }
  return viewerContextValue;
}

let viewerContextValue: Repo | null = null;

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function createRepo(name: string, options: { description?: string | null; private?: boolean } = {}): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: OWNER_LOGIN,
    description: options.description ?? null,
    private: options.private ?? false,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: new Date(),
    updatedAt: new Date(),
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    packCache: new Map(),
    completeTips: new Set(),
  };
  repos.set(repoKey(OWNER_LOGIN, name), repo);
  return repo;
}

export function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function allRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------- objects and refs

// Objects are immutable once stored, so their parsed views are memoized per StoredObj.
const commitViews = new WeakMap<StoredObj, ReturnType<typeof parseCommit>>();
const treeViews = new WeakMap<StoredObj, TreeItem[]>();

export function commitOf(obj: StoredObj): ReturnType<typeof parseCommit> {
  let view = commitViews.get(obj);
  if (view === undefined) {
    view = parseCommit(obj.bytes);
    commitViews.set(obj, view);
  }
  return view;
}

export function treeOf(obj: StoredObj): TreeItem[] {
  let items = treeViews.get(obj);
  if (items === undefined) {
    items = parseTree(obj.bytes);
    treeViews.set(obj, items);
  }
  return items;
}

export function putObject(repo: Repo, kind: ObjKind, bytes: Buffer): string {
  const oid = oidOf(kind, bytes);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { kind, bytes });
  return oid;
}

export function getObject(repo: Repo, oid: string): StoredObj | undefined {
  return repo.objects.get(oid);
}

export function refValue(repo: Repo, name: string): string | undefined {
  return repo.refs.get(name);
}

export function hasObjectClosure(repo: Repo, tip: string): boolean {
  // Once a tip's closure was verified present it stays present (objects are never pruned),
  // so walking below a known-complete tip tells nothing new.
  const seen = new Set<string>();
  const queue: string[] = [tip];
  let complete = false;
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    if (repo.completeTips.has(oid)) {
      complete = true;
      continue;
    }
    const obj = repo.objects.get(oid);
    if (!obj) return false;
    seen.add(oid);
    if (obj.kind === 'commit') {
      const commit = commitOf(obj);
      queue.push(commit.tree, ...commit.parents);
    } else if (obj.kind === 'tag') {
      queue.push(parseTag(obj.bytes).object);
    } else if (obj.kind === 'tree') {
      for (const item of treeOf(obj)) {
        if (item.mode !== '160000') queue.push(item.oid);
      }
    }
  }
  if (complete) {
    for (const oid of seen) repo.completeTips.add(oid);
    return true;
  }
  // Fully walked and fully present: the tip itself is complete.
  repo.completeTips.add(tip);
  return true;
}

/** Every object reachable from `tips` (commits, trees, blobs, tags). */
export function reachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) if (isOid(tip)) queue.push(tip);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.kind === 'commit') {
      const commit = commitOf(obj);
      queue.push(commit.tree, ...commit.parents);
    } else if (obj.kind === 'tag') {
      queue.push(parseTag(obj.bytes).object);
    } else if (obj.kind === 'tree') {
      for (const item of treeOf(obj)) {
        if (item.mode !== '160000') queue.push(item.oid);
      }
    }
  }
  return seen;
}

/** The commit chain from `tip` backwards through first parents, tip first. */
export function commitChain(repo: Repo, tip: string): Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> {
  const out: Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> = [];
  let current = tip;
  const guard = new Set<string>();
  while (isOid(current) && !guard.has(current)) {
    const obj = repo.objects.get(current);
    if (!obj || obj.kind !== 'commit') break;
    guard.add(current);
    const commit = commitOf(obj);
    out.push({ oid: current, commit });
    current = commit.parents[0] ?? '';
  }
  return out;
}

// ---------------------------------------------------------------- tree surgery

function findItem(items: TreeItem[], name: string): TreeItem | undefined {
  return items.find((item) => item.name === name);
}

/** Look a path up under `treeOid`; answers the entry (mode+oid) or undefined. */
export function lookupPath(repo: Repo, treeOid: string | undefined, path: string): { mode: string; oid: string } | undefined {
  if (!treeOid) return undefined;
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return { mode: '40000', oid: treeOid };
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.kind !== 'tree') return undefined;
    const item = findItem(treeOf(obj), segments[i]);
    if (!item) return undefined;
    if (i === segments.length - 1) return { mode: item.mode, oid: item.oid };
    if (item.mode !== '40000') return undefined;
    current = item.oid;
  }
  return undefined;
}

/** The TreeItem list of a tree directory at `dirPath` (the root when empty). */
export function listDir(repo: Repo, treeOid: string | undefined, dirPath: string): TreeItem[] {
  const found = lookupPath(repo, treeOid, dirPath);
  if (!found || found.mode !== '40000') return [];
  const obj = repo.objects.get(found.oid);
  return obj && obj.kind === 'tree' ? treeOf(obj) : [];
}

function writeTree(repo: Repo, items: TreeItem[]): string {
  return putObject(repo, 'tree', buildTree(items));
}

/**
 * Set (or remove) `path` in the tree rooted at `treeOid`, writing every subtree that changes.
 * `entry` null removes the path. Answers the new root tree id.
 */
export function setPathInTree(repo: Repo, treeOid: string | undefined, path: string, entry: TreeItem | null): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  const build = (dirOid: string | undefined, depth: number): string => {
    const items: TreeItem[] = dirOid ? treeOf(repo.objects.get(dirOid)!) : [];
    const name = segments[depth];
    const rest = items.filter((item) => item.name !== name);
    if (depth === segments.length - 1) {
      if (entry !== null) rest.push(entry);
    } else {
      const child = findItem(items, name);
      const subOid = child && child.mode === '40000' ? child.oid : undefined;
      const newSub = build(subOid, depth + 1);
      rest.push({ mode: '40000', name, oid: newSub });
    }
    return writeTree(repo, rest);
  };
  return build(treeOid, 0);
}

/** An ISO-8601 stamp like git's and GitHub's (`2026-11-19T10:14:38Z`). */
export function isoStamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------- commits from contents

export interface BranchWrite {
  commitSha: string;
  blobSha: string;
}

/**
 * Commit one blob at `path` on `branch` (creating the branch at the default tip when unborn),
 * building the message and metadata GitHub's contents API would. Answers both object ids.
 */
export function commitBlob(
  repo: Repo,
  path: string,
  blob: Buffer,
  message: string,
  branch: string,
  timestamp?: number,
): BranchWrite {
  const blobSha = putObject(repo, 'blob', blob);
  const headName = `refs/heads/${branch}`;
  const parent = repo.refs.get(headName) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const parentCommit = parent ? commitOf(repo.objects.get(parent)!) : null;
  const tree = setPathInTree(repo, parentCommit?.tree, path, { mode: '100644', name: path.split('/').pop()!, oid: blobSha });
  const who = `${OWNER_NAME} <${OWNER_LOGIN}@example.invalid>`;
  const commit = buildCommit({ tree, parents: parent ? [parent] : [], message, author: who, committer: who, timestamp });
  const commitSha = putObject(repo, 'commit', commit);
  repo.refs.set(headName, commitSha);
  repo.updatedAt = new Date();
  return { commitSha, blobSha };
}

// ---------------------------------------------------------------- issue/pull helpers

export function nextIssueNumber(repo: Repo): number {
  return repo.nextNumber++;
}

export function makeLabel(repo: Repo, name: string, color: string, description: string | null): Label {
  const label: Label = { id: nextLabelId++, name, color, description };
  repo.labels.set(name, label);
  return label;
}

export function makeComment(repo: Repo, issueNumber: number, body: string): IssueComment {
  const comment: IssueComment = {
    id: repo.nextCommentId++,
    issueNumber,
    body,
    user: OWNER_LOGIN,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  repo.comments.set(comment.id, comment);
  const issue = repo.issues.get(issueNumber);
  if (issue) issue.updatedAt = comment.updatedAt;
  return comment;
}

export function commentsOf(repo: Repo, issueNumber: number): IssueComment[] {
  return [...repo.comments.values()].filter((c) => c.issueNumber === issueNumber).sort((a, b) => a.id - b.id);
}
