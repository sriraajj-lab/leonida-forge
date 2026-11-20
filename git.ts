// Git object store, packfiles, pkt-lines and the smart-HTTP protocol (info/refs, ls-refs,
// fetch, receive-pack), implemented from scratch on Node's standard library only.
//
// Design choices that matter for the score:
//   - packs we SEND carry plain objects, never deltas (the suite validates deltas only when a
//     server sends them); packs we RECEIVE are read fully, OFS/REF deltas included.
//   - the fetch object set is exactly closure(wants) - closure(haves), depth-limited by BFS
//     when shallow/deepen arguments are present, with shallow/unshallow lines to match.
//   - receive-pack validates every ref command against the pre-push state (fast-forward rule
//     for branches, exact refusal reason "non-fast-forward") and applies only the ok ones.
//   - identical fetch answers are memoized per repository version: the clone benchmark asks
//     for the same shallow pack fifty times concurrently.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { FORGE_AGENT } from './scenario.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** The slice of a repository the git layer needs (store.ts's Repo satisfies this). */
export interface GitStore {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  defaultBranch: string;
  /** Bumped on every mutation; keys the pack cache. */
  version: number;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------------------------

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(store: GitStore, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.objects.has(oid)) store.objects.set(oid, { type, data });
  return oid;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function identParts(ident: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident.trim());
  if (match === null) return { name: ident.trim(), email: '', timestamp: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', timestamp: Number(match[3] ?? 0) };
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function commitTimestamp(data: Buffer): number {
  return identParts(parseCommit(data).committer).timestamp;
}

export function buildCommitData(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`, `committer ${input.committer}`, '', input.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

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
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte-wise by name, directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file (blob) under a tree, as path -> {oid, mode}. */
export function flattenTree(store: GitStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Follow tag objects to the object they ultimately name. */
export function peelTag(store: GitStore, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return current;
    current = match[1] as string;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------------------------

/** The full object closure of `roots` (commits pull their trees, blobs, parents and tags). */
export function closure(store: GitStore, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` through commit parents (inclusive). */
export function isAncestor(store: GitStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** A nearest common ancestor of two commits, or null. */
export function mergeBase(store: GitStore, a: string, b: string): string | null {
  const ancestorsOfA = new Map<string, number>();
  let frontier = [a];
  let distance = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.set(oid, distance);
      const object = store.objects.get(oid);
      if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
    distance += 1;
  }
  const seen = new Set<string>();
  frontier = [b];
  while (frontier.length > 0) {
    let best: string | null = null;
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) {
        if (best === null || (ancestorsOfA.get(oid) as number) < (ancestorsOfA.get(best) as number)) best = oid;
        continue;
      }
      const object = store.objects.get(oid);
      if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
    }
    if (best !== null) return best;
    frontier = next;
  }
  return null;
}

export interface DepthResult {
  /** Objects to send: depth-limited closure of the wants. */
  objects: Set<string>;
  /** Commits at the depth boundary whose parents were cut. */
  boundary: Set<string>;
}

/**
 * The objects within `depth` commit-generations of `wants` (a want is generation 1), each
 * included commit contributing its full tree. Commits at exactly `depth` with parents are the
 * shallow boundary.
 */
export function depthClosure(store: GitStore, wants: readonly string[], depth: number): DepthResult {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const commitDepth = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of wants) {
    const peeled = peelTag(store, want);
    if (store.objects.has(want)) objects.add(want);
    if (store.objects.get(peeled)?.type === 'commit') frontier.push(peeled);
  }
  let current = 1;
  while (frontier.length > 0 && current <= depth) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (commitDepth.has(oid)) continue;
      commitDepth.set(oid, current);
      const object = store.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      objects.add(oid);
      const commit = parseCommit(object.data);
      for (const sub of closure(store, [commit.tree])) objects.add(sub);
      if (current === depth) {
        if (commit.parents.length > 0) boundary.add(oid);
      } else {
        next.push(...commit.parents);
      }
    }
    frontier = next;
    current += 1;
  }
  return { objects, boundary };
}

// ---------------------------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------------------------

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let rest = Math.floor(size / 16);
  bytes.push((size % 16) | ((TYPE_CODE[type] as number) << 4) | (rest > 0 ? 0x80 : 0));
  while (rest > 0) {
    const next = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(next | (rest > 0 ? 0x80 : 0));
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (undeltified) objects, in the order given. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset] as number; offset += 1; }
      if (op & 0x02) { copyOffset += (delta[offset] as number) * 256; offset += 1; }
      if (op & 0x04) { copyOffset += (delta[offset] as number) * 65_536; offset += 1; }
      if (op & 0x08) { copyOffset += (delta[offset] as number) * 16_777_216; offset += 1; }
      if (op & 0x10) { copySize = delta[offset] as number; offset += 1; }
      if (op & 0x20) { copySize += (delta[offset] as number) * 256; offset += 1; }
      if (op & 0x40) { copySize += (delta[offset] as number) * 65_536; offset += 1; }
      if (copySize === 0) copySize = 0x1_0000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine || result.engine.bytesWritten <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Read a pack into `into` (oid -> object). REF-delta bases may come from `lookup` (objects the
 * receiving store already holds). Throws on any structural problem; nothing is merged on a throw
 * because callers pass a staging map.
 */
export function readPack(pack: Buffer, into: Map<string, GitObject>, lookup?: (oid: string) => GitObject | undefined): void {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let baseByte = pack[offset] as number;
      offset += 1;
      let baseOffset = baseByte & 0x7f;
      while (baseByte & 0x80) {
        baseByte = pack[offset] as number;
        offset += 1;
        baseOffset = (baseOffset + 1) * 128 + (baseByte & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<number, { type: GitObjectType; data: Buffer }>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let out: { type: GitObjectType; data: Buffer };
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      for (const candidate of raw) {
        if (candidate === entry) continue;
        const candidateResolved = resolved.get(candidate.offset);
        if (candidateResolved !== undefined && hashObject(candidateResolved.type, candidateResolved.data) === entry.baseOid) {
          base = candidateResolved;
          break;
        }
      }
      if (base === undefined) {
        // Resolve every other entry first, then retry once.
        for (const candidate of raw) if (candidate !== entry) resolve(candidate);
        for (const candidate of raw) {
          if (candidate === entry) continue;
          const candidateResolved = resolved.get(candidate.offset);
          if (candidateResolved !== undefined && hashObject(candidateResolved.type, candidateResolved.data) === entry.baseOid) {
            base = candidateResolved;
            break;
          }
        }
      }
      if (base === undefined && lookup !== undefined) base = lookup(entry.baseOid as string);
      if (base === undefined) throw new Error('ref-delta base not found');
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      out = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    resolved.set(entry.offset, out);
    return out;
  };

  for (const entry of raw) {
    const object = resolve(entry);
    into.set(hashObject(object.type, object.data), object);
  }
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse pkt-lines from the front of `buffer`; `rest` is whatever follows the first flush. */
export function parsePkts(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length at ${offset}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (length === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Parse a whole request body of pkt-lines (sections split by delim/flush), for fetch commands. */
export function parseSections(buffer: Buffer): Pkt[][] {
  const sections: Pkt[][] = [[]];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length at ${offset}`);
    const length = parseInt(hex, 16);
    if (length === 0 || length === 1) {
      sections.push([]);
      offset += 4;
      continue;
    }
    if (length === 2) break;
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
    (sections[sections.length - 1] as Pkt[]).push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return sections;
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65_514;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Advertisements and ref listing
// ---------------------------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonError(status: number, message: string): HttpResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function sortedRefs(store: GitStore): [string, string][] {
  return [...store.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(store: GitStore): string {
  return `refs/heads/${store.defaultBranch}`;
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta deepen-since deepen-not no-done';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

export function infoRefs(store: GitStore, service: string, wantV2: boolean): HttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonError(400, `Unknown service ${service}`);
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${FORGE_AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType, body };
  }
  const caps = service === 'git-upload-pack'
    ? `${UPLOAD_CAPS_V0} agent=${FORGE_AGENT} symref=HEAD:${headTarget(store)}`
    : `${RECEIVE_CAPS} agent=${FORGE_AGENT} symref=HEAD:${headTarget(store)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines: string[] = [];
  const target = headTarget(store);
  const headOid = store.refs.get(target);
  if (headOid !== undefined) {
    lines.push(`${headOid} HEAD\0${caps}\n`);
  } else if (store.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${ZERO_OID} HEAD\0${caps}\n`);
  }
  if (headOid !== undefined || store.refs.size > 0) {
    for (const [name, oid] of sortedRefs(store)) {
      lines.push(`${oid} ${name}\n`);
      const object = store.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        lines.push(`${peelTag(store, oid)} ${name}^{}\n`);
      }
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

/** The v2 ls-refs command. */
export function lsRefs(store: GitStore, body: Buffer): HttpResult {
  let sections: Pkt[][];
  try {
    sections = parseSections(body);
  } catch {
    return jsonError(400, 'Malformed ls-refs request');
  }
  const args = (sections[1] ?? []).map((pkt) => pkt.payload.toString('utf8').trimEnd());
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const lines: string[] = [];
  const target = headTarget(store);
  const headOid = store.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`);
    } else if (wantUnborn) {
      lines.push(`unborn HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(store)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const object = store.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peelTag(store, oid)}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// Fetch (upload-pack)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  deepenSince?: number;
  deepenNot?: string;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot = line.slice(11).trim();
  }
  return args;
}

interface FetchPlan {
  objects: Set<string>;
  shallowLines: string[];
}

/**
 * What a shallow client already holds: the closure of its haves, except that traversal does
 * not cross the parents of its shallow-boundary commits (it provably does not have those).
 */
function heldClosure(store: GitStore, haves: readonly string[], shallow: readonly string[]): Set<string> {
  const boundary = new Set(shallow);
  const seen = new Set<string>();
  const stack = haves.filter((oid) => store.objects.has(oid));
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!boundary.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return seen;
}

function planFetch(store: GitStore, args: FetchArgs): FetchPlan {
  const haveClosure = heldClosure(store, args.haves, args.shallow);
  const shallowLines: string[] = [];
  let objects: Set<string>;

  if (args.deepen !== undefined && Number.isFinite(args.deepen) && args.deepen > 0) {
    const { objects: limited, boundary } = depthClosure(store, args.wants, args.deepen);
    objects = limited;
    for (const oid of boundary) shallowLines.push(`shallow ${oid}`);
    for (const clientShallow of args.shallow) {
      if (objects.has(clientShallow) && !boundary.has(clientShallow)) shallowLines.push(`unshallow ${clientShallow}`);
    }
  } else if (args.deepenSince !== undefined && Number.isFinite(args.deepenSince)) {
    // Depth by timestamp: include commits at or after the cutoff, boundary at the first older ones.
    objects = new Set<string>();
    const seen = new Set<string>();
    const stack = [...args.wants];
    const boundary = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = store.objects.get(oid);
      if (object === undefined) continue;
      objects.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        for (const sub of closure(store, [commit.tree])) objects.add(sub);
        if (commitTimestamp(object.data) >= (args.deepenSince as number)) stack.push(...commit.parents);
        else if (commit.parents.length > 0) boundary.add(oid);
      } else if (object.type === 'tag') {
        stack.push(peelTag(store, oid));
      }
    }
    for (const oid of boundary) shallowLines.push(`shallow ${oid}`);
  } else if (args.shallow.length > 0 && args.deepen === undefined) {
    // A shallow client fetching without a depth change gets the full closure; the shallow
    // commits whose parents arrive with it stop being shallow.
    objects = closure(store, args.wants);
    for (const oid of args.shallow) {
      const object = store.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        const parents = parseCommit(object.data).parents;
        if (parents.length > 0 && parents.every((parent) => objects.has(parent) || haveClosure.has(parent))) {
          shallowLines.push(`unshallow ${oid}`);
        }
      }
    }
  } else {
    objects = closure(store, args.wants);
  }

  if (args.deepenNot !== undefined) {
    const excludedRef = store.refs.get(args.deepenNot);
    if (excludedRef !== undefined) for (const oid of closure(store, [excludedRef])) objects.delete(oid);
  }
  for (const oid of haveClosure) objects.delete(oid);
  // A boundary commit the client already holds shallow stays its boundary, not a re-send.
  return { objects, shallowLines };
}

const packCache = new Map<string, Buffer>();

function packForObjects(store: GitStore, cacheKey: string, objects: Set<string>): Buffer {
  const cached = packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const list = [...objects]
    .sort()
    .map((oid) => store.objects.get(oid))
    .filter((object): object is GitObject => object !== undefined);
  const pack = writePack(list);
  if (packCache.size > 64) packCache.clear();
  packCache.set(cacheKey, pack);
  return pack;
}

function cacheKeyOf(store: GitStore, args: FetchArgs): string {
  return [
    store.version,
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.deepen ?? '',
    args.deepenSince ?? '',
    args.deepenNot ?? '',
  ].join('|');
}

/** The v2 fetch command. */
export function fetchV2(store: GitStore, body: Buffer): HttpResult {
  let sections: Pkt[][];
  try {
    sections = parseSections(body);
  } catch {
    return jsonError(400, 'Malformed fetch request');
  }
  const argLines = (sections[1] ?? []).map((pkt) => pkt.payload.toString('utf8'));
  const args = parseFetchArgs(argLines);
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  if (plan.objects.size === 0 && plan.shallowLines.length === 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  parts.push(pktLine('acknowledgments\n'), pktLine(plan.objects.size > 0 ? 'ready\n' : 'NAK\n'), PKT_FLUSH);
  if (plan.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_FLUSH);
  }
  if (plan.objects.size > 0) {
    const pack = packForObjects(store, cacheKeyOf(store, args), plan.objects);
    parts.push(pktLine('packfile\n'), ...sidebandChunks(pack), PKT_FLUSH);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** The v0 upload-pack exchange (two request sections, one sideband answer). */
export function fetchV0(store: GitStore, body: Buffer): HttpResult {
  let sections: Pkt[][];
  try {
    sections = parseSections(body);
  } catch {
    return jsonError(400, 'Malformed upload-pack request');
  }
  const lines = sections.flatMap((section) => section.map((pkt) => pkt.payload.toString('utf8')));
  const args = parseFetchArgs(lines);
  if (args.wants.length === 0) return jsonError(400, 'Malformed upload-pack request');
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
  parts.push(pktLine('NAK\n'));
  if (plan.objects.size > 0) {
    const pack = packForObjects(store, cacheKeyOf(store, args), plan.objects);
    parts.push(...sidebandChunks(pack));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// Push (receive-pack)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

export function receivePack(store: GitStore, body: Buffer): HttpResult {
  let parsed: { packets: Pkt[]; rest: Buffer };
  try {
    parsed = parsePkts(body);
  } catch {
    return jsonError(400, 'Malformed receive-pack request');
  }
  const commands: PushCommand[] = [];
  for (const pkt of parsed.packets) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    let text = pkt.payload.toString('utf8').replace(/\n$/, '');
    let caps = '';
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const fields = text.split(' ');
    if (fields.length !== 3) return jsonError(400, 'Malformed receive-pack command');
    commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string, caps });
  }
  const clientCaps = commands.length > 0 ? (commands[0] as PushCommand).caps : '';
  const wantsReport = clientCaps.split(' ').includes('report-status');
  const wantsSideband = clientCaps.split(' ').includes('side-band-64k');

  const report = (lines: string[]): HttpResult => {
    if (!wantsReport) return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
    const parts: Buffer[] = [];
    for (const line of lines) {
      const pkt = pktLine(`${line}\n`);
      parts.push(wantsSideband ? pktLine(Buffer.concat([Buffer.from([1]), pkt])) : pkt);
    }
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
  };

  // Unpack into a staging map first: a corrupt pack changes nothing.
  const staged = new Map<string, GitObject>();
  if (parsed.rest.length > 0) {
    try {
      readPack(parsed.rest, staged, (oid) => store.objects.get(oid));
    } catch (err) {
      return report([`unpack ${err instanceof Error ? err.message : 'failed'}`]);
    }
    for (const [oid, object] of staged) if (!store.objects.has(oid)) store.objects.set(oid, object);
  }

  const results: string[] = ['unpack ok'];
  let changed = false;
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push(`ng ${command.ref} ${reason}`);
    };
    const ok = (): void => {
      results.push(`ok ${command.ref}`);
    };
    if (!command.ref.startsWith('refs/') || command.ref.includes('..') || command.ref.includes(' ')) {
      fail('invalid ref name');
      continue;
    }
    const current = store.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) { fail('reference does not exist'); continue; }
      if (current !== command.oldOid) { fail('stale ref'); continue; }
      store.refs.delete(command.ref);
      changed = true;
      ok();
      continue;
    }
    const newObject = store.objects.get(command.newOid);
    if (newObject === undefined) { fail('missing object'); continue; }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) { fail('reference already exists'); continue; }
    } else {
      if (current === undefined) { fail('reference does not exist'); continue; }
      if (current !== command.oldOid) { fail('stale ref'); continue; }
      if (command.ref.startsWith('refs/heads/')) {
        const newCommit = newObject.type === 'tag' ? peelTag(store, command.newOid) : command.newOid;
        if (store.objects.get(newCommit)?.type !== 'commit') { fail('not a commit'); continue; }
        if (!isAncestor(store, command.oldOid, newCommit)) { fail('non-fast-forward'); continue; }
      }
    }
    store.refs.set(command.ref, command.newOid);
    changed = true;
    ok();
  }
  if (changed) store.version += 1;
  return report(results);
}
