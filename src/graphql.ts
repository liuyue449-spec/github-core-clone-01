// GraphQL v4: a small parser and executor for the documents gh / github-mcp-server
// send (viewer, repository reads, issue/PR reads, the five mutations, __type probes,
// node(id:) and operation batching). No dependencies.

import {
  decodeGlobalId,
  globalId,
  VIEWER,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let value = '';
      while (i < input.length && /[0-9.eE+-]/.test(input[i]!)) { value += input[i]; i += 1; }
      tokens.push(value.includes('.') || value.includes('e') || value.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let value = '';
      while (i < input.length && /[_A-Za-z0-9]/.test(input[i]!)) { value += input[i]; i += 1; }
      tokens.push({ kind: 'name', value });
      continue;
    }
    if (input.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value as string;
    }
    const variables: OperationNode['variables'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const varType = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, type: varType, defaultValue });
      }
      this.next();
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseType(): string {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') { this.next(); out += '!'; }
      return out;
    }
    if (token.kind !== 'name') throw new Error(`expected a type, got ${JSON.stringify(token)}`);
    let out = token.value;
    if (this.peek().kind === 'punct' && this.peek().value === '!') { this.next(); out += '!'; }
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: FieldNode['args'] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.next();
      }
      const sub: SelectionNode[] = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    this.next();
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------------------
// schema knowledge
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  User: ['login', 'id', 'name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name'],
  IssueComment: ['id', 'body', 'author'],
  CommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

class GraphQLError extends Error {}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
}

function resolveValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable': {
      if (!(node.name in ctx.variables)) throw new GraphQLError(`Variable $${node.name} was not provided`);
      return ctx.variables[node.name];
    }
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((value) => resolveValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : -1;
  } catch {
    return -1;
  }
}

interface TypedValue {
  type: string;
  value: unknown;
}

function resolveSelections(selections: SelectionNode[], parent: TypedValue, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== parent.type) continue;
      Object.assign(out, resolveSelections(selection.selections, parent, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(selection, parent, ctx);
  }
  return out;
}

function unknownField(type: string, field: string): never {
  throw new GraphQLError(`Cannot query field "${field}" on type "${type}".`);
}

function resolveField(field: FieldNode, parent: TypedValue, ctx: Ctx): unknown {
  const allowed = TYPE_FIELDS[parent.type];
  if (allowed && !allowed.includes(field.name)) unknownField(parent.type, field.name);
  const args = argsOf(field, ctx);
  const store = ctx.store;

  // Root query / mutation.
  if (parent.type === 'Query') {
    if (field.name === 'viewer') {
      return resolveSelections(field.selections, { type: 'User', value: null }, ctx);
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
      if (!repo) return null;
      return resolveSelections(field.selections, { type: 'Repository', value: repo }, ctx);
    }
    if (field.name === 'node') {
      const id = args.id as string;
      const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = store.getRepoByDbId(Number(decoded.parts[0]));
        if (!repo) return null;
        return resolveSelections(field.selections, { type: 'Repository', value: repo }, ctx);
      }
      if (decoded.kind === 'Issue') {
        const repo = store.getRepoByDbId(Number(decoded.parts[0]));
        const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[1]));
        if (!issue || !repo) return null;
        return resolveSelections(field.selections, { type: 'Issue', value: { repo, issue } }, ctx);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = store.getRepoByDbId(Number(decoded.parts[0]));
        const pull = repo?.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
        if (!pull || !repo) return null;
        return resolveSelections(field.selections, { type: 'PullRequest', value: { repo, pull } }, ctx);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      const typeInfo: Record<string, unknown> = { name };
      if (TYPE_FIELDS[name]) typeInfo.kind = 'OBJECT';
      else if (TYPE_ENUM_VALUES[name]) typeInfo.kind = 'ENUM';
      else return null;
      return resolveSelections(field.selections, { type: '__Type', value: { name, ...typeInfo } }, ctx);
    }
  }

  if (parent.type === 'Mutation') {
    return resolveMutation(field, args, ctx);
  }

  // Mutation payloads.
  if (parent.type === 'CreateIssuePayload' || parent.type === 'CloseIssuePayload') {
    const value = parent.value as { repo: Repo; issue: Issue };
    if (field.name === 'issue') return resolveSelections(field.selections, { type: 'Issue', value: { repo: value.repo, issue: value.issue } }, ctx);
    if (field.name === 'clientMutationId') return null;
  }
  if (parent.type === 'CreatePullRequestPayload' || parent.type === 'MergePullRequestPayload') {
    const value = parent.value as { repo: Repo; pull: Pull };
    if (field.name === 'pullRequest') return resolveSelections(field.selections, { type: 'PullRequest', value: { repo: value.repo, pull: value.pull } }, ctx);
    if (field.name === 'clientMutationId') return null;
  }
  if (parent.type === 'AddCommentPayload') {
    const value = parent.value as { repo: Repo; comment: Comment };
    if (field.name === 'commentEdge') return resolveSelections(field.selections, { type: 'CommentEdge', value }, ctx);
    if (field.name === 'clientMutationId') return null;
  }
  if (parent.type === 'CommentEdge') {
    const value = parent.value as { comment: Comment };
    if (field.name === 'node') return resolveSelections(field.selections, { type: 'IssueComment', value: value.comment }, ctx);
    if (field.name === 'cursor') return null;
  }
  if (parent.type === 'IssueComment') {
    if (field.name === 'id') return (parent.value as Comment).globalId;
    if (field.name === 'body') return (parent.value as Comment).body;
    if (field.name === 'author') return resolveSelections(field.selections, { type: 'User', value: null }, ctx);
  }

  if (parent.type === 'Repository') {
    const repo = parent.value as Repo;
    switch (field.name) {
      case 'id': return globalId('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'owner': return resolveSelections(field.selections, { type: 'User', value: null }, ctx);
      case 'defaultBranchRef': {
        const tip = store.defaultBranchTip(repo);
        if (!tip) return null;
        return resolveSelections(field.selections, { type: 'Ref', value: repo.defaultBranch }, ctx);
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const issue = repo.issues.find((entry) => entry.number === (args.number as number));
        if (!issue) return null;
        return resolveSelections(field.selections, { type: 'Issue', value: { repo, issue } }, ctx);
      }
      case 'issues': return resolveIssueConnection(repo, field, args, ctx);
      case 'pullRequest': {
        const pull = repo.pulls.find((entry) => entry.number === (args.number as number));
        if (!pull) return null;
        return resolveSelections(field.selections, { type: 'PullRequest', value: { repo, pull } }, ctx);
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = [...repo.pulls]
          .filter((pull) => pull.state === 'open')
          .sort((a, b) => b.createdSeq - a.createdSeq)
          .slice(0, first);
        const value = { nodes: nodes.map((pull) => ({ repo, pull })), pageInfo: { hasNextPage: false, endCursor: null } };
        return resolveSelections(field.selections, { type: 'PullRequestConnection', value }, ctx);
      }
    }
  }

  if (parent.type === 'User') {
    if (field.name === 'login') return VIEWER.login;
    if (field.name === 'id') return globalId('User', VIEWER.id);
    if (field.name === 'name') return VIEWER.name;
  }

  if (parent.type === 'Ref') {
    if (field.name === 'name') return parent.value as string;
  }

  if (parent.type === 'Issue') {
    const { repo, issue } = parent.value as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issueState(issue);
      case 'url': return `https://github.com/${repo.fullName}/issues/${issue.number}`;
      case 'createdAt': return '2025-01-01T00:00:00Z';
      case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'closedAt': return issue.state === 'closed' ? '2025-01-02T00:00:00Z' : null;
    }
  }

  if (parent.type === 'PullRequest') {
    const { repo, pull } = parent.value as { repo: Repo; pull: Pull };
    switch (field.name) {
      case 'id': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pullState(pull);
      case 'merged': return pull.merged;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'mergeable': return store.mergeableState(repo, pull);
      case 'url': return `https://github.com/${repo.fullName}/pull/${pull.number}`;
      case 'createdAt': return '2025-01-01T00:00:00Z';
      case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'closedAt': return pull.state === 'closed' ? '2025-01-02T00:00:00Z' : null;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const diffs = store.pullDiff(repo, pull).slice(0, first);
        const value = { nodes: diffs.map((d) => ({ path: d.path })), pageInfo: { hasNextPage: false, endCursor: null } };
        return resolveSelections(field.selections, { type: 'PullRequestChangedFileConnection', value }, ctx);
      }
    }
  }

  if (parent.type === 'IssueConnection' || parent.type === 'PullRequestConnection' || parent.type === 'PullRequestChangedFileConnection') {
    const value = parent.value as { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') {
      const itemType = parent.type === 'IssueConnection' ? 'Issue' : parent.type === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return value.nodes.map((node) => resolveSelections(field.selections, { type: itemType, value: node }, ctx));
    }
    if (field.name === 'pageInfo') {
      return resolveSelections(field.selections, { type: 'PageInfo', value: value.pageInfo }, ctx);
    }
    if (field.name === 'totalCount') return value.nodes.length;
  }

  if (parent.type === 'PullRequestChangedFile') {
    if (field.name === 'path') return (parent.value as { path: string }).path;
  }

  if (parent.type === 'PageInfo') {
    const info = parent.value as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return info.hasNextPage;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'endCursor') return info.endCursor;
    if (field.name === 'startCursor') return null;
  }

  if (parent.type === '__Type') {
    const info = parent.value as { name: string };
    if (field.name === 'name') return info.name;
    if (field.name === 'kind') return TYPE_FIELDS[info.name] ? 'OBJECT' : 'ENUM';
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[info.name] ?? [];
      return names.map((name) => resolveSelections(field.selections, { type: '__Field', value: { name } }, ctx));
    }
    if (field.name === 'enumValues') {
      const names = TYPE_ENUM_VALUES[info.name] ?? [];
      return names.map((name) => resolveSelections(field.selections, { type: '__EnumValue', value: { name } }, ctx));
    }
    if (field.name === 'description') return null;
  }

  if (parent.type === '__Field' || parent.type === '__EnumValue') {
    if (field.name === 'name') return (parent.value as { name: string }).name;
    if (field.name === 'description') return null;
  }

  unknownField(parent.type, field.name);
}

function resolveIssueConnection(repo: Repo, field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  let issues = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && orderBy.field === 'CREATED_AT') {
    issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  } else {
    issues.sort((a, b) => a.createdSeq - b.createdSeq);
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex + 1;
  const page = issues.slice(start, start + first);
  const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : null;
  const hasNextPage = start + page.length < issues.length;
  const value = {
    nodes: page.map((issue) => ({ repo, issue })),
    pageInfo: { hasNextPage, endCursor },
  };
  return resolveSelections(field.selections, { type: 'IssueConnection', value }, ctx);
}

function resolveMutation(field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === 'createIssue') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? store.getRepoByDbId(Number(decoded.parts[0])) : undefined;
    if (!repo) throw new GraphQLError('createIssue: repository not found');
    const title = input.title as string;
    if (typeof title !== 'string' || title === '') throw new GraphQLError('createIssue: title is required');
    const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
    return resolveSelections(field.selections, { type: 'CreateIssuePayload', value: { repo, issue } }, ctx);
  }
  if (field.name === 'closeIssue') {
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    const repo = decoded?.kind === 'Issue' ? store.getRepoByDbId(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((entry) => entry.number === Number(decoded?.parts[1]));
    if (!repo || !issue) throw new GraphQLError('closeIssue: issue not found');
    issue.state = 'closed';
    return resolveSelections(field.selections, { type: 'CloseIssuePayload', value: { repo, issue } }, ctx);
  }
  if (field.name === 'createPullRequest') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? store.getRepoByDbId(Number(decoded.parts[0])) : undefined;
    if (!repo) throw new GraphQLError('createPullRequest: repository not found');
    const pull = store.createPull(
      repo,
      input.title as string,
      typeof input.body === 'string' ? input.body : '',
      input.headRefName as string,
      input.baseRefName as string,
    );
    if ('error' in pull) throw new GraphQLError(`createPullRequest: ${pull.error}`);
    return resolveSelections(field.selections, { type: 'CreatePullRequestPayload', value: { repo, pull } }, ctx);
  }
  if (field.name === 'mergePullRequest') {
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    const repo = decoded?.kind === 'PullRequest' ? store.getRepoByDbId(Number(decoded.parts[0])) : undefined;
    const pull = repo?.pulls.find((entry) => entry.number === Number(decoded?.parts[1]));
    if (!repo || !pull) throw new GraphQLError('mergePullRequest: pull request not found');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) throw new GraphQLError(`mergePullRequest: ${merged.error}`);
    return resolveSelections(field.selections, { type: 'MergePullRequestPayload', value: { repo, pull } }, ctx);
  }
  if (field.name === 'addComment') {
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    const repo = decoded?.kind === 'Issue' ? store.getRepoByDbId(Number(decoded.parts[0])) : undefined;
    const issueNumber = Number(decoded?.parts[1]);
    const comment = repo ? store.addComment(repo, issueNumber, input.body as string) : null;
    if (!repo || !comment) throw new GraphQLError('addComment: subject not found');
    return resolveSelections(field.selections, { type: 'AddCommentPayload', value: { repo, comment } }, ctx);
  }
  unknownField('Mutation', field.name);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const responses = body.map((operation) => runOperation(store, operation));
    return { status: 200, body: responses };
  }
  return { status: 200, body: runOperation(store, body) };
}

function runOperation(store: Store, operation: unknown): Record<string, unknown> {
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with a query string' }] };
  }
  const query = (operation as Record<string, unknown>).query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request needs a query string' }] };
  }
  const variables = (operation as Record<string, unknown>).variables;
  const operationName = (operation as Record<string, unknown>).operationName;
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'failed to parse the GraphQL document' }] };
  }
  const selected =
    typeof operationName === 'string'
      ? operations.find((op) => op.name === operationName) ?? operations[0]
      : operations[0];
  if (!selected) return { data: null, errors: [{ message: 'no operation in the GraphQL document' }] };
  const ctx: Ctx = {
    store,
    variables: (variables && typeof variables === 'object' && !Array.isArray(variables) ? variables : {}) as Record<string, unknown>,
  };
  // Apply variable defaults.
  for (const def of selected.variables) {
    if (!(def.name in ctx.variables) && def.defaultValue) {
      try { ctx.variables[def.name] = resolveValue(def.defaultValue, ctx); } catch { /* ignore */ }
    }
  }
  try {
    const rootType = selected.type === 'mutation' ? 'Mutation' : 'Query';
    const data = resolveSelections(selected.selections, { type: rootType, value: null }, ctx);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
