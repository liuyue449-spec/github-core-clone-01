// The forge's in-memory store: repositories, git objects, refs, issues, pull requests,
// labels and comments — one shared state for the REST, GraphQL, MCP and git surfaces.

import {
  buildCommit,
  collectReachable,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  updateTree,
  ZERO_OID,
  type FileDiff,
  type GitObject,
  type GitObjectType,
} from './gitcore.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;
// Fixed commit timestamp base for server-generated commits (deterministic, never Date.now).
const COMMIT_EPOCH = 1735689600;

export interface Issue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  repoDbId: number;
}

export interface Pull {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  repoDbId: number;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, Comment[]>;
  issueSeq: number; // shared issue + PR numbering, GitHub-style
  commentSeq: number;
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  repoSeq = 1;
  globalSeq = 1;
  nextRepoId = 5000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoByDbId(dbId: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === dbId) return repo;
    return undefined;
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER.login) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(VIEWER.login, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER.login,
      name,
      fullName: `${VIEWER.login}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.globalSeq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      issueSeq: 0,
      commentSeq: 0,
    };
    this.nextRepoId += 1;
    this.globalSeq += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -------------------------------------------------------------------------
  // git objects and refs
  // -------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** All refs sorted by name: branches then tags, HEAD first when asked. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  defaultBranchTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Make a commit object on top of `parent` (or a root commit) changing one tree. */
  makeCommit(
    repo: Repo,
    treeOid: string,
    parents: string[],
    message: string,
  ): { oid: string; data: Buffer } {
    const ts = COMMIT_EPOCH + this.globalSeq;
    this.globalSeq += 1;
    const data = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: ts,
    });
    const oid = this.putObject(repo, 'commit', data);
    return { oid, data };
  }

  /** The commit message stored for a commit (verbatim, as the contents API received it). */
  commitMessage(repo: Repo, oid: string): string {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return '';
    return parseCommit(obj.data).message;
  }

  /** Commits reachable from `tip`, newest-first (parents after the commit). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [peelToCommit(repo.objects, tip)];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Resolve a ref name, branch name or oid to a commit oid, or null. */
  resolveToCommit(repo: Repo, ref: string): string | null {
    if (isOid(ref)) {
      const obj = repo.objects.get(ref);
      if (!obj) return null;
      return peelToCommit(repo.objects, ref);
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const tip = repo.refs.get(full);
    if (!tip) return null;
    return peelToCommit(repo.objects, tip);
  }

  /** The tree oid of a commit. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Read a file's blob at a commit's tree. */
  readFileAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const treeOid = this.commitTree(repo, commitOid);
    if (!treeOid) return null;
    const flat = flattenTree(repo.objects.get.bind(repo.objects), treeOid);
    const entry = flat.get(path);
    if (!entry) return null;
    const obj = repo.objects.get(entry.oid);
    if (!obj || obj.type !== 'blob') return null;
    return { oid: entry.oid, data: obj.data };
  }

  /** List a directory at a commit's tree: entries directly under `dir` ('' = root). */
  listDirAt(
    repo: Repo,
    commitOid: string,
    dir: string,
  ): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }> | null {
    const treeOid = this.commitTree(repo, commitOid);
    if (!treeOid) return null;
    const out: Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }> = [];
    const walk = (oid: string, prefix: string): boolean => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return false;
      if (prefix === dir) {
        for (const entry of parseTree(obj.data)) {
          out.push({
            name: entry.name,
            path: dir === '' ? entry.name : `${dir}/${entry.name}`,
            type: entry.mode === '40000' ? 'dir' : 'file',
            sha: entry.oid,
          });
        }
        return true;
      }
      if (dir.startsWith(`${prefix}/`) || (prefix === '' && dir !== '')) {
        const next = prefix === '' ? dir.split('/')[0] : dir.slice(prefix.length + 1).split('/')[0];
        for (const entry of parseTree(obj.data)) {
          if (entry.name === next && entry.mode === '40000') {
            return walk(entry.oid, prefix === '' ? next : `${prefix}/${next}`);
          }
        }
      }
      return false;
    };
    if (dir === '') {
      walk(treeOid, '');
      return out;
    }
    return walk(treeOid, '') ? out : null;
  }

  /** Apply a file change (set/delete) on a branch, creating a commit. Returns the commit oid. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitOid: string; blobOid: string | null } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const baseTree = tip ? this.commitTree(repo, peelToCommit(repo.objects, tip)) : null;
    const changes = new Map<string, Buffer | null>();
    changes.set(path, content);
    const newTree = updateTree(repo.objects, baseTree, changes);
    const parents = tip ? [peelToCommit(repo.objects, tip)] : [];
    const { oid } = this.makeCommit(repo, newTree, parents, message);
    repo.refs.set(ref, oid);
    let blobOid: string | null = null;
    if (content !== null) {
      blobOid = hashObject('blob', content);
      this.putObject(repo, 'blob', content);
    }
    return { commitOid: oid, blobOid };
  }

  // -------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------

  nextNumber(repo: Repo): number {
    repo.issueSeq += 1;
    return repo.issueSeq;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = this.nextNumber(repo);
    const issue: Issue = {
      number,
      id: globalId('Issue', repo.id, number),
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.globalSeq,
      repoDbId: repo.id,
    };
    this.globalSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    const issue = this.findIssue(repo, issueNumber);
    if (!issue) return null;
    repo.commentSeq += 1;
    const comment: Comment = {
      id: repo.commentSeq,
      globalId: globalId('IssueComment', repo.id, issueNumber, repo.commentSeq),
      body,
      createdSeq: this.globalSeq,
    };
    this.globalSeq += 1;
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    return repo.comments.get(issueNumber) ?? [];
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip) return { error: `head branch ${head} does not exist` };
    if (!baseTip) return { error: `base branch ${base} does not exist` };
    const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
    if (existing) return { error: `a pull request from ${head} to ${base} already exists` };
    const number = this.nextNumber(repo);
    const pull: Pull = {
      number,
      id: globalId('PullRequest', repo.id, number),
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha: peelToCommit(repo.objects, headTip),
      baseSha: peelToCommit(repo.objects, baseTip),
      createdSeq: this.globalSeq,
      repoDbId: repo.id,
    };
    this.globalSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The diff merge-base -> head for a pull request. */
  pullDiff(repo: Repo, pull: Pull): FileDiff[] {
    const lookup = repo.objects.get.bind(repo.objects);
    const base = mergeBase(lookup, pull.headSha, pull.baseSha);
    const baseTree = base ? this.commitTree(repo, base) : null;
    const headTree = this.commitTree(repo, pull.headSha);
    return diffTrees(lookup, baseTree, headTree);
  }

  /** Whether merging this pull would conflict with the base branch's current tip. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const lookup = repo.objects.get.bind(repo.objects);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return true;
    const baseTipCommit = peelToCommit(repo.objects, baseTip);
    const mergeBaseOid = mergeBase(lookup, pull.headSha, baseTipCommit);
    if (!mergeBaseOid) return true;
    const baseTree = this.commitTree(repo, mergeBaseOid);
    const headTree = this.commitTree(repo, pull.headSha);
    const tipTree = this.commitTree(repo, baseTipCommit);
    const headDiff = diffTrees(lookup, baseTree, headTree);
    const baseDiff = diffTrees(lookup, baseTree, tipTree);
    const baseChanged = new Map<string, FileDiff>();
    for (const d of baseDiff) baseChanged.set(d.path, d);
    const headFlat = flattenTree(lookup, headTree);
    const tipFlat = flattenTree(lookup, tipTree);
    for (const d of headDiff) {
      const b = baseChanged.get(d.path);
      if (!b) continue;
      // Both sides changed the path: conflict unless the results agree.
      const headEntry = headFlat.get(d.path);
      const tipEntry = tipFlat.get(d.path);
      const headOid = headEntry ? headEntry.oid : null;
      const tipOid = tipEntry ? tipEntry.oid : null;
      if (headOid !== tipOid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid or an error. */
  mergePull(repo: Repo, pull: Pull): { commitOid: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'pull request is already closed', status: 405 };
    if (this.pullConflicts(repo, pull)) return { error: 'merge conflict', status: 405 };
    const lookup = repo.objects.get.bind(repo.objects);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
    const baseTipCommit = peelToCommit(repo.objects, baseTip);
    const mergeBaseOid = mergeBase(lookup, pull.headSha, baseTipCommit);
    const baseTree = mergeBaseOid ? this.commitTree(repo, mergeBaseOid) : null;
    const headTree = this.commitTree(repo, pull.headSha);
    const tipTree = this.commitTree(repo, baseTipCommit);
    const headDiff = diffTrees(lookup, baseTree, headTree);
    const changes = new Map<string, Buffer | null>();
    for (const d of headDiff) {
      if (d.status === 'removed') changes.set(d.path, null);
      else {
        const obj = d.newOid ? repo.objects.get(d.newOid) : undefined;
        if (!obj) return { error: 'missing object for merge', status: 500 };
        changes.set(d.path, obj.data);
      }
    }
    const newTree = updateTree(repo.objects, tipTree, changes);
    const { oid } = this.makeCommit(repo, newTree, [baseTipCommit], `Squash merge pull request #${pull.number}: ${pull.title}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = new Date().toISOString();
    pull.merge_commit_sha = oid;
    return { commitOid: oid };
  }

  /** Mergeable state for GraphQL: MERGEABLE / CONFLICTING / UNKNOWN. */
  mergeableState(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') return 'UNKNOWN';
    try {
      return this.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    } catch {
      return 'UNKNOWN';
    }
  }
}

// ---------------------------------------------------------------------------
// REST view helpers
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    url: `/api/v3/repos/${repo.fullName}`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    closed_at: issue.state === 'closed' ? '2025-01-02T00:00:00Z' : null,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    closed_at: pull.state === 'closed' ? '2025-01-02T00:00:00Z' : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
    avatar_url: '',
    html_url: `https://github.com/${VIEWER.login}`,
    url: '/api/v3/user',
  };
}
