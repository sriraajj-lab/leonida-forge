// The HTTP surface: one server routing the four protocols to their handlers, with the
// cross-cutting rules applied in one place — bearer auth (401 {message} when the trial token
// is configured and missing/wrong), a deterministic X-GitHub-Request-Id on every reply,
// JSON everywhere (never HTML), and GitHub's {message} error shape from HttpError.
//
// Routes:
//   GET  /healthz                                  the env's boot probe (no auth)
//   POST /mcp                                      MCP (mcp.ts)
//   POST /api/graphql                              GraphQL (graphql.ts)
//   *    /api/v3/...                               REST v3 (below)
//   *    /<owner>/<repo>.git/...                   git smart HTTP (git.ts)
//   *    anything else                             404 {message:"Not Found"}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  HttpError,
  Repo,
  addComment,
  commentJson,
  createIssue,
  createPull,
  deleteContents,
  getContents,
  globalId,
  issueJson,
  labelJson,
  listCommits,
  mergePull,
  pullFiles,
  pullJson,
  putContents,
  repoJson,
  resolveCommit,
  type IssueRec,
} from './store.ts';
import { fetchV0, fetchV2, infoRefs, lsRefs, parsePkts, receivePack, parseCommit } from './git.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { FORGE_VERSION, VIEWER } from './scenario.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

interface Reply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers };
}

function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

interface RestRequest {
  forge: Forge;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  host: string;
  rawPath: string;
}

function pagination<T>(items: T[], query: URLSearchParams): { page: T[]; total: number; perPage: number; pageNumber: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
  const pageNumber = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (pageNumber - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, perPage, pageNumber };
}

function linkHeader(req: RestRequest, total: number, perPage: number, pageNumber: number): Record<string, string> {
  const pages = Math.ceil(total / perPage);
  if (pageNumber >= pages) return {};
  const urlFor = (page: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('page', String(page));
    return `<http://${req.host}${req.rawPath}?${params.toString()}>`;
  };
  const links = [`${urlFor(pageNumber + 1)}; rel="next"`, `${urlFor(pages)}; rel="last"`];
  return { link: links.join(', ') };
}

function listReply<T>(req: RestRequest, items: T[], map: (item: T) => unknown): Reply {
  const { page, total, perPage, pageNumber } = pagination(items, req.query);
  return jsonReply(200, page.map(map), linkHeader(req, total, perPage, pageNumber));
}

function viewerJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.login),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
  };
}

function requireRepo(req: RestRequest, owner: string, name: string): Repo {
  if (owner !== VIEWER.login) throw new HttpError(404, 'Not Found');
  const repo = req.forge.repoByName(name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function identJson(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident.trim());
  if (match === null) return { name: ident.trim(), email: '', date: new Date(0).toISOString() };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function restRoot(req: RestRequest): Reply {
  const [head, ...rest] = req.segments;
  const forge = req.forge;

  if (head === undefined || head === '') {
    if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
    return jsonReply(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (head === 'meta') {
    if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
    return jsonReply(200, { installed_version: `leonida-forge/${FORGE_VERSION}`, verifiable_password_authentication: false });
  }

  if (head === 'user' && rest.length === 0) {
    if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
    return jsonReply(200, viewerJson());
  }

  if (head === 'user' && rest[0] === 'repos' && rest.length === 1) {
    if (req.method === 'GET') {
      const repos = [...forge.repos.values()].sort((a, b) => a.id - b.id);
      return listReply(req, repos, (repo) => repoJson(repo));
    }
    if (req.method === 'POST') {
      const name = req.body.name;
      if (typeof name !== 'string' || name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (forge.repoByName(name) !== undefined) throw new HttpError(422, 'Validation Failed: name already exists on this account');
      const repo = forge.createRepo(
        name,
        req.body.private === true,
        typeof req.body.description === 'string' ? req.body.description : '',
      );
      return jsonReply(201, repoJson(repo));
    }
    throw new HttpError(404, 'Not Found');
  }

  if (head === 'repos' && rest.length >= 2) {
    const owner = rest[0] as string;
    const name = rest[1] as string;
    const repo = requireRepo(req, owner, name);
    return repoRoute(req, repo, rest.slice(2));
  }

  throw new HttpError(404, 'Not Found');
}

function repoRoute(req: RestRequest, repo: Repo, parts: string[]): Reply {
  const forge = req.forge;
  const [head, ...tail] = parts;

  // /repos/{o}/{r}
  if (head === undefined) {
    if (req.method === 'GET') return jsonReply(200, repoJson(repo));
    if (req.method === 'PATCH') {
      if (typeof req.body.description === 'string') repo.description = req.body.description;
      if (typeof req.body.private === 'boolean') repo.isPrivate = req.body.private;
      if (typeof req.body.name === 'string' && req.body.name !== repo.name) {
        const next = req.body.name;
        if (forge.repoByName(next) !== undefined) throw new HttpError(422, 'Validation Failed: name already exists on this account');
        forge.repos.delete(repo.name);
        repo.name = next;
        forge.repos.set(next, repo);
      }
      repo.updatedEpoch = forge.tick();
      return jsonReply(200, repoJson(repo));
    }
    if (req.method === 'DELETE') {
      forge.repos.delete(repo.name);
      return { status: 204, contentType: JSON_TYPE, body: Buffer.alloc(0) };
    }
    throw new HttpError(404, 'Not Found');
  }

  // /contents/{path...}
  if (head === 'contents') {
    const path = tail.join('/');
    if (req.method === 'GET') {
      const read = getContents(repo, path, req.query.get('ref') ?? undefined);
      if (read === null) throw new HttpError(404, 'Not Found');
      if (read.kind === 'dir') {
        return jsonReply(200, (read.entries ?? []).map((entry) => ({
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          size: 0,
          type: entry.type,
          url: `/api/v3/repos/${repo.fullName}/contents/${entry.path}`,
        })));
      }
      const file = read.file as { name: string; path: string; sha: string; size: number; contentB64: string };
      return jsonReply(200, {
        type: 'file',
        encoding: 'base64',
        name: file.name,
        path: file.path,
        sha: file.sha,
        size: file.size,
        content: file.contentB64,
        url: `/api/v3/repos/${repo.fullName}/contents/${file.path}`,
      });
    }
    if (req.method === 'PUT') {
      const content = typeof req.body.content === 'string' ? Buffer.from(req.body.content, 'base64') : Buffer.alloc(0);
      const result = putContents(
        forge,
        repo,
        path,
        content,
        typeof req.body.message === 'string' ? req.body.message : 'update',
        typeof req.body.branch === 'string' ? req.body.branch : undefined,
        typeof req.body.sha === 'string' ? req.body.sha : undefined,
      );
      return jsonReply(result.created ? 201 : 200, {
        content: {
          name: path.split('/').pop(),
          path,
          sha: result.blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha: result.commitOid },
      });
    }
    if (req.method === 'DELETE') {
      const commitOid = deleteContents(
        forge,
        repo,
        path,
        typeof req.body.message === 'string' ? req.body.message : 'delete',
        typeof req.body.branch === 'string' ? req.body.branch : undefined,
        typeof req.body.sha === 'string' ? req.body.sha : '',
      );
      return jsonReply(200, { content: null, commit: { sha: commitOid } });
    }
    throw new HttpError(404, 'Not Found');
  }

  // /git/refs[/...]
  if (head === 'git' && tail[0] === 'refs') {
    if (req.method === 'POST' && tail.length === 1) {
      const ref = req.body.ref;
      const sha = req.body.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed: ref must start with refs/');
      if (typeof sha !== 'string' || repo.objects.get(sha) === undefined) throw new HttpError(422, 'Validation Failed: sha does not name an object');
      if (repo.refs.has(ref)) throw new HttpError(422, 'Validation Failed: reference already exists');
      repo.refs.set(ref, sha);
      repo.version += 1;
      return jsonReply(201, { ref, node_id: globalId('Ref', ref), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (req.method === 'GET' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      return jsonReply(200, { ref, node_id: globalId('Ref', ref), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    throw new HttpError(404, 'Not Found');
  }

  // /branches[/{name...}]
  if (head === 'branches') {
    if (req.method === 'GET' && tail.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), sha }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return listReply(req, branches, (branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false }));
    }
    if (req.method === 'GET' && tail.length >= 1) {
      const branch = tail.join('/');
      const sha = repo.branchTip(branch);
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      return jsonReply(200, { name: branch, commit: { sha }, protected: false });
    }
    throw new HttpError(404, 'Not Found');
  }

  // /commits[/{sha}]
  if (head === 'commits') {
    if (req.method === 'GET' && tail.length === 0) {
      const start = resolveCommit(repo, req.query.get('sha') ?? undefined);
      if (start === undefined) return jsonReply(200, []);
      const commits = listCommits(repo, start);
      return listReply(req, commits, (entry) => {
        const parsed = parseCommit(entry.data);
        return {
          sha: entry.sha,
          commit: {
            message: parsed.message,
            author: identJson(parsed.author),
            committer: identJson(parsed.committer),
            tree: { sha: parsed.tree },
          },
          parents: parsed.parents.map((parent) => ({ sha: parent })),
        };
      });
    }
    if (req.method === 'GET' && tail.length === 1) {
      const object = repo.objects.get(tail[0] as string);
      if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
      const parsed = parseCommit(object.data);
      return jsonReply(200, {
        sha: tail[0],
        commit: { message: parsed.message, author: identJson(parsed.author), committer: identJson(parsed.committer), tree: { sha: parsed.tree } },
        parents: parsed.parents.map((parent) => ({ sha: parent })),
      });
    }
    throw new HttpError(404, 'Not Found');
  }

  // /labels[/{name}]
  if (head === 'labels') {
    if (req.method === 'GET' && tail.length === 0) {
      const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      return listReply(req, labels, (label) => labelJson(label));
    }
    if (req.method === 'POST' && tail.length === 0) {
      const name = req.body.name;
      if (typeof name !== 'string' || name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: label already exists');
      const label = { name, color: typeof req.body.color === 'string' ? req.body.color : '000000' };
      repo.labels.set(name, label);
      forge.tick();
      return jsonReply(201, labelJson(label));
    }
    if (req.method === 'GET' && tail.length === 1) {
      const label = repo.labels.get(tail[0] as string);
      if (label === undefined) throw new HttpError(404, 'Not Found');
      return jsonReply(200, labelJson(label));
    }
    throw new HttpError(404, 'Not Found');
  }

  // /issues[/{n}[/comments]]
  if (head === 'issues') {
    if (req.method === 'POST' && tail.length === 0) {
      const labels = Array.isArray(req.body.labels) ? req.body.labels.map((label) => String(label)) : undefined;
      const issue = createIssue(forge, repo, {
        title: typeof req.body.title === 'string' ? req.body.title : '',
        body: typeof req.body.body === 'string' ? req.body.body : '',
        labels,
      });
      return jsonReply(201, issueJson(repo, issue));
    }
    if (req.method === 'GET' && tail.length === 0) {
      let items = [...repo.issues.values()];
      const state = req.query.get('state') ?? 'open';
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      const direction = req.query.get('direction') ?? 'desc';
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return listReply(req, items, (issue) => issueJson(repo, issue));
    }
    if (tail.length >= 1) {
      const number = Number(tail[0]);
      const issue = repo.issues.get(number);
      if (tail.length === 1) {
        if (req.method === 'GET') {
          if (issue !== undefined) return jsonReply(200, issueJson(repo, issue));
          const pull = repo.pulls.get(number);
          if (pull !== undefined) {
            const asIssue = pullJson(repo, pull);
            asIssue.pull_request = { url: `/api/v3/repos/${repo.fullName}/pulls/${number}` };
            return jsonReply(200, asIssue);
          }
          throw new HttpError(404, 'Not Found');
        }
        if (req.method === 'PATCH') {
          if (issue === undefined) throw new HttpError(404, 'Not Found');
          if (req.body.state === 'closed' || req.body.state === 'open') issue.state = req.body.state;
          if (typeof req.body.title === 'string') issue.title = req.body.title;
          if (typeof req.body.body === 'string') issue.body = req.body.body;
          if (Array.isArray(req.body.labels)) {
            const labels = req.body.labels.map((label) => String(label));
            for (const label of labels) if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label "${label}" does not exist`);
            issue.labels = labels;
          }
          issue.updatedEpoch = forge.tick();
          return jsonReply(200, issueJson(repo, issue));
        }
        throw new HttpError(404, 'Not Found');
      }
      if (tail.length === 2 && tail[1] === 'comments') {
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (req.method === 'GET') {
          return listReply(req, issue.comments, (comment) => commentJson(repo, number, comment));
        }
        if (req.method === 'POST') {
          const comment = addComment(forge, repo, issue, typeof req.body.body === 'string' ? req.body.body : '');
          return jsonReply(201, commentJson(repo, number, comment));
        }
        throw new HttpError(404, 'Not Found');
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  // /pulls[/{n}[/files|/merge]]
  if (head === 'pulls') {
    if (req.method === 'POST' && tail.length === 0) {
      const pull = createPull(forge, repo, {
        title: typeof req.body.title === 'string' ? req.body.title : '',
        body: typeof req.body.body === 'string' ? req.body.body : '',
        head: typeof req.body.head === 'string' ? req.body.head : '',
        base: typeof req.body.base === 'string' ? req.body.base : '',
      });
      return jsonReply(201, pullJson(repo, pull));
    }
    if (req.method === 'GET' && tail.length === 0) {
      let items = [...repo.pulls.values()];
      const state = req.query.get('state') ?? 'open';
      if (state === 'open') items = items.filter((pull) => pull.state === 'open');
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      return listReply(req, items, (pull) => pullJson(repo, pull));
    }
    if (tail.length >= 1) {
      const number = Number(tail[0]);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      if (tail.length === 1 && req.method === 'GET') return jsonReply(200, pullJson(repo, pull));
      if (tail.length === 2 && tail[1] === 'files' && req.method === 'GET') {
        const files = pullFiles(repo, pull);
        return listReply(req, files, (file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          sha: '',
        }));
      }
      if (tail.length === 2 && tail[1] === 'merge' && req.method === 'PUT') {
        const method = typeof req.body.merge_method === 'string' ? req.body.merge_method : 'merge';
        const { sha } = mergePull(forge, repo, pull, method);
        return jsonReply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  const forge = new Forge();
  let requestCounter = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requestCounter += 1;
    const requestId = `req-${String(requestCounter).padStart(6, '0')}`;
    const reply = (out: Reply): void => {
      res.writeHead(out.status, {
        'content-type': out.contentType,
        'content-length': out.body.length,
        'x-github-request-id': requestId,
        ...(out.headers ?? {}),
      });
      res.end(out.body);
    };

    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        reply(jsonReply(200, { ok: true }));
        return;
      }

      // Everything else needs the trial token when one is configured.
      if (TOKEN !== '' && req.headers.authorization !== `Bearer ${TOKEN}`) {
        reply(errorReply(401, 'Bad credentials'));
        return;
      }

      if (path === '/mcp') {
        if (method !== 'POST') {
          reply(errorReply(405, 'Method Not Allowed'));
          return;
        }
        const body = await readBody(req);
        const answer = handleMcp(forge, body.toString('utf8'));
        if (answer.body === null) {
          res.writeHead(answer.status, { 'x-github-request-id': requestId, 'content-length': 0 });
          res.end();
          return;
        }
        reply({ status: answer.status, contentType: JSON_TYPE, body: Buffer.from(answer.body, 'utf8') });
        return;
      }

      if (path === '/api/graphql') {
        if (method !== 'POST') {
          reply(errorReply(404, 'Not Found'));
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          reply(errorReply(400, 'Problems parsing JSON'));
          return;
        }
        if (Array.isArray(parsed)) {
          const results = parsed.map((entry) => executeGraphQL(forge, (entry ?? {}) as GraphQLRequest));
          reply({ status: 200, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(results)}\n`, 'utf8') });
          return;
        }
        const result = executeGraphQL(forge, (parsed ?? {}) as GraphQLRequest);
        reply({ status: 200, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(result)}\n`, 'utf8') });
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
        const restReq: RestRequest = {
          forge,
          method,
          segments: path.slice('/api/v3'.length).split('/').filter((segment) => segment !== '').map(decodeSegment),
          query: url.searchParams,
          body: body.length > 0 ? parseJsonBody(body) : {},
          host: req.headers.host ?? 'localhost',
          rawPath: path,
        };
        try {
          reply(restRoot(restReq));
        } catch (err) {
          if (err instanceof HttpError) reply(errorReply(err.status, err.message));
          else throw err;
        }
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/<endpoint>
      const gitMatch = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeSegment(gitMatch[1] as string);
        const repoName = decodeSegment(gitMatch[2] as string);
        const endpoint = gitMatch[3] as string;
        const repo = owner === VIEWER.login ? forge.repoByName(repoName) : undefined;
        if (repo === undefined) {
          reply(errorReply(404, 'Not Found'));
          return;
        }
        if (endpoint === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service') ?? '';
          const protocol = req.headers['git-protocol'];
          const wantV2 = typeof protocol === 'string' && protocol.includes('version=2');
          const out = infoRefs(repo, service, wantV2);
          reply({ status: out.status, contentType: out.contentType, body: out.body });
          return;
        }
        if (endpoint === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          const protocol = req.headers['git-protocol'];
          const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
          let out;
          if (isV2) {
            let command = '';
            try {
              const { packets } = parsePkts(body);
              const first = packets.find((pkt) => pkt.kind === 'data');
              command = first !== undefined ? first.payload.toString('utf8').trimEnd() : '';
            } catch {
              reply(errorReply(400, 'Bad Request'));
              return;
            }
            if (command === 'command=ls-refs') out = lsRefs(repo, body);
            else if (command === 'command=fetch') out = fetchV2(repo, body);
            else {
              reply(errorReply(400, 'Bad Request'));
              return;
            }
          } else {
            out = fetchV0(repo, body);
          }
          reply({ status: out.status, contentType: out.contentType, body: out.body });
          return;
        }
        if (endpoint === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          const out = receivePack(repo, body);
          reply({ status: out.status, contentType: out.contentType, body: out.body });
          return;
        }
        reply(errorReply(404, 'Not Found'));
        return;
      }

      reply(errorReply(404, 'Not Found'));
    } catch (err) {
      if (err instanceof HttpError) {
        reply(errorReply(err.status, err.message));
        return;
      }
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) reply(errorReply(500, 'Internal Server Error'));
    }
  };

  return createServer((req, res) => {
    void handle(req, res);
  });
}
