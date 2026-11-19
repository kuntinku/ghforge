// gitobj.ts — the git object model: hashing, tree/commit/tag parsing and building, tree surgery.
// Written for ghforge; SHA-1 only, per the contest rules.

import { createHash } from 'node:crypto';

export type ObjKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObj {
  kind: ObjKind;
  bytes: Buffer;
}

export function isOid(value: string): boolean {
  if (value.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = value.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

export function oidOf(kind: ObjKind, bytes: Uint8Array): string {
  const head = Buffer.from(`${kind} ${bytes.length}\u0000`, 'utf8');
  return createHash('sha1').update(head).update(bytes).digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(bytes: Uint8Array): TreeItem[] {
  const buf = bytes;
  const out: TreeItem[] = [];
  let at = 0;
  while (at < buf.length) {
    const space = buf.indexOf(0x20, at);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buf.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buf.length) throw new Error('tree entry is truncated');
    out.push({
      mode: buf.subarray(at, space).toString('ascii'),
      name: buf.subarray(space + 1, nul).toString('utf8'),
      oid: buf.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return out;
}

function treeOrder(a: TreeItem, b: TreeItem): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(items: TreeItem[]): Buffer {
  const sorted = [...items].sort(treeOrder);
  const parts: Buffer[] = [];
  for (const item of sorted) {
    if (!isOid(item.oid)) throw new Error(`tree entry ${item.name} has a bad object id`);
    parts.push(Buffer.from(`${item.mode} ${item.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(item.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: Array<[string, string]>;
}

export function parseCommit(bytes: Uint8Array): CommitView {
  const buf = bytes;
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message, extra: [] };
  for (const line of buf.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
    else view.extra.push([key, value]);
  }
  if (!isOid(view.tree)) throw new Error('commit has no valid tree header');
  return view;
}

export const FORGE_IDENTITY = 'GhForge <forge@ghforge.invalid>';

export interface CommitSpec {
  tree: string;
  parents?: string[];
  message: string;
  author?: string;
  committer?: string;
  /** Unix seconds; defaults to the wall clock, truncated to whole seconds. */
  timestamp?: number;
}

export function buildCommit(spec: CommitSpec): Buffer {
  if (!isOid(spec.tree)) throw new Error('buildCommit needs a valid tree id');
  const ts = spec.timestamp ?? Math.floor(Date.now() / 1000);
  const who = (name?: string) => `${name ?? FORGE_IDENTITY} ${ts} +0000`;
  const lines = [`tree ${spec.tree}`];
  for (const parent of spec.parents ?? []) {
    if (!isOid(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who(spec.author)}`, `committer ${who(spec.committer)}`, '');
  return Buffer.from(`${lines.join('\n')}\n${spec.message}`, 'utf8');
}

// ---------------------------------------------------------------- tags

export interface TagView {
  object: string;
  kind: ObjKind;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(bytes: Uint8Array): TagView {
  const buf = bytes;
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const headers = new Map<string, string>();
  for (const line of buf.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const kind = (headers.get('type') ?? 'commit') as ObjKind;
  if (!isOid(object)) throw new Error('tag has no valid object header');
  return {
    object,
    kind,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

/** The commit a tag (or tag chain) ultimately points at. */
export function peelTag(kind: ObjKind, bytes: Uint8Array): { oid: string; kind: ObjKind } | null {
  if (kind !== 'tag') return null;
  const view = parseTag(bytes);
  return { oid: view.object, kind: view.kind };
}
