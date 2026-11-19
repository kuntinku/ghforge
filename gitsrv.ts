// gitsrv.ts — the git smart-HTTP surface: ref advertisements, ls-refs, fetch (v2 and v0) and
// receive-pack with per-ref report-status. Object selection is a depth-aware reachability walk.

import { isOid, parseTag, type ObjKind } from './gitobj.ts';
import {
  decodePkts,
  pkt,
  pktFlush,
  readPack,
  writePack,
  type Pkt,
} from './wire.ts';
import {
  DEFAULT_BRANCH,
  SERVER_VERSION,
  commitOf,
  getObject,
  hasObjectClosure,
  putObject,
  reachable,
  type Repo,
} from './store.ts';

export const ZERO = '0'.repeat(40);
const CAPS_UPLOAD =
  `multi_ack_detailed multi_ack side-band-64k side-band thin-pack ofs-delta shallow no-progress ` +
  `include-tag agent=${SERVER_VERSION} object-format=sha1`;
const CAPS_RECEIVE =
  `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta ` +
  `agent=${SERVER_VERSION} object-format=sha1`;

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** The refs a repository advertises, HEAD first (the default branch's tip, or the zero id). */
export function advertisedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO;
  out.push({ oid: headOid, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    if (name.startsWith('refs/heads/')) {
      out.push({ oid: repo.refs.get(name)!, name });
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!name.startsWith('refs/tags/')) continue;
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj && obj.kind === 'tag') peeled = parseTag(obj.bytes).object;
    out.push({ oid, name, peeled });
  }
  return out;
}

function symrefOf(): string {
  return `symref=HEAD:refs/heads/${DEFAULT_BRANCH}`;
}

/** The upload-pack advertisement body (protocol v0 or v2), preamble first. */
export function uploadPackAdvertisement(repo: Repo, v2: boolean): Buffer {
  const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), pktFlush()];
  if (v2) {
    parts.push(pkt('version 2\n'));
    parts.push(pkt(`agent=${SERVER_VERSION}\n`));
    parts.push(pkt('ls-refs=unborn\n'));
    parts.push(pkt('fetch=shallow filter\n'));
    parts.push(pkt('server-option\n'));
    parts.push(pkt('object-format=sha1\n'));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const refs = advertisedRefs(repo);
  const head = refs[0];
  const caps = `${CAPS_UPLOAD} ${symrefOf()}`;
  if (head.oid === ZERO && refs.length === 1) {
    parts.push(pkt(`${ZERO} capabilities^{}\u0000${caps}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const line = i === 0 ? `${ref.oid} ${ref.name}\u0000${caps}\n` : `${ref.oid} ${ref.name}\n`;
    parts.push(pkt(line));
    if (ref.peeled) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The receive-pack advertisement body: always protocol v0. */
export function receivePackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pkt('# service=git-receive-pack\n'), pktFlush()];
  const refs = advertisedRefs(repo).filter((ref) => ref.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\u0000${CAPS_RECEIVE}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const line = i === 0 ? `${ref.oid} ${ref.name}\u0000${CAPS_RECEIVE}\n` : `${ref.oid} ${ref.name}\n`;
    parts.push(pkt(line));
    if (ref.peeled) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack commands

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') request.done = true;
  }
  return request;
}

interface Selection {
  objects: StoredObj[];
  shallow: string[];
  unshallow: string[];
}

/** The objects a fetch must send, with the shallow boundary the answer should report. */
function selectObjects(repo: Repo, request: FetchRequest): Selection {
  const wantCommits = request.wants.filter((oid) => {
    const obj = repo.objects.get(oid);
    return obj !== undefined && (obj.kind === 'commit' || obj.kind === 'tag');
  });
  const exempt = new Set<string>();
  for (const oid of [...request.haves, ...request.shallow]) {
    for (const reachableOid of reachable(repo, [oid])) exempt.add(reachableOid);
  }
  if (request.depth !== null && request.depth > 0) {
    const depth = request.depth;
    const generation = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const oid of wantCommits) {
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      // A tag peels to its commit; the generation budget starts at the commit.
      if (obj.kind === 'tag') queue.push({ oid: parseTag(obj.bytes).object, gen: 1 });
      else queue.push({ oid, gen: 1 });
    }
    while (queue.length) {
      const { oid, gen } = queue.shift()!;
      const known = generation.get(oid);
      if (known !== undefined && known <= gen) continue;
      generation.set(oid, gen);
      const obj = repo.objects.get(oid);
      if (!obj || obj.kind !== 'commit') continue;
      const commit = commitOf(obj);
      if (gen >= depth) continue;
      for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
    const included = new Set(generation.keys());
    const shallow: string[] = [];
    for (const oid of included) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.kind !== 'commit') continue;
      const commit = commitOf(obj);
      if (commit.parents.some((parent) => !included.has(parent))) shallow.push(oid);
    }
    const unshallow: string[] = [];
    for (const oid of request.shallow) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.kind !== 'commit') continue;
      const commit = commitOf(obj);
      if (commit.parents.every((parent) => included.has(parent))) unshallow.push(oid);
    }
    const wantedTips = new Set<string>();
    for (const oid of request.wants) {
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.kind === 'tag') {
        wantedTips.add(oid);
        wantedTips.add(parseTag(obj.bytes).object);
      } else wantedTips.add(oid);
    }
    const all = new Set<string>();
    // Every commit the depth walk included (not only the wanted tips) travels in the pack.
    for (const oid of included) {
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      all.add(oid);
      if (obj.kind === 'commit') {
        const commit = commitOf(obj);
        for (const inner of reachable(repo, [commit.tree])) all.add(inner);
      }
    }
    for (const oid of wantedTips) {
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.kind === 'tag') {
        for (const inner of reachable(repo, [oid])) all.add(inner);
        continue;
      }
      all.add(oid);
      const commit = included.has(oid) ? commitOf(obj) : null;
      if (commit) for (const inner of reachable(repo, [commit.tree])) all.add(inner);
    }
    const objects: StoredObj[] = [];
    // Inside a depth walk the client's "haves" answer is about generations it already holds;
    // commits the depth walk just included must still be delivered.
    const localClosure = new Set<string>(included);
    for (const oid of included) {
      const obj = repo.objects.get(oid);
      if (obj?.kind === 'commit') for (const inner of reachable(repo, [commitOf(obj).tree])) localClosure.add(inner);
    }
    const exemptHere = new Set([...exempt].filter((oid) => !localClosure.has(oid)));
    if (process.env.GHFORGE_DEBUG === '1') process.stderr.write(`[depth] included=${[...included].length} all=${all.size} exempt=${exempt.size} exemptHere=${exemptHere.size} sending=${[...all].filter((o)=>!exemptHere.has(o)).length} shallow=${shallow.join(',')} unshallow=${unshallow.join(',')}\n`);
    for (const oid of all) {
      if (exemptHere.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj) objects.push(obj);
    }
    return { objects, shallow, unshallow };
  }

  const tips: string[] = [];
  for (const oid of request.wants) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    tips.push(oid);
    if (obj.kind === 'tag') tips.push(parseTag(obj.bytes).object);
  }
  const wanted = reachable(repo, tips);
  const objects: StoredObj[] = [];
  for (const oid of wanted) {
    if (exempt.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow: [], unshallow: [] };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 60_000;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(at + CHUNK, pack.length));
    out.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) out.push(pkt(Buffer.concat([Buffer.from([1]), pack])));
  return out;
}

function packFor(repo: Repo, request: FetchRequest, v2: boolean): { body: Buffer } {
  const key = `${v2 ? '2' : '0'}|${request.wants.slice().sort().join(',')}|${request.haves.slice().sort().join(',')}|${request.shallow.slice().sort().join(',')}|${request.depth ?? ''}`;
  const cached = repo.packCache.get(key);
  if (cached) return { body: cached };
  const selection = selectObjects(repo, request);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (v2) {
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    }
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
  } else {
    for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(pkt('NAK\n'));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
  }
  const body = Buffer.concat(parts);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(key, body);
  return { body };
}

/** The v2 ls-refs answer, filtered server-side by ref-prefix. */
function lsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = advertisedRefs(repo);
  const head = refs[0];
  const empty = refs.filter((ref) => ref.name !== 'HEAD').length === 0;
  if (keep('HEAD')) {
    if (head.oid === ZERO && empty) {
      if (unborn) parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`));
    } else {
      parts.push(pkt(`${head.oid} HEAD${symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`));
    }
  }
  for (const ref of refs) {
    if (ref.name === 'HEAD') continue;
    if (!keep(ref.name)) continue;
    const extra = peel && ref.peeled ? ` peeled:${ref.peeled}` : '';
    parts.push(pkt(`${ref.oid} ${ref.name}${extra}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer one POST to git-upload-pack. */
export function handleUploadPack(repo: Repo, body: Uint8Array, v2: boolean): Buffer {
  const decoded = decodePkts(body);
  const texts = decoded.pkts.filter((item): item is { kind: 'data'; payload: Buffer } => item.kind === 'data').map((item) => item.payload.toString('utf8'));
  const commandLine = texts[0] ?? '';
  if (commandLine.startsWith('command=ls-refs')) return lsRefs(repo, texts);
  if (commandLine.startsWith('command=fetch')) {
    const req = parseFetchArgs(texts);
    if (process.env.GHFORGE_DEBUG === '1') process.stderr.write(`[fetch] wants=${req.wants.length} haves=${req.haves.length} shallow=${req.shallow.length} depth=${req.depth} done=${req.done}\n`);
    return packFor(repo, req, v2).body;
  }
  return Buffer.concat([pkt('ERR unknown command\n'), pktFlush()]);
}

// ---------------------------------------------------------------- receive-pack

interface Command {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface ReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  let current = tip;
  const seen = new Set<string>();
  while (isOid(current) && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.kind !== 'commit') return false;
    current = commitOf(obj).parents[0] ?? '';
  }
  return false;
}

/** Answer one POST to git-receive-pack: unpack, apply fast-forward commands, report per ref. */
export function handleReceivePack(repo: Repo, body: Uint8Array): Buffer {
  const decoded = decodePkts(body);
  const commands: Command[] = [];
  let index = 0;
  for (; index < decoded.pkts.length; index += 1) {
    const item = decoded.pkts[index];
    if (item.kind === 'flush') {
      index += 1;
      break;
    }
    if (item.kind !== 'data') continue;
    let line = item.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    const pieces = line.split(' ');
    if (pieces.length < 3) continue;
    commands.push({ oldOid: pieces[0], newOid: pieces[1], ref: pieces.slice(2).join(' ') });
  }
  const packBytes = decoded.trailing.subarray(0);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes);
      if (!pack.checksumOk) throw new Error('pack trailer checksum mismatch');
      for (const [oid, obj] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.slice(0, 200);
    }
  }
  const reports: ReportLine[] = [];
  if (!unpackOk) {
    for (const command of commands) reports.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const command of commands) {
      reports.push(applyCommand(repo, command));
    }
    repo.updatedAt = new Date();
  }
  const inner: Buffer[] = [pkt(`unpack ${unpackDetail}\n`)];
  for (const report of reports) {
    inner.push(report.ok ? pkt(`ok ${report.ref}\n`) : pkt(`ng ${report.ref} ${report.reason}\n`));
  }
  inner.push(pktFlush());
  const innerBytes = Buffer.concat(inner);
  const chunks: Buffer[] = [];
  const CHUNK = 60_000;
  for (let at = 0; at < innerBytes.length; at += CHUNK) {
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), innerBytes.subarray(at, Math.min(at + CHUNK, innerBytes.length))])));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function applyCommand(repo: Repo, command: Command): ReportLine {
  const { ref, oldOid, newOid } = command;
  if (!ref.startsWith('refs/') || /[\s\u0000-\u001f]/.test(ref)) {
    return { ref, ok: false, reason: 'funny refname' };
  }
  if (!isOid(newOid) || !isOid(oldOid)) return { ref, ok: false, reason: 'invalid object id' };
  const current = repo.refs.get(ref) ?? ZERO;
  if (newOid === ZERO) {
    if (current === ZERO) return { ref, ok: true, reason: '' };
    if (oldOid !== ZERO && current !== oldOid) return { ref, ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    repo.packCache.clear();
    return { ref, ok: true, reason: '' };
  }
  const target = repo.objects.get(newOid);
  if (!target) return { ref, ok: false, reason: 'missing necessary objects' };
  if (current === ZERO) {
    if (oldOid !== ZERO) return { ref, ok: false, reason: 'ref does not exist' };
  } else {
    if (current === oldOid) {
      if (current !== newOid && target.kind === 'commit' && !isAncestor(repo, current, newOid)) {
        return { ref, ok: false, reason: 'non-fast-forward' };
      }
    } else if (!isAncestor(repo, current, newOid)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  if (target.kind === 'commit' && !hasObjectClosure(repo, newOid)) {
    return { ref, ok: false, reason: 'missing necessary objects' };
  }
  repo.refs.set(ref, newOid);
  repo.packCache.clear();
  return { ref, ok: true, reason: '' };
}

/** The refs a receive-pack answer must delete when a push deletes them (used by tests). */
export function refNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

