// Model Context Protocol endpoint (POST /mcp): the 2026-07-28 modern revision
// (server/discover, no handshake, no session) plus the legacy initialize handshake.
// JSON-RPC 2.0 over plain JSON. Node built-ins only.

import { issueJson, pullJson, repoJson, VIEWER, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpReply {
  status: number;
  body: unknown;
  noBody?: boolean;
}

function rpcResult(id: string | number | null, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolTextResult(obj: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Execute one tool call against the store. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return toolErrorResult(`Unknown tool: ${name}`);
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolErrorResult(`Missing required arguments: ${missing.join(', ')}`);
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';

  switch (name) {
    case 'create_repo': {
      const repoNameArg = args.name as string;
      const repo = store.createRepo(repoNameArg, args.private === true, typeof args.description === 'string' ? args.description : '');
      if (!repo) return toolErrorResult(`Repository ${repoNameArg} already exists`);
      return toolTextResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      return toolTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
      return toolTextResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(repo, issue));
      return toolTextResult({ issues });
    }
    case 'get_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const issue = store.findIssue(repo, Number(args.issue_number));
      if (!issue) return toolErrorResult(`Issue #${args.issue_number} not found`);
      return toolTextResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const pull = store.createPull(
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        args.head as string,
        args.base as string,
      );
      if ('error' in pull) return toolErrorResult(pull.error);
      return toolTextResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const pull = store.findPull(repo, Number(args.pull_number));
      if (!pull) return toolErrorResult(`Pull request #${args.pull_number} not found`);
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return toolErrorResult(merged.error);
      return toolTextResult({ merged: true, number: pull.number, state: pull.state, sha: merged.commitOid });
    }
    case 'list_pull_requests': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .map((pull) => pullJson(repo, pull));
      return toolTextResult({ pull_requests: pulls });
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one POST /mcp request. `rawBody` is the exact request text (already read).
 * `authorized` is whether a valid bearer token was presented.
 */
export function handleMcp(store: Store, rawBody: string, authorized: boolean): McpReply {
  let request: RpcRequest;
  try {
    request = JSON.parse(rawBody) as RpcRequest;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return rpcError(typeof request?.id === 'string' || typeof request?.id === 'number' ? request.id : null, -32600, 'Invalid Request');
  }
  const id = request.id === undefined ? null : request.id;
  if (!authorized) {
    return { status: 401, body: { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } } };
  }
  const params = isRecord(request.params) ? request.params : {};
  const method = request.method;

  // Notifications (no id): no response body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null, noBody: true };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (!TOOLS.some((tool) => tool.name === name)) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    return rpcResult(id, callTool(store, name, args));
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
