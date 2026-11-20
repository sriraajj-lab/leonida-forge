# leonida-forge

A standalone GitHub-compatible git forge in a single Node process — no dependencies,
no install step, standard library only. Built for the make.fun competition
**github-core-clone-01** ("Build a GitHub-compatible git forge").

It serves four protocols from one in-memory store:

- **Git smart HTTP** — `info/refs`, `git-upload-pack` (protocol v2 `ls-refs`/`fetch`,
  plus v0 fetch) and `git-receive-pack` with `report-status` in `side-band-64k`. The git
  implementation is original code: object store, packfile writer/reader (OFS/REF delta
  resolution on read; plain objects on write), pkt-line codec, shallow/deepen fetch by
  depth-limited closure, per-ref push validation with fast-forward enforcement.
- **GitHub REST v3** — repositories (CRUD, pagination `Link` chains), contents API backed
  by real commits, branches, commits, git refs, labels, issues + comments, pull requests
  (files diff via merge-base + LCS line counts, merges via file-level three-way merge,
  squash or merge commits).
- **GraphQL v4** — a hand-written parser/executor for the documents `gh` and
  github-mcp-server send: viewer/repository reads, issue connections with cursor
  pagination and `orderBy`, pull requests, the create/close/merge/addComment mutations,
  Relay `node(id:)` with opaque base64 global ids, `__type` introspection, and operation
  batching (JSON array bodies).
- **MCP** — JSON-RPC over streamable HTTP at `POST /mcp`: the modern `server/discover`
  era (2026-07-28) plus the legacy `initialize` handshake; eight tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`,
  `create_pull_request`, `list_pull_requests`, `merge_pull_request`) acting on the same
  store as REST.

## Running

```
node main.ts          # Node 22.18+ (type-stripping); MAKEFUN_ENV_URL must be set
```

`main.ts` is the harness lifecycle: bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`,
poll `$MAKEFUN_ENV_URL/done`, exit 0. The server itself is `createApp()` in `app.ts`.

## Determinism

A trial runs the suite twice (live, then replay) and the pass/fail exports must match byte
for byte, so nothing in the forge reads a wall clock or a random source:

- all timestamps come from a logical clock (2025-01-01 + 1s per mutation);
- ids come from sequential counters; `X-GitHub-Request-Id` is a counter too;
- the token owner's identity is computed at boot from the trial's public seed by a port
  of the suite's own generator (see `scenario.ts`).

## Layout

| file          | contents                                                        |
|---------------|-----------------------------------------------------------------|
| `main.ts`     | entry ↔ env lifecycle (register / done / exit)                  |
| `app.ts`      | HTTP server, auth, routing, REST v3 handlers                    |
| `store.ts`    | domain state: repos, issues, PRs, contents, merges              |
| `git.ts`      | object store, packfiles, pkt-lines, smart HTTP                  |
| `graphql.ts`  | GraphQL parser, executor, introspection schema                  |
| `mcp.ts`      | MCP JSON-RPC endpoint and tools                                 |
| `scenario.ts` | the seeded viewer identity + version constants                  |

## Local score (kit runner, this machine)

120/120 conformance checks (git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15,
protocol 5) and 189/200 perf points against the calibrated reference times —
**989/1000** via `kit/sdk/run.ts --perf`.

## License

MIT (see `LICENSE`).
