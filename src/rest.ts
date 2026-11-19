// GitHub REST v3 surface: /api/v3/* — repositories, branches, commits, contents,
// labels, issues, comments and pull requests, over the shared store.

import { hashObject, isOid, parseCommit } from './gitcore.ts';
import {
  issueJson,
  pullJson,
  repoJson,
  userJson,
  VIEWER,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  noBody?: boolean;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, body, headers };
}

export function errorReply(status: number, message: string): RestReply {
  return { status, body: { message } };
}

export function notFound(message = 'Not Found'): RestReply {
  return errorReply(404, message);
}

/** Parse a query string into a record. */
export function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!search) return out;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const [key, value] of params) out[key] = value;
  return out;
}

/** Build a GitHub-style Link header for paginated lists. */
export function paginationLinks(
  base: string,
  query: Record<string, string>,
  page: number,
  perPage: number,
  total: number,
): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const urlFor = (p: number): string => {
    const params = new URLSearchParams({ ...query, page: String(p), per_page: String(perPage) });
    return `${base}?${params.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

export function pageParams(query: Record<string, string>): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && !name.includes('/');
}

/** The REST router: method + path segments + query + parsed JSON body. */
export function handleRest(
  store: Store,
  method: string,
  path: string,
  query: Record<string, string>,
  body: unknown,
  absoluteBase: string,
): RestReply {
  const seg = path.split('/').filter((part) => part !== '');
  // All REST routes live under /api/v3.
  if (seg[0] !== 'api' || seg[1] !== 'v3') return notFound();
  const rest = seg.slice(2);
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const obj = isObject(body) ? body : {};

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    return jsonReply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    return jsonReply(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    return jsonReply(200, userJson());
  }

  // POST /api/v3/user/repos ; GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = obj.name;
      if (!validName(name)) return errorReply(422, 'name is required');
      const repo = store.createRepo(name, obj.private === true, typeof obj.description === 'string' ? obj.description : '');
      if (!repo) return errorReply(422, 'name already exists on this account');
      return jsonReply(201, repoJson(repo));
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const repos = store.listViewerRepos();
      const link = paginationLinks(`${absoluteBase}/api/v3/user/repos`, query, page, perPage, repos.length);
      return jsonReply(200, paginate(repos, page, perPage).map(repoJson), link ? { link } : {});
    }
    return errorReply(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]!);
    const repoName = decodeURIComponent(rest[2]!);
    if (owner !== VIEWER.login) return notFound();
    const repo = store.getRepo(owner, repoName);
    const tail = rest.slice(3);
    if (tail.length === 0) return handleRepo(store, method, repo, obj, repoName);
    if (!repo) return notFound();
    return handleRepoSub(store, method, repo, tail, query, obj, absoluteBase);
  }

  return notFound();
}

function handleRepo(
  store: Store,
  method: string,
  repo: Repo | undefined,
  obj: Record<string, unknown>,
  repoName: string,
): RestReply {
  if (method === 'GET') {
    if (!repo) return notFound();
    return jsonReply(200, repoJson(repo));
  }
  if (method === 'PATCH') {
    if (!repo) return notFound();
    if (typeof obj.description === 'string') repo.description = obj.description;
    return jsonReply(200, repoJson(repo));
  }
  if (method === 'DELETE') {
    if (!repo) return notFound();
    store.deleteRepo(VIEWER.login, repoName);
    return { status: 204, body: null, noBody: true };
  }
  return errorReply(405, 'Method Not Allowed');
}

function handleRepoSub(
  store: Store,
  method: string,
  repo: Repo,
  tail: string[],
  query: Record<string, string>,
  obj: Record<string, unknown>,
  absoluteBase: string,
): RestReply {
  const head = tail[0];
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! } }));
      return jsonReply(200, branches);
    }
    if (tail.length === 2 && method === 'GET') {
      const name = decodeURIComponent(tail[1]!);
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (!sha) return notFound();
      return jsonReply(200, { name, commit: { sha } });
    }
    return errorReply(405, 'Method Not Allowed');
  }

  if (head === 'commits') {
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    const ref = query.sha;
    let tip: string | undefined;
    if (ref) {
      tip = store.resolveToCommit(repo, ref) ?? undefined;
      if (!tip) return notFound();
    } else {
      tip = store.defaultBranchTip(repo);
      if (!tip) return jsonReply(200, []);
    }
    const commits = store.listCommits(repo, tip).map((sha) => ({
      sha,
      // GitHub's REST view presents the message without its trailing newline.
      commit: { message: store.commitMessage(repo, sha).replace(/\n$/, '') },
      parents: [],
    }));
    return jsonReply(200, commits);
  }

  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = obj.ref;
      const sha = obj.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || !isOid(sha)) {
        return errorReply(422, 'invalid ref or sha');
      }
      const target = repo.objects.get(sha);
      if (!target) return errorReply(422, 'object does not exist');
      if (repo.refs.has(ref)) return errorReply(422, 'reference already exists');
      repo.refs.set(ref, sha);
      return jsonReply(201, { ref, object: { sha }, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}` });
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = tail.slice(2).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return jsonReply(200, { ref, object: { sha } });
    }
    return errorReply(405, 'Method Not Allowed');
  }

  if (head === 'contents') {
    const contentPath = tail.slice(1).map(decodeURIComponent).join('/');
    if (method === 'PUT') return putContents(store, repo, contentPath, obj);
    if (method === 'GET') return getContents(store, repo, contentPath, query.ref);
    if (method === 'DELETE') return deleteContents(store, repo, contentPath, obj);
    return errorReply(405, 'Method Not Allowed');
  }

  if (head === 'labels') {
    if (method !== 'POST') return errorReply(405, 'Method Not Allowed');
    const name = obj.name;
    if (typeof name !== 'string' || name === '') return errorReply(422, 'name is required');
    const color = typeof obj.color === 'string' ? obj.color : 'ededed';
    const existing = repo.labels.get(name);
    if (existing) return jsonReply(201, { name: existing.name, color: existing.color });
    repo.labels.set(name, { name, color });
    return jsonReply(201, { name, color });
  }

  if (head === 'issues') {
    return handleIssues(store, method, repo, tail.slice(1), query, obj, absoluteBase);
  }

  if (head === 'pulls') {
    return handlePulls(store, method, repo, tail.slice(1), query, obj, absoluteBase);
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function putContents(store: Store, repo: Repo, contentPath: string, obj: Record<string, unknown>): RestReply {
  const message = typeof obj.message === 'string' ? obj.message : 'update';
  const contentB64 = typeof obj.content === 'string' ? obj.content : '';
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return errorReply(422, 'content is not valid base64');
  }
  const branch = typeof obj.branch === 'string' ? obj.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const current = tip ? store.readFileAt(repo, store.resolveToCommit(repo, branch) ?? '', contentPath) : null;
  const sha = typeof obj.sha === 'string' ? obj.sha : undefined;
  if (current) {
    // Update: the blob sha must match (when given), else 409 on a stale sha.
    if (sha === undefined) return errorReply(422, 'sha is required to update a file');
    if (sha.toLowerCase() !== current.oid.toLowerCase()) return errorReply(409, 'sha does not match the current blob');
  }
  const { commitOid, blobOid } = store.commitFile(repo, branch, contentPath, content, message);
  const name = contentPath.split('/').pop() ?? contentPath;
  return jsonReply(current ? 200 : 201, {
    content: { name, path: contentPath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
    commit: { sha: commitOid },
  });
}

function getContents(store: Store, repo: Repo, contentPath: string, ref: string | undefined): RestReply {
  const branch = ref ?? repo.defaultBranch;
  const tip = store.resolveToCommit(repo, branch);
  if (!tip) return notFound();
  if (contentPath === '') {
    const entries = store.listDirAt(repo, tip, '') ?? [];
    return jsonReply(200, entries.map((entry) => ({ ...entry, size: 0 })));
  }
  const file = store.readFileAt(repo, tip, contentPath);
  if (file) {
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      content: file.data.toString('base64'),
      sha: file.oid,
      size: file.data.length,
      name: contentPath.split('/').pop() ?? contentPath,
      path: contentPath,
    });
  }
  const dir = store.listDirAt(repo, tip, contentPath);
  if (dir) {
    return jsonReply(200, dir.map((entry) => ({ ...entry, size: 0 })));
  }
  return notFound();
}

function deleteContents(store: Store, repo: Repo, contentPath: string, obj: Record<string, unknown>): RestReply {
  const branch = typeof obj.branch === 'string' ? obj.branch : repo.defaultBranch;
  const tip = store.resolveToCommit(repo, branch);
  if (!tip) return notFound();
  const current = store.readFileAt(repo, tip, contentPath);
  if (!current) return notFound();
  const sha = typeof obj.sha === 'string' ? obj.sha : undefined;
  if (sha !== undefined && sha.toLowerCase() !== current.oid.toLowerCase()) return errorReply(409, 'sha does not match the current blob');
  const message = typeof obj.message === 'string' ? obj.message : 'delete';
  const { commitOid } = store.commitFile(repo, branch, contentPath, null, message);
  return jsonReply(200, { commit: { sha: commitOid } });
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(
  store: Store,
  method: string,
  repo: Repo,
  tail: string[],
  query: Record<string, string>,
  obj: Record<string, unknown>,
  absoluteBase: string,
): RestReply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = obj.title;
      if (typeof title !== 'string' || title === '') return errorReply(422, 'title is required');
      const labels = Array.isArray(obj.labels) ? obj.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return errorReply(422, `label ${label} does not exist`);
      }
      const issue = store.createIssue(repo, title, typeof obj.body === 'string' ? obj.body : '', labels);
      return jsonReply(201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = query.state ?? 'open';
      const sort = query.sort ?? 'created';
      const direction = query.direction ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, perPage } = pageParams(query);
      const link = paginationLinks(`${absoluteBase}/api/v3/repos/${repo.fullName}/issues`, query, page, perPage, issues.length);
      return jsonReply(200, paginate(issues, page, perPage).map((issue) => issueJson(repo, issue)), link ? { link } : {});
    }
    return errorReply(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return notFound();
  const issue = store.findIssue(repo, number);
  if (tail.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return jsonReply(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof obj.state === 'string' && (obj.state === 'open' || obj.state === 'closed')) issue.state = obj.state;
      if (typeof obj.title === 'string') issue.title = obj.title;
      if (typeof obj.body === 'string') issue.body = obj.body;
      return jsonReply(200, issueJson(repo, issue));
    }
    return errorReply(405, 'Method Not Allowed');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'POST') {
      const bodyText = typeof obj.body === 'string' ? obj.body : '';
      const comment = store.addComment(repo, number, bodyText);
      if (!comment) return notFound();
      return jsonReply(201, { id: comment.id, node_id: comment.globalId, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } });
    }
    if (method === 'GET') {
      const comments = store.listComments(repo, number).map((comment) => ({
        id: comment.id,
        node_id: comment.globalId,
        body: comment.body,
        user: { login: VIEWER.login, id: VIEWER.id },
      }));
      return jsonReply(200, comments);
    }
    return errorReply(405, 'Method Not Allowed');
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function handlePulls(
  store: Store,
  method: string,
  repo: Repo,
  tail: string[],
  query: Record<string, string>,
  obj: Record<string, unknown>,
  absoluteBase: string,
): RestReply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof obj.title === 'string' ? obj.title : '';
      const head = typeof obj.head === 'string' ? obj.head : '';
      const base = typeof obj.base === 'string' ? obj.base : '';
      if (title === '' || head === '' || base === '') return errorReply(422, 'title, head and base are required');
      const pull = store.createPull(repo, title, typeof obj.body === 'string' ? obj.body : '', head, base);
      if ('error' in pull) return errorReply(422, pull.error);
      return jsonReply(201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = query.state ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, perPage } = pageParams(query);
      const link = paginationLinks(`${absoluteBase}/api/v3/repos/${repo.fullName}/pulls`, query, page, perPage, pulls.length);
      return jsonReply(200, paginate(pulls, page, perPage).map((pull) => pullJson(repo, pull)), link ? { link } : {});
    }
    return errorReply(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return notFound();
  const pull = store.findPull(repo, number);

  if (tail.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return jsonReply(200, pullJson(repo, pull));
    return errorReply(405, 'Method Not Allowed');
  }

  if (tail.length === 2 && tail[1] === 'files') {
    if (!pull) return notFound();
    if (method !== 'GET') return errorReply(405, 'Method Not Allowed');
    const diffs = store.pullDiff(repo, pull);
    return jsonReply(200, diffs.map((d) => ({
      filename: d.path,
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
    })));
  }

  if (tail.length === 2 && tail[1] === 'merge') {
    if (!pull) return notFound();
    if (method !== 'PUT') return errorReply(405, 'Method Not Allowed');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return errorReply(merged.status, merged.error);
    return jsonReply(200, { merged: true, sha: merged.commitOid, message: `Pull Request #${pull.number} merged` });
  }

  return notFound();
}
