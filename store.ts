// The forge's domain state: repositories (with their git object stores), issues, pull
// requests, labels and comments — one in-memory store shared by REST, GraphQL, MCP and git.
//
// Determinism rules the whole design:
//   - a logical clock starts at 2025-01-01T00:00:00Z and advances one second per mutation, so
//     every created_at/updated_at/merged_at and every API-created commit timestamp is a pure
//     function of the request sequence;
//   - ids come from sequential counters, never from a clock or a random source;
//   - issues and pull requests share one per-repository number counter (GitHub's semantics),
//     while the REST issue list still excludes pull requests.

import {
  buildCommitData,
  buildTreeData,
  flattenTree,
  mergeBase,
  parseCommit,
  parseTree,
  peelTag,
  storeObject,
  type GitObject,
  type GitStore,
  type TreeEntry,
} from './git.ts';
import { VIEWER } from './scenario.ts';

/** An error that maps straight onto an HTTP status + GitHub-shaped {message} body. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdEpoch: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdEpoch: number;
  updatedEpoch: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedEpoch: number | null;
  createdEpoch: number;
  updatedEpoch: number;
}

export class Repo implements GitStore {
  id = 0;
  owner = VIEWER.login;
  name = '';
  isPrivate = false;
  description = '';
  defaultBranch = 'main';
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  version = 0;
  nextNumber = 1;
  nextCommentId = 1;
  issues = new Map<number, IssueRec>();
  pulls = new Map<number, PullRec>();
  labels = new Map<string, LabelRec>();
  createdEpoch = 0;
  updatedEpoch = 0;

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }
}

const CLOCK_BASE = 1_735_689_600; // 2025-01-01T00:00:00Z

export class Forge {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private clock = CLOCK_BASE;

  /** Advance the logical clock and return the new epoch second. */
  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  /** The next global object id (issues and pull requests share GitHub's id space). */
  allocObjectId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo();
    repo.id = this.nextRepoId;
    this.nextRepoId += 1;
    repo.name = name;
    repo.isPrivate = isPrivate;
    repo.description = description;
    repo.createdEpoch = this.tick();
    repo.updatedEpoch = repo.createdEpoch;
    this.repos.set(name, repo);
    return repo;
  }

  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** The viewer's git identity line at a logical timestamp. */
export function viewerIdent(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
}

// ---------------------------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: isoOf(repo.createdEpoch),
    updated_at: isoOf(repo.updatedEpoch),
    html_url: `/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, default: false };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: '000000' })),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdEpoch),
    updated_at: isoOf(issue.updatedEpoch),
    html_url: `/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issueNumber}:${comment.id}`),
    body: comment.body,
    created_at: isoOf(comment.createdEpoch),
    updated_at: isoOf(comment.createdEpoch),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    html_url: `/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedEpoch === null ? null : isoOf(pull.mergedEpoch),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: isoOf(pull.createdEpoch),
    updated_at: isoOf(pull.updatedEpoch),
    html_url: `/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

/** Relay-style global ids: base64 of "Type:key" — opaque, stable, and decodable by node(id:). */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split <= 0) return null;
    return { type: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

export function createIssue(forge: Forge, repo: Repo, input: { title: string; body?: string; labels?: string[] }): IssueRec {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
  }
  const now = forge.tick();
  const issue: IssueRec = {
    id: forge.allocObjectId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdEpoch: now,
    updatedEpoch: now,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(forge: Forge, repo: Repo, issue: IssueRec, body: string): CommentRec {
  const comment: CommentRec = { id: repo.nextCommentId, body, createdEpoch: forge.tick() };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  issue.updatedEpoch = comment.createdEpoch;
  return comment;
}

// ---------------------------------------------------------------------------------------------
// Trees and the contents API
// ---------------------------------------------------------------------------------------------

/** The commit a ref names: a branch name, a tag, or a raw sha; undefined when unresolvable. */
export function resolveCommit(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') {
    return repo.branchTip(repo.defaultBranch);
  }
  const branch = repo.branchTip(ref);
  if (branch !== undefined) return peelTag(repo, branch);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelTag(repo, tag);
  const anyRef = repo.refs.get(ref);
  if (anyRef !== undefined) return peelTag(repo, anyRef);
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return peelTag(repo, ref);
  return undefined;
}

function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

export interface PathHit {
  oid: string;
  mode: string;
  isTree: boolean;
}

/** Walk a tree to `path`; null when any segment is missing. */
export function lookupPath(repo: Repo, treeOid: string, path: string): PathHit | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode, isTree: entry.mode === '40000' };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { oid: current, mode: '40000', isTree: true };
}

/** Rebuild the tree chain with `segments` set to (blobOid, mode), or removed when blobOid is null. */
function setPath(repo: Repo, treeOid: string | null, segments: string[], leaf: { oid: string; mode: string } | null): string {
  const entries = new Map<string, TreeEntry>();
  if (treeOid !== null) {
    const tree = repo.objects.get(treeOid);
    if (tree !== undefined && tree.type === 'tree') {
      for (const entry of parseTree(tree.data)) entries.set(entry.name, entry);
    }
  }
  const head = segments[0] as string;
  if (segments.length === 1) {
    if (leaf === null) entries.delete(head);
    else entries.set(head, { mode: leaf.mode, name: head, oid: leaf.oid });
  } else {
    const existing = entries.get(head);
    const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
    const newChild = setPath(repo, childTree, segments.slice(1), leaf);
    entries.set(head, { mode: '40000', name: head, oid: newChild });
  }
  return storeObject(repo, 'tree', buildTreeData([...entries.values()]));
}

/** Create a commit on `branch` from a new tree; returns the commit oid. */
export function commitOnBranch(forge: Forge, repo: Repo, branch: string, treeOid: string, message: string, parents?: string[]): string {
  const tip = repo.branchTip(branch);
  const parentList = parents ?? (tip !== undefined ? [peelTag(repo, tip)] : []);
  const ident = viewerIdent(forge.tick());
  const data = buildCommitData({ tree: treeOid, parents: parentList, author: ident, committer: ident, message });
  const oid = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.version += 1;
  return oid;
}

export interface ContentsWriteResult {
  blobOid: string;
  commitOid: string;
  created: boolean;
}

export function putContents(
  forge: Forge,
  repo: Repo,
  path: string,
  content: Buffer,
  message: string,
  branch: string | undefined,
  sha: string | undefined,
): ContentsWriteResult {
  const branchName = branch ?? repo.defaultBranch;
  const tip = repo.branchTip(branchName);
  // A branch the contents route creates starts from the default branch's tip and tree.
  const baseCommit = tip !== undefined
    ? peelTag(repo, tip)
    : branchName !== repo.defaultBranch
      ? repo.branchTip(repo.defaultBranch) !== undefined
        ? peelTag(repo, repo.branchTip(repo.defaultBranch) as string)
        : undefined
      : undefined;
  const baseTree = baseCommit !== undefined ? treeOfCommit(repo, baseCommit) : null;
  const existing = baseTree !== null ? lookupPath(repo, baseTree, path) : null;
  if (existing !== null && existing.isTree) throw new HttpError(422, `Validation Failed: ${path} is a directory`);
  if (existing !== null && tip !== undefined) {
    if (sha === undefined) throw new HttpError(422, 'Validation Failed: sha must be supplied when updating a file');
    if (sha !== existing.oid) throw new HttpError(409, `${path} does not match ${sha}`);
  }
  const blobOid = storeObject(repo, 'blob', content);
  const mode = existing !== null ? existing.mode : '100644';
  const newTree = setPath(repo, baseTree, path.split('/').filter((s) => s !== ''), { oid: blobOid, mode });
  const parents = baseCommit !== undefined ? [baseCommit] : [];
  const commitOid = commitOnBranch(forge, repo, branchName, newTree, message, parents);
  return { blobOid, commitOid, created: existing === null };
}

export function deleteContents(forge: Forge, repo: Repo, path: string, message: string, branch: string | undefined, sha: string): string {
  const branchName = branch ?? repo.defaultBranch;
  const tip = repo.branchTip(branchName);
  if (tip === undefined) throw new HttpError(404, 'Not Found');
  const baseTree = treeOfCommit(repo, peelTag(repo, tip));
  if (baseTree === null) throw new HttpError(404, 'Not Found');
  const existing = lookupPath(repo, baseTree, path);
  if (existing === null || existing.isTree) throw new HttpError(404, 'Not Found');
  if (sha !== existing.oid) throw new HttpError(409, `${path} does not match ${sha}`);
  const newTree = setPath(repo, baseTree, path.split('/').filter((s) => s !== ''), null);
  return commitOnBranch(forge, repo, branchName, newTree, message);
}

export interface ContentsRead {
  kind: 'file' | 'dir';
  entries?: { name: string; path: string; sha: string; type: 'file' | 'dir' }[];
  file?: { name: string; path: string; sha: string; size: number; contentB64: string };
}

export function getContents(repo: Repo, path: string, ref: string | undefined): ContentsRead | null {
  const commitOid = resolveCommit(repo, ref);
  if (commitOid === undefined) return null;
  const treeOid = treeOfCommit(repo, commitOid);
  if (treeOid === null) return null;
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined) return null;
    return {
      kind: 'dir',
      entries: parseTree(tree.data).map((entry) => ({
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      })),
    };
  }
  const hit = lookupPath(repo, treeOid, clean);
  if (hit === null) return null;
  if (hit.isTree) {
    const tree = repo.objects.get(hit.oid);
    if (tree === undefined || tree.type !== 'tree') return null;
    return {
      kind: 'dir',
      entries: parseTree(tree.data).map((entry) => ({
        name: entry.name,
        path: `${clean}/${entry.name}`,
        sha: entry.oid,
        type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      })),
    };
  }
  const blob = repo.objects.get(hit.oid);
  if (blob === undefined) return null;
  const name = clean.split('/').pop() as string;
  return { kind: 'file', file: { name, path: clean, sha: hit.oid, size: blob.data.length, contentB64: blob.data.toString('base64') } };
}

/** Commits reachable from `startOid`, newest first (DFS pre-order, parents in order). */
export function listCommits(repo: Repo, startOid: string): { sha: string; data: Buffer }[] {
  const out: { sha: string; data: Buffer }[] = [];
  const seen = new Set<string>();
  const stack = [startOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push({ sha: oid, data: object.data });
    const parents = parseCommit(object.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index] as string);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pull requests: files, mergeability, merge
// ---------------------------------------------------------------------------------------------

export function createPull(forge: Forge, repo: Repo, input: { title: string; body?: string; head: string; base: string }): PullRec {
  const headTip = repo.branchTip(input.head);
  const baseTip = repo.branchTip(input.base);
  if (headTip === undefined || baseTip === undefined) {
    throw new HttpError(422, 'Validation Failed: head or base branch does not exist');
  }
  if (input.head === input.base) throw new HttpError(422, 'Validation Failed: head and base are the same');
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      throw new HttpError(422, `Validation Failed: a pull request already exists for ${input.head}`);
    }
  }
  const now = forge.tick();
  const pull: PullRec = {
    id: forge.allocObjectId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headSha: peelTag(repo, headTip),
    baseSha: peelTag(repo, baseTip),
    merged: false,
    mergeCommitSha: null,
    mergedEpoch: null,
    createdEpoch: now,
    updatedEpoch: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Line counts of a text diff via LCS (files in play are small). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? (dp[(i + 1) * (n + 1) + (j + 1)] as number) + 1
        : Math.max(dp[(i + 1) * (n + 1) + j] as number, dp[i * (n + 1) + (j + 1)] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: n - common, deletions: m - common };
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function flatAt(repo: Repo, commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
  if (commitOid === undefined) return new Map();
  const tree = treeOfCommit(repo, commitOid);
  if (tree === null) return new Map();
  return flattenTree(repo, tree);
}

function blobText(repo: Repo, oid: string | undefined): string {
  if (oid === undefined) return '';
  return repo.objects.get(oid)?.data.toString('utf8') ?? '';
}

/** The changed files of a pull request: head tree vs the merge-base tree. */
export function pullFiles(repo: Repo, pull: PullRec): PullFile[] {
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo, peelTag(repo, headTip), peelTag(repo, baseTip));
  const baseFlat = flatAt(repo, base ?? undefined);
  const headFlat = flatAt(repo, peelTag(repo, headTip));
  const files: PullFile[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before?.oid === after?.oid) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const { additions, deletions } = lineDiff(blobText(repo, before?.oid), blobText(repo, after?.oid));
    files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return files;
}

/** File-level three-way merge of head into base; null when any path conflicts. */
function threeWayMerge(repo: Repo, headTip: string, baseTip: string): Map<string, { oid: string; mode: string }> | null {
  const base = mergeBase(repo, headTip, baseTip);
  const ancestorFlat = flatAt(repo, base ?? undefined);
  const headFlat = flatAt(repo, headTip);
  const baseFlat = flatAt(repo, baseTip);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path);
    const head = headFlat.get(path);
    const current = baseFlat.get(path);
    if (head?.oid === current?.oid) {
      if (head !== undefined) merged.set(path, head);
    } else if (head?.oid === ancestor?.oid) {
      if (current !== undefined) merged.set(path, current);
    } else if (current?.oid === ancestor?.oid) {
      if (head !== undefined) merged.set(path, head);
    } else {
      return null;
    }
  }
  return merged;
}

/** Build (and store) the tree for a flattened path map. */
export function treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

/** Whether the pull request's head merges cleanly into its base right now. */
export function pullMergeable(repo: Repo, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  return threeWayMerge(repo, peelTag(repo, headTip), peelTag(repo, baseTip)) !== null;
}

/** Merge a pull request into its base branch. Throws HttpError(405) when not mergeable. */
export function mergePull(forge: Forge, repo: Repo, pull: PullRec, method: string): { sha: string } {
  if (pull.merged) throw new HttpError(405, 'Pull Request is already merged');
  if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not open');
  const headTip = peelTag(repo, repo.branchTip(pull.headRef) ?? pull.headSha);
  const baseTip = peelTag(repo, repo.branchTip(pull.baseRef) ?? pull.baseSha);
  const mergedFlat = threeWayMerge(repo, headTip, baseTip);
  if (mergedFlat === null) throw new HttpError(405, 'Pull Request is not mergeable');
  const tree = treeFromFlat(repo, mergedFlat);
  const ident = viewerIdent(forge.tick());
  let message: string;
  let parents: string[];
  if (method === 'merge') {
    parents = [baseTip, headTip];
    message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  } else {
    // squash (and rebase, approximated as squash): one parent, the base tip.
    parents = [baseTip];
    message = `${pull.title} (#${pull.number})\n\n${pull.body}\n`;
  }
  const data = buildCommitData({ tree, parents, author: ident, committer: ident, message });
  const sha = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  repo.version += 1;
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.mergedEpoch = forge.tick();
  pull.updatedEpoch = pull.mergedEpoch;
  return { sha };
}

/** Total git objects held across repositories (diagnostics only). */
export function allObjectCount(forge: Forge): number {
  let total = 0;
  for (const repo of forge.repos.values()) total += repo.objects.size;
  return total;
}
