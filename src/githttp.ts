// Git smart-HTTP: info/refs advertisements (v2 and v0), ls-refs, fetch (v2 and v0)
// and receive-pack push with report-status. Node built-ins only.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  splitReceivePack,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  type GitObject,
  type PktLine,
} from './gitcore.ts';
import { VIEWER, type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function httpError(status: number, message: string): GitResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(message, 'utf8') };
}

/** Split a pkt-line stream's data packets into lines (without trailing \n). */
function dataLines(packets: PktLine[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** The server's refs for advertisement: HEAD + branches + tags (with peeled tag lines). */
function refAdvertisement(repo: Repo): Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string; symrefTarget?: string }> = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip) refs.push({ oid: peelToCommit(repo.objects, tip), name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  for (const [name, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') entry.peeled = peelToCommit(repo.objects, oid);
    refs.push(entry);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocolVersion2: boolean,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return httpError(404, 'repository not found');
  const refs = refAdvertisement(repo);
  const isUpload = service === 'git-upload-pack';
  const contentType = isUpload ? UPLOAD_AD : RECEIVE_AD;

  if (isUpload && gitProtocolVersion2) {
    // Protocol v2 capability advertisement.
    const body = encodePktLines([
      `# service=git-upload-pack\n`,
      'flush',
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow\n',
      'object-format=sha1\n',
      'flush',
    ]);
    return ok(contentType, body);
  }

  // Protocol v0 ref advertisement.
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow no-progress agent=${AGENT}`
      : `symref=HEAD:refs/heads/${repo.defaultBranch} report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0;
      if (ref.name === 'HEAD') {
        lines.push(`${ref.oid} HEAD\0${caps}\n`);
        return;
      }
      lines.push(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  return ok(contentType, encodePktLines(lines));
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Which objects a fetch must send, honouring haves, shallow boundaries and depth. */
function planFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): FetchPlan {
  const lookup = repo.objects.get.bind(repo.objects);
  const shallowSet = new Set(shallowIn);
  // What the client already holds: reachable from haves, never crossing a shallow boundary.
  const held = new Set<string>();
  const heldQueue: string[] = [...haves];
  while (heldQueue.length > 0) {
    const oid = heldQueue.pop()!;
    if (held.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      if (shallowSet.has(oid)) continue; // a shallow boundary has no parents on the client
      const commit = parseCommit(obj.data);
      heldQueue.push(commit.tree);
      for (const parent of commit.parents) heldQueue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTreeOf(obj.data)) heldQueue.push(entry.oid);
    } else if (obj.type === 'tag') {
      heldQueue.push(parseTag(obj.data).object);
    }
  }

  // Walk from the wants, bounded by depth.
  const collected = new Map<string, GitObject>();
  const shallowOut: string[] = [];
  const queue: Array<{ oid: string; distance: number }> = wants.map((oid) => ({ oid, distance: 1 }));
  const visitedCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      // A wanted tag: send the tag object and walk its target at the same distance.
      collectObject(repo, collected, oid);
      queue.push({ oid: peelToCommit(repo.objects, oid), distance });
      continue;
    }
    if (obj.type === 'commit') {
      if (visitedCommits.has(oid)) continue;
      visitedCommits.add(oid);
      if (depth !== null && distance > depth) continue;
      if (depth !== null && distance === depth) shallowOut.push(oid);
      collectObject(repo, collected, oid);
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
    } else {
      collectObject(repo, collected, oid);
    }
  }

  // Unshallow: old boundaries now inside the walk (closer than the new depth, or walked fully).
  const unshallow: string[] = [];
  for (const oid of shallowIn) {
    if (!visitedCommits.has(oid)) continue;
    if (depth === null || distanceOf(oid) < depth) unshallow.push(oid);
  }
  function distanceOf(oid: string): number {
    // Recompute the shortest distance from a want (cheap: small histories).
    const seen = new Map<string, number>();
    const q: Array<{ oid: string; distance: number }> = wants.map((w) => ({ oid: w, distance: 1 }));
    while (q.length > 0) {
      const item = q.shift()!;
      if (seen.has(item.oid)) continue;
      seen.set(item.oid, item.distance);
      const o = lookup(item.oid);
      if (o && o.type === 'commit') {
        for (const parent of parseCommit(o.data).parents) q.push({ oid: parent, distance: item.distance + 1 });
      }
    }
    return seen.get(oid) ?? Number.POSITIVE_INFINITY;
  }

  const objects: GitObject[] = [];
  for (const [oid, obj] of collected) {
    if (!held.has(oid)) objects.push(obj);
  }
  // Deterministic order: commits first (parents before children is not required), then by oid.
  objects.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  return { objects, shallow: shallowOut, unshallow };
}

function parseTreeOf(data: Buffer): Array<{ oid: string }> {
  const entries: Array<{ oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({ oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}

/** Add an object and its tree/blob closure (not commit parents) to the collection. */
function collectObject(repo: Repo, collected: Map<string, GitObject>, oid: string): void {
  const obj = repo.objects.get(oid);
  if (!obj || collected.has(oid)) return;
  collected.set(oid, obj);
  if (obj.type === 'commit') {
    collectObject(repo, collected, parseCommit(obj.data).tree);
  } else if (obj.type === 'tree') {
    for (const entry of parseTreeOf(obj.data)) collectObject(repo, collected, entry.oid);
  } else if (obj.type === 'tag') {
    collectObject(repo, collected, parseTag(obj.data).object);
  }
}

/** Wrap pack bytes in sideband band-1 pkt-lines (band byte + data <= 65516 payload bytes). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), pack])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return httpError(404, 'repository not found');
  let packets: PktLine[];
  try {
    packets = decodePktLines(body).packets;
  } catch (err) {
    return httpError(400, `bad pkt-line: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lines = dataLines(packets);
  if (lines.length === 0) return httpError(400, 'empty upload-pack request');
  const first = lines[0] ?? '';
  if (first.startsWith('command=ls-refs')) return handleLsRefs(repo, lines);
  if (first.startsWith('command=fetch')) return handleFetchV2(repo, lines);
  return handleFetchV0(repo, lines);
}

function handleLsRefs(repo: Repo, lines: string[]): GitResponse {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Array<string | 'flush'> = [];
  const refs = refAdvertisement(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip) {
    if (keep('HEAD')) out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
  }
  out.push('flush');
  return ok(UPLOAD_RESULT, encodePktLines(out));
}

function handleFetchV2(repo: Repo, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const out: Array<string | Buffer | 'flush' | 'delim'> = [];
  out.push('acknowledgments\n');
  if (haves.length === 0) {
    out.push('NAK\n');
  } else {
    for (const have of haves) {
      if (repo.objects.has(have)) out.push(`ACK ${have}\n`);
    }
    out.push('ready\n');
  }
  out.push('flush');
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push('shallow-info\n');
    for (const oid of plan.shallow) out.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) out.push(`unshallow ${oid}\n`);
    out.push('flush');
  }
  out.push('packfile\n');
  out.push(sidebandPack(pack));
  out.push('flush');
  return ok(UPLOAD_RESULT, encodePktLines(out));
}

function handleFetchV0(repo: Repo, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const out: Array<string | Buffer | 'flush'> = [];
  if (haves.length === 0) out.push('NAK\n');
  else {
    for (const have of haves) if (repo.objects.has(have)) out.push(`ACK ${have}\n`);
  }
  for (const oid of plan.shallow) out.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) out.push(`unshallow ${oid}\n`);
  out.push(sidebandPack(pack));
  out.push('flush');
  return ok(UPLOAD_RESULT, encodePktLines(out));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return httpError(404, 'repository not found');
  let packets: PktLine[];
  let packBytes: Buffer;
  try {
    const split = splitReceivePack(body);
    packets = split.packets;
    packBytes = split.pack;
  } catch (err) {
    return httpError(400, `bad pkt-line: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lines = dataLines(packets);
  const commands: PushCommand[] = [];
  let useSideband = false;
  let unpackError: string | null = null;
  for (const line of lines) {
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    if (nul >= 0) {
      const caps = line.slice(nul + 1).split(' ');
      if (caps.includes('side-band-64k')) useSideband = true;
    }
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isOid(oldOid) && isOid(newOid) && ref.startsWith('refs/')) {
      commands.push({ oldOid, newOid, ref });
    }
  }
  if (commands.length === 0) return httpError(400, 'no push commands');

  // Unpack the pack (when one was sent) into the repository's object store.
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError === null) {
    for (const command of commands) {
      results.push(applyPushCommand(repo, command));
    }
  } else {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: unpackError });
  }

  const inner: Array<string | 'flush'> = [];
  inner.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const result of results) {
    inner.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  inner.push('flush');
  const innerBytes = encodePktLines(inner);
  let responseBody: Buffer;
  if (useSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < innerBytes.length; offset += CHUNK) {
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), innerBytes.subarray(offset, offset + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = innerBytes;
  }
  return ok(RECEIVE_RESULT, responseBody);
}

function applyPushCommand(repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  const isBranch = ref.startsWith('refs/heads/');
  const isTag = ref.startsWith('refs/tags/');
  if (!isBranch && !isTag) return { ref, ok: false, reason: 'invalid ref' };
  if (current === undefined) {
    if (oldOid !== ZERO_OID) return { ref, ok: false, reason: 'non-fast-forward' };
  } else if (oldOid !== current) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  // Create or update: the new object must be present.
  const obj = repo.objects.get(newOid);
  if (!obj) return { ref, ok: false, reason: 'missing object' };
  if (current !== undefined && isBranch) {
    const lookup = repo.objects.get.bind(repo.objects);
    if (!isAncestor(lookup, current, newOid) && current !== newOid) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

// Re-exported for the router's content-type checks.
export { UPLOAD_AD, UPLOAD_RESULT, RECEIVE_AD, RECEIVE_RESULT };
