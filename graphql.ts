// A small GraphQL executor for the document shapes `gh` and github-mcp-server send:
// viewer/repository reads, issue and pull-request connections with cursor pagination, the
// create/close/merge/addComment mutations, Relay node(id:) and the __type introspection
// probes. No library: a tokenizer, a parser (aliases, variables, input objects, enum
// literals, inline and named fragments, operation batching) and typed resolvers over the
// same store REST uses. Unknown fields answer HTTP 200 with an errors array naming the
// field, as GitHub does.

import {
  addComment,
  createIssue,
  createPull,
  decodeGlobalId,
  globalId,
  isoOf,
  mergePull,
  pullFiles,
  pullMergeable,
  type CommentRec,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: [string, Value][] };

interface FieldNode {
  name: string;
  alias?: string;
  args: [string, Value][];
  selection?: Selection[];
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition?: string; selection: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition?: string; selection: Selection[] }>;
}

class GqlSyntaxError extends Error {}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if ('{}()[]:$!@=|&'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '.' && input.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push(`"${input.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'u' ? String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${ch}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }

  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') this.skipParens();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition?: string; selection: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        const after = this.peek();
        if (after !== undefined && after !== '(' && after !== '{' && after !== '@') name = this.next();
        if (this.peek() === '(') this.skipParens(); // variable definitions
        this.skipDirectives();
        operations.push({ type: type === 'subscription' ? 'query' : type, name, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new GqlSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.next();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: [string, Value][] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push([argName, this.parseValue()]);
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selection = this.peek() === '{' ? this.parseSelectionSet() : undefined;
    const field: FieldNode = { name, args };
    if (alias !== undefined) field.alias = alias;
    if (selection !== undefined) field.selection = selection;
    return { kind: 'field', field };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: [string, Value][] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push([name, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: parseInt(token, 10) };
    if (/^-?\d*\.\d+/.test(token) || /^-?\d+(\.\d+)?[eE]/.test(token)) return { kind: 'float', value: parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': return variables[value.name];
    case 'string': case 'enum': return value.value;
    case 'int': case 'float': case 'bool': return value.value;
    case 'null': return null;
    case 'list': return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, sub] of value.fields) out[name] = evalValue(sub, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Schema (for introspection) and typed values
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId', 'isViewer'],
  Organization: ['id', 'login', 'name', 'url', 'avatarUrl', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'isFork', 'createdAt', 'updatedAt', 'pushedAt', 'url', 'resourcePath', 'labels', 'stargazerCount', 'forkCount'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'resourcePath', 'viewerCanReact'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'resourcePath', 'mergeCommit', 'additions', 'deletions', 'changedFiles'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Commit: ['id', 'oid', 'message', 'committedDate', 'author'],
  GitActor: ['name', 'email', 'date', 'avatarUrl'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  IssueCommentEdge: ['node', 'cursor'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'nodeCount', 'used'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives', 'description'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  PullRequestChangedFileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

type GValue =
  | { t: 'Viewer' }
  | { t: 'Repo'; repo: Repo }
  | { t: 'Ref'; name: string }
  | { t: 'Issue'; repo: Repo; issue: IssueRec }
  | { t: 'Pull'; repo: Repo; pull: PullRec }
  | { t: 'Comment'; repo: Repo; issueNumber: number; comment: CommentRec }
  | { t: 'IssueConnection'; repo: Repo; items: IssueRec[]; hasNextPage: boolean; endCursor: string | null; total: number }
  | { t: 'PullConnection'; repo: Repo; items: PullRec[]; total: number }
  | { t: 'FilesConnection'; files: { path: string; additions: number; deletions: number; changeType: string }[] }
  | { t: 'CommentConnection'; repo: Repo; issueNumber: number; items: CommentRec[] }
  | { t: 'LabelConnection'; labels: { name: string; color: string }[] }
  | { t: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { t: 'Payload'; name: string; repo?: Repo; issue?: IssueRec; pull?: PullRec; comment?: CommentRec; issueNumber?: number }
  | { t: 'CommentEdge'; repo: Repo; issueNumber: number; comment: CommentRec }
  | { t: 'Edge'; node: GValue; cursor: string }
  | { t: 'Type'; name: string }
  | { t: 'FieldDef'; name: string }
  | { t: 'EnumValueDef'; name: string }
  | { t: 'Schema' }
  | { t: 'Label'; name: string; color: string }
  | string
  | number
  | boolean
  | null;

function typeNameOf(value: GValue): string {
  if (value === null || typeof value !== 'object') return 'String';
  switch (value.t) {
    case 'Viewer': return 'User';
    case 'Repo': return 'Repository';
    case 'Ref': return 'Ref';
    case 'Issue': return 'Issue';
    case 'Pull': return 'PullRequest';
    case 'Comment': return 'IssueComment';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullConnection': return 'PullRequestConnection';
    case 'FilesConnection': return 'PullRequestChangedFileConnection';
    case 'CommentConnection': return 'IssueCommentConnection';
    case 'LabelConnection': return 'LabelConnection';
    case 'PageInfo': return 'PageInfo';
    case 'Payload':
      return value.name === 'createIssue' ? 'CreateIssuePayload'
        : value.name === 'closeIssue' ? 'CloseIssuePayload'
        : value.name === 'createPullRequest' ? 'CreatePullRequestPayload'
        : value.name === 'mergePullRequest' ? 'MergePullRequestPayload'
        : 'AddCommentPayload';
    case 'CommentEdge': return 'IssueCommentEdge';
    case 'Edge': return 'Edge';
    case 'Type': return '__Type';
    case 'FieldDef': return '__Field';
    case 'EnumValueDef': return '__EnumValue';
    case 'Schema': return '__Schema';
    case 'Label': return 'Label';
  }
}

class GqlFieldError extends Error {}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function repoFromGlobalId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  return forge.repoById(Number(decoded.key)) ?? null;
}

function issueFromGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = forge.repoById(Number(repoId));
  const issue = repo?.issues.get(Number(number));
  return repo !== undefined && issue !== undefined ? { repo, issue } : null;
}

function pullFromGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = forge.repoById(Number(repoId));
  const pull = repo?.pulls.get(Number(number));
  return repo !== undefined && pull !== undefined ? { repo, pull } : null;
}

function orderedIssues(repo: Repo, args: Map<string, unknown>): IssueRec[] {
  let items = [...repo.issues.values()];
  const states = args.get('states');
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  const field = orderBy?.field ?? 'CREATED_AT';
  const keyOf = (issue: IssueRec): number => field === 'UPDATED_AT' ? issue.updatedEpoch : field === 'COMMENTS' ? issue.comments.length : issue.createdEpoch;
  if (orderBy === undefined) {
    items.sort((a, b) => a.number - b.number);
  } else {
    items.sort((a, b) => {
      const byKey = (keyOf(a) - keyOf(b)) * direction;
      return byKey !== 0 ? byKey : (a.number - b.number) * direction;
    });
  }
  return items;
}

function issueConnection(repo: Repo, args: Map<string, unknown>): GValue {
  const all = orderedIssues(repo, args);
  let start = 0;
  const after = args.get('after');
  if (typeof after === 'string' && after !== '') {
    const number = numberFromCursor(after);
    if (number !== null) {
      const index = all.findIndex((issue) => issue.number === number);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : all.length;
  const page = all.slice(start, start + Math.max(0, first));
  return {
    t: 'IssueConnection',
    repo,
    items: page,
    hasNextPage: start + page.length < all.length,
    endCursor: page.length > 0 ? cursorOf((page[page.length - 1] as IssueRec).number) : null,
    total: all.length,
  };
}

/** Resolve one field on one typed value. Throws GqlFieldError for unknown fields. */
function resolveField(ctx: Ctx, value: GValue, field: string, args: Map<string, unknown>): unknown {
  const forge = ctx.forge;
  if (value !== null && typeof value === 'object') {
    switch (value.t) {
      case 'Viewer':
        switch (field) {
          case 'login': return VIEWER.login;
          case 'id': return globalId('User', VIEWER.login);
          case 'name': return VIEWER.name;
          case 'email': return VIEWER.email;
          case 'databaseId': return VIEWER.id;
          case 'url': return `/${VIEWER.login}`;
          case 'avatarUrl': return '';
          case 'isViewer': return true;
        }
        break;
      case 'Repo': {
        const repo = value.repo;
        switch (field) {
          case 'id': return globalId('Repository', String(repo.id));
          case 'databaseId': return repo.id;
          case 'name': return repo.name;
          case 'nameWithOwner': return repo.fullName;
          case 'owner': return { t: 'Viewer' } as GValue;
          case 'defaultBranchRef': {
            const tip = repo.branchTip(repo.defaultBranch);
            return tip === undefined ? null : ({ t: 'Ref', name: repo.defaultBranch } as GValue);
          }
          case 'viewerPermission': return 'ADMIN';
          case 'hasIssuesEnabled': return true;
          case 'description': return repo.description;
          case 'isPrivate': return repo.isPrivate;
          case 'isFork': return false;
          case 'createdAt': return isoOf(repo.createdEpoch);
          case 'updatedAt': return isoOf(repo.updatedEpoch);
          case 'pushedAt': return isoOf(repo.updatedEpoch);
          case 'url': return `/${repo.fullName}`;
          case 'resourcePath': return `/${repo.fullName}`;
          case 'stargazerCount': return 0;
          case 'forkCount': return 0;
          case 'issue': {
            const number = Number(args.get('number'));
            const issue = repo.issues.get(number);
            return issue === undefined ? null : ({ t: 'Issue', repo, issue } as GValue);
          }
          case 'issues': return issueConnection(repo, args);
          case 'pullRequest': {
            const number = Number(args.get('number'));
            const pull = repo.pulls.get(number);
            return pull === undefined ? null : ({ t: 'Pull', repo, pull } as GValue);
          }
          case 'pullRequests': {
            let items = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
            const states = args.get('states');
            if (Array.isArray(states) && states.length > 0) {
              const wanted = new Set(states.map((state) => String(state)));
              items = [...repo.pulls.values()].filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
            }
            items.sort((a, b) => a.number - b.number);
            const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
            return { t: 'PullConnection', repo, items: items.slice(0, Math.max(0, first)), total: items.length } as GValue;
          }
        }
        break;
      }
      case 'Ref':
        switch (field) {
          case 'name': return value.name;
          case 'prefix': return 'refs/heads/';
          case 'id': return globalId('Ref', value.name);
        }
        break;
      case 'Issue': {
        const { repo, issue } = value;
        switch (field) {
          case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
          case 'databaseId': return issue.id;
          case 'number': return issue.number;
          case 'title': return issue.title;
          case 'body': case 'bodyText': return issue.body;
          case 'state': return issue.state.toUpperCase();
          case 'closed': return issue.state === 'closed';
          case 'createdAt': return isoOf(issue.createdEpoch);
          case 'updatedAt': return isoOf(issue.updatedEpoch);
          case 'closedAt': return issue.state === 'closed' ? isoOf(issue.updatedEpoch) : null;
          case 'url': return `/${repo.fullName}/issues/${issue.number}`;
          case 'resourcePath': return `/${repo.fullName}/issues/${issue.number}`;
          case 'author': return { t: 'Viewer' } as GValue;
          case 'repository': return { t: 'Repo', repo } as GValue;
          case 'labels': return {
            t: 'LabelConnection',
            labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
          } as GValue;
          case 'comments': return { t: 'CommentConnection', repo, issueNumber: issue.number, items: issue.comments } as GValue;
          case 'viewerCanReact': return false;
        }
        break;
      }
      case 'Pull': {
        const { repo, pull } = value;
        switch (field) {
          case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
          case 'databaseId': return pull.id;
          case 'number': return pull.number;
          case 'title': return pull.title;
          case 'body': case 'bodyText': return pull.body;
          case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
          case 'merged': return pull.merged;
          case 'mergedAt': return pull.mergedEpoch === null ? null : isoOf(pull.mergedEpoch);
          case 'mergeable': return pull.merged || pull.state !== 'open' ? 'UNKNOWN' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
          case 'headRefName': return pull.headRef;
          case 'baseRefName': return pull.baseRef;
          case 'closed': return pull.state === 'closed';
          case 'closedAt': return pull.state === 'closed' ? isoOf(pull.updatedEpoch) : null;
          case 'createdAt': return isoOf(pull.createdEpoch);
          case 'updatedAt': return isoOf(pull.updatedEpoch);
          case 'url': return `/${repo.fullName}/pull/${pull.number}`;
          case 'resourcePath': return `/${repo.fullName}/pull/${pull.number}`;
          case 'author': return { t: 'Viewer' } as GValue;
          case 'repository': return { t: 'Repo', repo } as GValue;
          case 'mergeCommit': return null;
          case 'files': {
            const files = pullFiles(repo, pull).map((file) => ({
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
            }));
            const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : files.length;
            return { t: 'FilesConnection', files: files.slice(0, Math.max(0, first)) } as GValue;
          }
        }
        break;
      }
      case 'Comment': {
        const { repo, issueNumber, comment } = value;
        switch (field) {
          case 'id': return globalId('IssueComment', `${repo.id}:${issueNumber}:${comment.id}`);
          case 'databaseId': return comment.id;
          case 'body': case 'bodyText': return comment.body;
          case 'createdAt': return isoOf(comment.createdEpoch);
          case 'updatedAt': return isoOf(comment.createdEpoch);
          case 'author': return { t: 'Viewer' } as GValue;
          case 'url': return `/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`;
        }
        break;
      }
      case 'IssueConnection':
        switch (field) {
          case 'nodes': return value.items.map((issue) => ({ t: 'Issue', repo: value.repo, issue } as GValue));
          case 'edges': return value.items.map((issue) => ({ t: 'Edge', node: { t: 'Issue', repo: value.repo, issue } as GValue, cursor: cursorOf(issue.number) } as GValue));
          case 'pageInfo': return {
            t: 'PageInfo',
            hasNextPage: value.hasNextPage,
            hasPreviousPage: false,
            startCursor: value.items.length > 0 ? cursorOf((value.items[0] as IssueRec).number) : null,
            endCursor: value.endCursor,
          } as GValue;
          case 'totalCount': return value.total;
        }
        break;
      case 'PullConnection':
        switch (field) {
          case 'nodes': return value.items.map((pull) => ({ t: 'Pull', repo: value.repo, pull } as GValue));
          case 'edges': return value.items.map((pull) => ({ t: 'Edge', node: { t: 'Pull', repo: value.repo, pull } as GValue, cursor: cursorOf(pull.number) } as GValue));
          case 'pageInfo': return { t: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } as GValue;
          case 'totalCount': return value.total;
        }
        break;
      case 'FilesConnection':
        switch (field) {
          case 'nodes': return value.files.map((file) => ({ t: 'PullFile', ...file } as unknown as GValue));
          case 'totalCount': return value.files.length;
          case 'pageInfo': return { t: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } as GValue;
        }
        break;
      case 'CommentConnection':
        switch (field) {
          case 'nodes': return value.items.map((comment) => ({ t: 'Comment', repo: value.repo, issueNumber: value.issueNumber, comment } as GValue));
          case 'totalCount': return value.items.length;
          case 'pageInfo': return { t: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } as GValue;
        }
        break;
      case 'LabelConnection':
        switch (field) {
          case 'nodes': return value.labels.map((label) => ({ t: 'Label', name: label.name, color: label.color } as GValue));
          case 'edges': return value.labels.map((label) => ({ t: 'Edge', node: { t: 'Label', name: label.name, color: label.color } as GValue, cursor: cursorOf(0) } as GValue));
          case 'totalCount': return value.labels.length;
          case 'pageInfo': return { t: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } as GValue;
        }
        break;
      case 'PageInfo':
        switch (field) {
          case 'hasNextPage': return value.hasNextPage;
          case 'hasPreviousPage': return value.hasPreviousPage;
          case 'startCursor': return value.startCursor;
          case 'endCursor': return value.endCursor;
        }
        break;
      case 'Payload':
        switch (field) {
          case 'clientMutationId': return null;
          case 'issue': return value.issue !== undefined && value.repo !== undefined ? ({ t: 'Issue', repo: value.repo, issue: value.issue } as GValue) : null;
          case 'pullRequest': return value.pull !== undefined && value.repo !== undefined ? ({ t: 'Pull', repo: value.repo, pull: value.pull } as GValue) : null;
          case 'commentEdge': return value.comment !== undefined && value.repo !== undefined
            ? ({ t: 'CommentEdge', repo: value.repo, issueNumber: value.issueNumber ?? 0, comment: value.comment } as GValue)
            : null;
          case 'subject': return value.issue !== undefined && value.repo !== undefined ? ({ t: 'Issue', repo: value.repo, issue: value.issue } as GValue) : null;
        }
        break;
      case 'CommentEdge':
        switch (field) {
          case 'node': return { t: 'Comment', repo: value.repo, issueNumber: value.issueNumber, comment: value.comment } as GValue;
          case 'cursor': return cursorOf(value.comment.id);
        }
        break;
      case 'Edge':
        switch (field) {
          case 'node': return value.node;
          case 'cursor': return value.cursor;
        }
        break;
      case 'Label':
        switch (field) {
          case 'name': return value.name;
          case 'color': return value.color;
          case 'id': return globalId('Label', value.name);
          case 'description': return null;
        }
        break;
      case 'Type': {
        const fields = TYPE_FIELDS[value.name];
        const enumValues = ENUM_VALUES[value.name];
        switch (field) {
          case 'name': return value.name;
          case 'kind': return enumValues !== undefined ? 'ENUM' : fields !== undefined ? 'OBJECT' : 'SCALAR';
          case 'description': return null;
          case 'fields': return fields !== undefined ? fields.map((name) => ({ t: 'FieldDef', name } as GValue)) : null;
          case 'enumValues': return enumValues !== undefined ? enumValues.map((name) => ({ t: 'EnumValueDef', name } as GValue)) : null;
          case 'possibleTypes': return null;
          case 'inputFields': return null;
          case 'ofType': return null;
          case 'specifiedByURL': return null;
        }
        break;
      }
      case 'FieldDef':
        switch (field) {
          case 'name': return value.name;
          case 'description': return null;
          case 'args': return [];
          case 'type': return null;
          case 'isDeprecated': return false;
          case 'deprecationReason': return null;
        }
        break;
      case 'EnumValueDef':
        switch (field) {
          case 'name': return value.name;
          case 'description': return null;
          case 'isDeprecated': return false;
          case 'deprecationReason': return null;
        }
        break;
      case 'Schema':
        switch (field) {
          case 'types': return [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => ({ t: 'Type', name } as GValue));
          case 'queryType': return { t: 'Type', name: 'Query' } as GValue;
          case 'mutationType': return { t: 'Type', name: 'Mutation' } as GValue;
          case 'subscriptionType': return null;
          case 'directives': return [];
          case 'description': return null;
        }
        break;
    }
    // PullRequestChangedFile pseudo-values ride along as plain records.
    if ((value as { t: string }).t === 'PullFile') {
      const file = value as unknown as { path: string; additions: number; deletions: number; changeType: string };
      switch (field) {
        case 'path': return file.path;
        case 'additions': return file.additions;
        case 'deletions': return file.deletions;
        case 'changeType': return file.changeType;
      }
    }
    if ((value as { t: string }).t === 'IssueLabels') {
      return null;
    }
  }
  throw new GqlFieldError(`Field '${field}' doesn't exist on type '${typeNameOf(value)}'`);
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

function executeSelectionSet(ctx: Ctx, doc: Document, value: GValue, selection: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const apply = (selections: Selection[], current: GValue): void => {
    for (const sel of selections) {
      if (sel.kind === 'inline') {
        if (sel.typeCondition === undefined || sel.typeCondition === typeNameOf(current) || sel.typeCondition === 'Node') {
          apply(sel.selection, current);
        }
      } else if (sel.kind === 'spread') {
        const fragment = doc.fragments.get(sel.name);
        if (fragment !== undefined && (fragment.typeCondition === undefined || fragment.typeCondition === typeNameOf(current) || fragment.typeCondition === 'Node')) {
          apply(fragment.selection, current);
        }
      } else {
        const fieldNode = sel.field;
        const key = fieldNode.alias ?? fieldNode.name;
        out[key] = executeField(ctx, doc, current, fieldNode);
      }
    }
  };
  apply(selection, value);
  return out;
}

function executeField(ctx: Ctx, doc: Document, value: GValue, fieldNode: FieldNode): unknown {
  const args = new Map<string, unknown>();
  for (const [name, raw] of fieldNode.args) args.set(name, evalValue(raw, ctx.variables));
  try {
    const resolved: unknown = resolveField(ctx, value, fieldNode.name, args);
    return completeValue(ctx, doc, resolved, fieldNode);
  } catch (err) {
    if (err instanceof GqlFieldError) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    if (err instanceof Error && 'status' in err) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    throw err;
  }
}

function completeValue(ctx: Ctx, doc: Document, resolved: unknown, fieldNode: FieldNode): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    return resolved.map((item) => completeValue(ctx, doc, item, fieldNode));
  }
  if (typeof resolved === 'object') {
    if (fieldNode.selection === undefined) return resolved;
    return executeSelectionSet(ctx, doc, resolved as GValue, fieldNode.selection);
  }
  return resolved;
}

function executeRootField(ctx: Ctx, doc: Document, rootType: 'Query' | 'Mutation', fieldNode: FieldNode): unknown {
  const args = new Map<string, unknown>();
  for (const [name, raw] of fieldNode.args) args.set(name, evalValue(raw, ctx.variables));
  const forge = ctx.forge;
  const name = fieldNode.name;
  try {
    let resolved: unknown;
    if (rootType === 'Query') {
      switch (name) {
        case 'viewer': resolved = { t: 'Viewer' } as GValue; break;
        case 'repository': {
          const owner = String(args.get('owner') ?? '');
          const repoName = String(args.get('name') ?? '');
          const repo = owner === VIEWER.login ? forge.repoByName(repoName) : undefined;
          resolved = repo === undefined ? null : ({ t: 'Repo', repo } as GValue);
          break;
        }
        case 'node': {
          resolved = nodeValue(forge, args.get('id'));
          break;
        }
        case 'nodes': {
          const ids = args.get('ids');
          resolved = Array.isArray(ids) ? ids.map((id) => nodeValue(forge, id)) : [];
          break;
        }
        case '__type': {
          const typeName = String(args.get('name') ?? '');
          resolved = TYPE_FIELDS[typeName] !== undefined || ENUM_VALUES[typeName] !== undefined || ['String', 'Int', 'ID', 'Boolean', 'Float'].includes(typeName)
            ? ({ t: 'Type', name: typeName } as GValue)
            : null;
          break;
        }
        case '__schema': resolved = { t: 'Schema' } as GValue; break;
        case 'rateLimit': resolved = null; break;
        case 'meta': resolved = null; break;
        default: throw new GqlFieldError(`Field '${name}' doesn't exist on type 'Query'`);
      }
    } else {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      switch (name) {
        case 'createIssue': {
          const repo = repoFromGlobalId(forge, input.repositoryId);
          if (repo === null) throw new GqlFieldError('repository not found');
          const issue = createIssue(forge, repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
          resolved = { t: 'Payload', name: 'createIssue', repo, issue } as GValue;
          break;
        }
        case 'closeIssue': {
          const found = issueFromGlobalId(forge, input.issueId);
          if (found === null) throw new GqlFieldError('issue not found');
          found.issue.state = 'closed';
          found.issue.updatedEpoch = forge.tick();
          resolved = { t: 'Payload', name: 'closeIssue', repo: found.repo, issue: found.issue } as GValue;
          break;
        }
        case 'createPullRequest': {
          const repo = repoFromGlobalId(forge, input.repositoryId);
          if (repo === null) throw new GqlFieldError('repository not found');
          const pull = createPull(forge, repo, {
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : '',
            head: String(input.headRefName ?? ''),
            base: String(input.baseRefName ?? ''),
          });
          resolved = { t: 'Payload', name: 'createPullRequest', repo, pull } as GValue;
          break;
        }
        case 'mergePullRequest': {
          const found = pullFromGlobalId(forge, input.pullRequestId);
          if (found === null) throw new GqlFieldError('pull request not found');
          const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
          mergePull(forge, found.repo, found.pull, method === 'merge' ? 'merge' : 'squash');
          resolved = { t: 'Payload', name: 'mergePullRequest', repo: found.repo, pull: found.pull } as GValue;
          break;
        }
        case 'addComment': {
          const found = issueFromGlobalId(forge, input.subjectId);
          if (found === null) throw new GqlFieldError('subject not found');
          const comment = addComment(forge, found.repo, found.issue, String(input.body ?? ''));
          resolved = { t: 'Payload', name: 'addComment', repo: found.repo, issue: found.issue, comment, issueNumber: found.issue.number } as GValue;
          break;
        }
        default: throw new GqlFieldError(`Field '${name}' doesn't exist on type 'Mutation'`);
      }
    }
    return completeValue(ctx, doc, resolved, fieldNode);
  } catch (err) {
    if (err instanceof GqlFieldError) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    if (err instanceof Error && 'status' in err) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    throw err;
  }
}

function nodeValue(forge: Forge, id: unknown): GValue | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  switch (decoded.type) {
    case 'Repository': {
      const repo = forge.repoById(Number(decoded.key));
      return repo === undefined ? null : ({ t: 'Repo', repo } as GValue);
    }
    case 'Issue': {
      const found = issueFromGlobalId(forge, id);
      return found === null ? null : ({ t: 'Issue', repo: found.repo, issue: found.issue } as GValue);
    }
    case 'PullRequest': {
      const found = pullFromGlobalId(forge, id);
      return found === null ? null : ({ t: 'Pull', repo: found.repo, pull: found.pull } as GValue);
    }
    case 'User':
      return decoded.key === VIEWER.login ? ({ t: 'Viewer' } as GValue) : null;
    default:
      return null;
  }
}

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute one operation document; returns the {data, errors?} envelope. */
export function executeGraphQL(forge: Forge, request: GraphQLRequest): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: Ctx = { forge, variables: request.variables ?? {}, errors: [] };
  let doc: Document;
  try {
    doc = new Parser(tokenize(request.query)).parseDocument();
  } catch (err) {
    return { data: {}, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operation = request.operationName !== undefined
    ? doc.operations.find((op) => op.name === request.operationName) ?? doc.operations[0]
    : doc.operations[0];
  if (operation === undefined) return { data: {}, errors: [{ message: 'no operation in document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  for (const sel of operation.selection) {
    if (sel.kind !== 'field') continue;
    const key = sel.field.alias ?? sel.field.name;
    if (sel.field.name === '__typename') {
      data[key] = rootType;
      continue;
    }
    data[key] = executeRootField(ctx, doc, rootType, sel.field);
  }
  const envelope: { data: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
