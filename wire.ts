// wire.ts — pkt-line framing and the packfile format (read + write) for ghforge.
// SHA-1 packs, versions 2/3 on read; we always write version 2 with plain (non-delta) objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { oidOf, type ObjKind, type StoredObj } from './gitobj.ts';

// ---------------------------------------------------------------- pkt-line

/** Encode one data pkt-line: 4 hex length bytes (payload + 4) then the payload. */
export function pkt(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > 65516) throw new Error(`pkt-line payload of ${data.length} bytes exceeds 65516`);
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** One decoded pkt-line from a request or response stream. */
export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Decode every pkt-line in a byte string. Trailing non-framed bytes are returned separately. */
export function decodePkts(bytes: Uint8Array): { pkts: Pkt[]; trailing: Buffer } {
  const buf = Buffer.from(bytes);
  const pkts: Pkt[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      return { pkts, trailing: buf.subarray(at) };
    }
    const length = parseInt(head, 16);
    if (length === 0) {
      pkts.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      pkts.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      pkts.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (length < 4 || length > 65520 || at + length > buf.length) {
      return { pkts, trailing: buf.subarray(at) };
    }
    pkts.push({ kind: 'data', payload: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return { pkts, trailing: buf.subarray(at) };
}

/** The utf8 text of every data pkt-line (control packets dropped). */
export function pktTexts(pkts: Pkt[]): string[] {
  const out: string[] = [];
  for (const item of pkts) if (item.kind === 'data') out.push(item.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------- pack write

const KIND_CODE: Record<ObjKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function objHeader(kind: ObjKind, size: number): Buffer {
  const bytes: number[] = [];
  let code = (KIND_CODE[kind] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(code | 0x80);
    code = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(code);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects; no deltas. The trailer is SHA-1 of the body. */
export function writePack(objects: Iterable<StoredObj>): Buffer {
  const list = [...objects];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of list) {
    parts.push(objHeader(obj.kind, obj.bytes.length));
    parts.push(deflateSync(obj.bytes));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- pack read

const CODE_KIND: Record<number, ObjKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackRead {
  version: number;
  declared: number;
  objects: Map<string, StoredObj>;
  deltaCount: number;
  checksumOk: boolean;
}

function sizeVarint(buf: Buffer, at: number): { size: number; next: number; first: number } {
  let byte = buf[at];
  if (byte === undefined) throw new Error('pack entry header is truncated');
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let next = at + 1;
  while (byte & 0x80) {
    byte = buf[next++];
    if (byte === undefined) throw new Error('pack entry size varint is truncated');
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next, first };
}

function ofsBase(buf: Buffer, at: number): { baseOffset: number; next: number } {
  let byte = buf[at];
  if (byte === undefined) throw new Error('ofs-delta has no base offset');
  let value = byte & 0x7f;
  let next = at + 1;
  while (byte & 0x80) {
    byte = buf[next++];
    if (byte === undefined) throw new Error('ofs-delta base offset is truncated');
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next };
}

/** Apply a git copy/insert delta to a base buffer. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuf = Buffer.from(base);
  const d = Buffer.from(delta);
  let at = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= d.length) throw new Error('delta size varint is truncated');
      const byte = d[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuf.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuf.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < d.length) {
    const op = d[at++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += d[at++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += d[at++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuf.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuf.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (at + literal > d.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      d.copy(out, written, at, at + literal);
      at += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

function inflateAt(buf: Buffer, at: number, limit: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(at, limit), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${at} did not inflate: ${(err as Error).message}`);
  }
  return { data: result.buffer, next: at + result.engine.bytesWritten };
}

interface RawEntry {
  offset: number;
  typeCode: number;
  bytes: Buffer;
  baseOffset?: number;
  baseOid?: string;
  kind?: ObjKind;
  oid?: string;
}

/**
 * Parse a packfile and resolve every object, including OFS_DELTA and REF_DELTA.
 * Each object's id is recomputed, so a corrupt object cannot pass silently.
 */
export function readPack(pack: Uint8Array): PackRead {
  const buf = Buffer.from(pack);
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = buf.readUInt32BE(8);
  const trailerAt = buf.length - 20;
  const checksumOk = createHash('sha1').update(buf.subarray(0, trailerAt)).digest('hex') === buf.subarray(trailerAt).toString('hex');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let at = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = at;
    const head = sizeVarint(buf, at);
    at = head.next;
    const typeCode = (head.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, bytes: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = ofsBase(buf, at);
      at = base.next;
      if (base.baseOffset <= 0 || entryOffset - base.baseOffset < 0) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (at + 20 > trailerAt) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (!CODE_KIND[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf, at, trailerAt);
    if (inflated.data.length !== head.size) {
      throw new Error(`pack entry at ${entryOffset} declared ${head.size} bytes, inflated to ${inflated.data.length}`);
    }
    entry.bytes = inflated.data;
    at = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (at !== trailerAt) throw new Error(`pack has ${trailerAt - at} stray bytes before its trailer`);

  const objects = new Map<string, StoredObj>();
  const byOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { kind: ObjKind; bytes: Buffer; oid: string } => {
    if (entry.kind && entry.oid) return { kind: entry.kind, bytes: entry.bytes, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let kind: ObjKind;
    let bytes: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      kind = base.kind;
      bytes = applyDelta(base.bytes, entry.bytes);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      if (!baseEntry) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack`);
      const base = resolve(baseEntry);
      kind = base.kind;
      bytes = applyDelta(base.bytes, entry.bytes);
    } else {
      kind = CODE_KIND[entry.typeCode];
      bytes = entry.bytes;
    }
    const oid = oidOf(kind, bytes);
    entry.kind = kind;
    entry.bytes = bytes;
    entry.oid = oid;
    byOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { kind, bytes, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const done = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(done.oid)) objects.set(done.oid, { kind: done.kind, bytes: done.bytes });
  }
  return { version, declared, objects, deltaCount, checksumOk };
}
