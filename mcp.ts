// The MCP endpoint: JSON-RPC 2.0 over the Streamable HTTP transport at POST /mcp.
//
// The modern era is implemented: `server/discover` answers identity, capabilities and
// supportedVersions (including 2026-07-28) with no handshake and no session; the legacy
// handshake (`initialize` + `notifications/initialized`) is answered too. tools/list is a
// fixed payload, byte-identical across calls; the tools act on the same store as REST, so
// an issue created over MCP is the same object over /api/v3. Protocol errors follow the
// rules: unknown tool -> JSON-RPC -32602, unknown method -> -32601, a body that is not JSON
// -> HTTP 400 with -32700, a tools/call missing a required argument -> an isError result.

import {
  createIssue,
  createPull,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
  HttpError,
  type Forge,
  type Repo,
} from './store.ts';
import { FORGE_VERSION, VIEWER } from './scenario.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'leonida-forge', version: FORGE_VERSION };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function stringProp(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

function repoOf(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = owner === VIEWER.login ? forge.repoByName(name) : undefined;
  if (repo === undefined) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: stringProp('The repository name'),
      description: stringProp('A short description of the repository'),
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
    run: (forge, args) => {
      const name = String(args.name ?? '');
      if (forge.repoByName(name) !== undefined) throw new Error(`repository ${name} already exists`);
      const repo = forge.createRepo(name, args.private === true, typeof args.description === 'string' ? args.description : '');
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: stringProp('The repository owner login'),
      repo: stringProp('The repository name'),
    },
    required: ['owner', 'repo'],
    run: (forge, args) => repoJson(repoOf(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: stringProp('The repository owner login'),
      repo: stringProp('The repository name'),
      title: stringProp('The issue title'),
      body: stringProp('The issue body'),
    },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const issue = createIssue(forge, repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    properties: {
      owner: stringProp('The repository owner login'),
      repo: stringProp('The repository name'),
      state: stringProp('Filter by state: open, closed or all'),
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      return [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: stringProp('The repository owner login'),
      repo: stringProp('The repository name'),
      issue_number: { type: 'number', description: 'The issue number' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) throw new Error(`issue ${String(args.issue_number)} not found`);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: stringProp('The repository owner login'),
      repo: stringProp('The repository name'),
      title: stringProp('The pull request title'),
      body: stringProp('The pull request body'),
      head: stringProp('The head branch name'),
      base: stringProp('The base branch name'),
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const pull = createPull(forge, repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
      });
      return pullJson(repo, pull);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state (open, closed, all).',
    properties: {
      owner: stringProp('The repository owner login'),
      repo: stringProp('The repository name'),
      state: stringProp('Filter by state: open, closed or all'),
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      return [...repo.pulls.values()]
        .filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === state))
        .sort((a, b) => a.number - b.number)
        .map((pull) => pullJson(repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: {
      owner: stringProp('The repository owner login'),
      repo: stringProp('The repository name'),
      pull_number: { type: 'number', description: 'The pull request number' },
      merge_method: stringProp('The merge method: merge or squash'),
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new Error(`pull request ${String(args.pull_number)} not found`);
      mergePull(forge, repo, pull, args.merge_method === 'squash' ? 'squash' : 'merge');
      return pullJson(repo, pull);
    },
  },
];

const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

export interface McpAnswer {
  status: number;
  /** The response body text, or null for an empty (notification) answer. */
  body: string | null;
}

function rpcResult(id: unknown, result: unknown): McpAnswer {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpAnswer {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(forge: Forge, params: Record<string, unknown>): Record<string, unknown> {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new RpcFailure(-32602, `unknown tool: ${name}`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);
  try {
    return toolResult(tool.run(forge, args));
  } catch (err) {
    if (err instanceof HttpError) return toolError(err.message);
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

class RpcFailure extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function handleOne(forge: Forge, request: Record<string, unknown>): McpAnswer {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (id === undefined) {
    // A notification: accepted, never answered.
    return { status: 202, body: null };
  }
  try {
    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        });
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, TOOLS_LIST_RESULT);
      case 'tools/call':
        return rpcResult(id, callTool(forge, params));
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof RpcFailure) return rpcError(id, err.code, err.message);
    return rpcError(id, -32603, err instanceof Error ? err.message : 'internal error');
  }
}

/** Handle one POST /mcp body (auth has already been checked by the caller). */
export function handleMcp(forge: Forge, bodyText: string): McpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => handleOne(forge, (entry ?? {}) as Record<string, unknown>))
      .filter((answer) => answer.body !== null)
      .map((answer) => JSON.parse(answer.body as string) as unknown);
    return { status: 200, body: JSON.stringify(answers) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  return handleOne(forge, parsed as Record<string, unknown>);
}
