// Git object model, packfile codec, pkt-line codec and tree/commit helpers.
// Node built-ins only. All object ids are lowercase 40-hex SHA-1, as git computes them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const SHA40_RE = /^[0-9a-f]{40}$/;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && SHA40_RE.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// trees and commits
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a tag object (recursively) to the commit it names, or the oid itself. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------
// reachability, ancestors, merge-base, tree flattening and diffs
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** All commit oids reachable from `tip` (including `tip` itself when it is a commit). */
export function commitAncestors(lookup: ObjectLookup, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [peelToCommitFromLookup(lookup, tip)];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return seen;
}

function peelToCommitFromLookup(lookup: ObjectLookup, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = lookup(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** Whether `ancestor` is `tip` or one of its ancestors. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return commitAncestors(lookup, tip).has(peelToCommitFromLookup(lookup, ancestor));
}

/** The merge-base of two commits: the first common ancestor found walking from `a`. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const bSet = commitAncestors(lookup, b);
  bSet.add(peelToCommitFromLookup(lookup, b));
  // Walk from a breadth-first by generation (parents after the commit itself).
  const seen = new Set<string>();
  const queue: string[] = [peelToCommitFromLookup(lookup, a)];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bSet.has(oid)) return oid;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

/** Every object reachable from the given tips (commits, trees, blobs, tags). */
export function collectReachable(lookup: ObjectLookup, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** A tree flattened to path -> {oid, mode}. */
export function flattenTree(lookup: ObjectLookup, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid) walk(treeOid, '');
  return out;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Diff two trees (null = empty). Line counts are computed from the blob bytes. */
export function diffTrees(
  lookup: ObjectLookup,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileDiff[] {
  const base = flattenTree(lookup, baseTreeOid);
  const head = flattenTree(lookup, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const data = lookup(b.oid)?.data ?? Buffer.alloc(0);
      diffs.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions: countLines(data) });
    } else if (!b && h) {
      const data = lookup(h.oid)?.data ?? Buffer.alloc(0);
      diffs.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions: countLines(data), deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const oldData = lookup(b.oid)?.data ?? Buffer.alloc(0);
      const newData = lookup(h.oid)?.data ?? Buffer.alloc(0);
      const oldLines = new Set(oldData.toString('utf8').split('\n'));
      const newLines = newData.toString('utf8').split('\n');
      let additions = 0;
      for (const line of newLines) if (line !== '' || newData.length === 0) { if (!oldLines.has(line) && line !== '') additions += 1; }
      // Simple line accounting: added lines not in old, removed lines not in new.
      const newSet = new Set(newLines);
      let deletions = 0;
      for (const line of oldData.toString('utf8').split('\n')) if (line !== '' && !newSet.has(line)) deletions += 1;
      if (additions === 0 && deletions === 0) { additions = 1; }
      diffs.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions, deletions });
    }
  }
  return diffs;
}

/** Build a new tree by applying path changes (Buffer = set, null = delete) onto a base tree. */
export function updateTree(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  changes: Map<string, Buffer | null>,
): string {
  // Group changes by first path segment.
  const put = (oid: string, data: Buffer, type: GitObjectType): string => {
    const newOid = hashObject(type, data);
    if (!objects.has(newOid)) objects.set(newOid, { type, data });
    return newOid;
  };
  const build = (treeOid: string | null, prefix: string): string => {
    const baseEntries = treeOid ? parseTree(objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
    const byName = new Map<string, TreeEntry>();
    for (const entry of baseEntries) byName.set(entry.name, entry);
    // Direct file changes at this level and subdir changes.
    const subChanges = new Map<string, Map<string, Buffer | null>>();
    for (const [path, data] of changes) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        if (data === null) byName.delete(rest);
        else {
          const blobOid = put('', data, 'blob');
          byName.set(rest, { mode: '100644', name: rest, oid: blobOid });
        }
      } else {
        const dir = rest.slice(0, slash);
        let sub = subChanges.get(dir);
        if (!sub) { sub = new Map(); subChanges.set(dir, sub); }
        sub.set(`${prefix}${dir}/${rest.slice(slash + 1)}`, data);
      }
    }
    for (const [dir, sub] of subChanges) {
      const existing = byName.get(dir);
      const childTree = build(existing && existing.mode === '40000' ? existing.oid : null, `${prefix}${dir}/`);
      // If the subtree ended up empty, drop the directory.
      const childObj = objects.get(childTree);
      const childEntries = childObj ? parseTree(childObj.data) : [];
      if (childEntries.length === 0) byName.delete(dir);
      else byName.set(dir, { mode: '40000', name: dir, oid: childTree });
    }
    const treeData = buildTree([...byName.values()]);
    return put('', treeData, 'tree');
  };
  return build(baseTreeOid, '');
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line payload too large');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    // Buffers are already pkt-line framed (e.g. sideband pack bytes): pass through raw.
    else if (typeof item === 'string') parts.push(encodePktLine(item));
    else parts.push(item);
  }
  return Buffer.concat(parts);
}

export type PktLine =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buffer: Buffer): { packets: PktLine[]; rest: Buffer } {
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) { packets.push({ kind: 'flush' }); offset += 4; continue; }
    if (length === 1) { packets.push({ kind: 'delim' }); offset += 4; continue; }
    if (length === 2) { packets.push({ kind: 'response-end' }); offset += 4; continue; }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** Split a receive-pack body into its pkt-line command section and the raw pack that follows. */
export function splitReceivePack(body: Buffer): { packets: PktLine[]; pack: Buffer } {
  let offset = 0;
  const packets: PktLine[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line header in receive-pack');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line in receive-pack');
    const length = Number.parseInt(header, 16);
    if (length === 0) { packets.push({ kind: 'flush' }); offset += 4; break; }
    if (length === 1) { packets.push({ kind: 'delim' }); offset += 4; continue; }
    if (length === 2) { packets.push({ kind: 'response-end' }); offset += 4; continue; }
    if (length < 4 || length > 65520 || offset + length > body.length) throw new Error('bad pkt-line in receive-pack');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, pack: body.subarray(offset) };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a pack (version 2, plain objects, no deltas) and its SHA-1 trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = TYPE_CODE[object.type];
    const size = object.data.length;
    const sizeBytes: number[] = [];
    let remaining = size;
    sizeBytes.push((typeCode << 4) | (remaining & 0x0f));
    remaining >>= 4;
    while (remaining > 0) {
      sizeBytes.push(remaining & 0x7f);
      remaining >>= 7;
    }
    // Set continuation bits on all but the last byte.
    const headerBytes = Buffer.from(sizeBytes);
    for (let i = 0; i < headerBytes.length - 1; i += 1) headerBytes[i] |= 0x80;
    parts.push(headerBytes);
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Read a pack: plain objects plus OFS_DELTA / REF_DELTA. Verifies the trailer checksum. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expectedTrailer = pack.subarray(pack.length - 20).toString('hex');
  const actualTrailer = sha1Hex(pack.subarray(0, pack.length - 20));
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  // First pass: read entries in order, remembering offsets for OFS_DELTA.
  interface Entry { offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string; }
  const entries: Entry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      // OFS_DELTA: variable-length offset.
      byte = pack[offset];
      offset += 1;
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - base;
    } else if (type === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const end = entryEndOffset(pack, offset, size);
    const inflated = inflateSync(pack.subarray(offset, end));
    offset = end;
    entries.push({ offset: entryOffset, type, data: inflated, baseOffset, baseOid });
  }
  // Resolve entries in order (deltas reference earlier entries or external objects).
  const byOffset = new Map<number, GitObject>();
  const resolve = (entry: Entry): GitObject => {
    if (entry.type >= 1 && entry.type <= 4) {
      const obj: GitObject = { type: CODE_TYPE[entry.type]!, data: entry.data };
      byOffset.set(entry.offset, obj);
      return obj;
    }
    let base: GitObject | undefined;
    if (entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset);
    else if (entry.baseOid !== undefined) base = objects.get(entry.baseOid);
    if (!base) throw new Error('delta base not found in pack');
    const data = applyDelta(base.data, entry.data);
    const obj: GitObject = { type: base.type, data };
    byOffset.set(entry.offset, obj);
    return obj;
  };
  for (const entry of entries) {
    const obj = resolve(entry);
    objects.set(hashObject(obj.type, obj.data), obj);
  }
  return objects;
}

// Find where a zlib stream starting at `start` ends. Node's inflateSync ignores trailing
// bytes and throws on a truncated stream, so "inflates to exactly expectedSize" is false
// before the true end and true at/after it. Exponential search brackets the end (entries are
// small), then binary search finds the first true end. Each probe only inflates the bracket.
function entryEndOffset(pack: Buffer, start: number, expectedSize: number): number {
  const limit = pack.length - 20; // the 20-byte trailer; entries never overlap it
  const probe = (end: number): boolean => {
    try {
      return inflateSync(pack.subarray(start, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!probe(limit)) throw new Error('could not inflate a pack entry');
  let step = 16;
  let high = Math.min(limit, start + step);
  while (!probe(high)) {
    step *= 2;
    high = Math.min(limit, start + step);
  }
  let low = start + 2;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (probe(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) { copyOffset |= delta[offset] << (8 * i); offset += 1; }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) { copySize |= delta[offset] << (8 * i); offset += 1; }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (produced !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(parts);
}
