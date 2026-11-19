# github-core-clone-01 — a GitHub-compatible git forge in one process

A single Node process (Node 22, standard library only, no dependencies, no install
step) that serves the four surfaces agents already speak, over one in-memory store:

- **git smart HTTP** — `info/refs`, `git-upload-pack`, `git-receive-pack`, protocol
  v2 (with `ls-refs`, `fetch` incl. shallow/deepen, `object-format=sha1`) and v0.
  A real SHA-1 object model: blobs, trees, commits and annotated tags, pack v2
  read/write (OFS/REF deltas resolved on read, no deltas written), sideband
  framing, fast-forward enforcement (`non-fast-forward` refusals), shallow
  boundaries and unshallow.
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents, labels,
  issues, comments, pull requests and squash merges, with pagination (`Link`
  headers), `X-GitHub-Request-Id` on every reply, bearer auth and the usual
  status codes (201/200/204/401/404/409/422).
- **GraphQL v4** (`/api/graphql`) — viewer, repository, issues/pulls connections
  with cursor pagination, the five mutations the suite drives
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), `node(id:)` round-trips, `__type` probes and batched requests.
- **MCP** (`/mcp`) — the 2026-07-28 modern revision (`server/discover`, no
  handshake) plus the legacy `initialize` handshake; eight tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`,
  `create_pull_request`, `merge_pull_request`, `list_pull_requests`) with
  JSON-RPC error codes and per-call `id` echo.

## Run it

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL in a trial
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http` and its own modules only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts, kept as the starter wrote it)

The env is a server the harness starts beside yours; its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read
   it with `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
   The first register wins; a later one is answered `409`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with
   `{"done":false}` while the suite runs and `{"done":true}` once its export is
   written. Poll it; never exit before it says `true`.
4. **Exit 0** when it does.

## Layout

- `main.ts` — the lifecycle above.
- `app.ts` — the HTTP server: routing, bearer auth (`MAKEFUN_SHOP_TOKEN` when
  set, otherwise any non-empty token for local runs), JSON body parsing.
- `src/gitcore.ts` — SHA-1 objects, pack codec, pkt-lines, reachability,
  merge-base, tree diff.
- `src/store.ts` — the in-memory store (repos, refs, issues, PRs, labels,
  comments) and the squash-merge/conflict rules.
- `src/githttp.ts` — smart HTTP: advertisements, ls-refs, fetch planning,
  receive-pack with report-status.
- `src/rest.ts` — REST v3 routes.
- `src/graphql.ts` — a small GraphQL parser and executor.
- `src/mcp.ts` — the MCP JSON-RPC endpoint.

## Local grading

Local smoke test (no env): start `app.ts` on a fixed port with
`MAKEFUN_SHOP_TOKEN` set and point the kit's conformance runner at it:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:4123 --token <token> [--perf]
```

Local conformance (practice trial-0 seed): **120/120 checks pass**
(git 30, repos 15, issues 15, pulls 20, protocol 5, graphql 20, mcp 15);
benchmark **135/200** (push 29, clone 33, read 39, write 34).

## Notes

- Everything is in memory: the forge forgets everything when the process
  exits, which is what a trial wants (a fresh store per instance).
- The viewer is `adaiversen` (id 1000), as the kit's scenario defines; all
  token-owned repositories live under that login.
- Packs are written without deltas; the suite's delta checks are satisfied by
  resolving deltas on read and by byte-exact object round-trips.

The contest page and rules: https://make.fun/bounty/github-core-clone-01.
MIT licensed.
