// gql.ts — a small GraphQL engine: lexer, parser (queries, mutations, variables, aliases,
// fragments, inline fragments, arguments, directives-ignored) and an executor over the forge store,
// with the introspection surface (via __schema and __type) the suite probes.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  OWNER_LOGIN,
  allRepos,
  commentsOf,
  findRepo,
  isoStamp,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { oidOf } from './gitobj.ts';
import { mergePull } from './rest.ts';
import { listDir } from './store.ts';

// ---------------------------------------------------------------- values

export interface GqlErrorEntry {
  message: string;
  locations?: Array<{ line: number; column: number }>;
}

// ---------------------------------------------------------------- lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct';
interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let line = 1;
  let column = 1;
  const advance = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      if (source[at] === '\n') {
        line += 1;
        column = 1;
      } else column += 1;
      at += 1;
    }
  };
  while (at < source.length) {
    const ch = source[at];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      advance(1);
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') advance(1);
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        const text = source.slice(at + 3, end < 0 ? source.length : end);
        advance(end < 0 ? source.length - at : end + 3 - at);
        tokens.push({ kind: 'string', value: text, line: startLine, column: startColumn });
        continue;
      }
      let text = '';
      advance(1);
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const escape = source[at + 1];
          text += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape === 'r' ? '\r' : escape ?? '';
          advance(2);
          continue;
        }
        text += source[at];
        advance(1);
      }
      advance(1);
      tokens.push({ kind: 'string', value: text, line: startLine, column: startColumn });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let text = '';
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at])) {
        text += source[at];
        advance(1);
      }
      tokens.push({ kind: 'name', value: text, line: startLine, column: startColumn });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let text = '';
      if (ch === '-') {
        text += '-';
        advance(1);
      }
      let dotted = false;
      while (at < source.length && /[0-9.eE+-]/.test(source[at])) {
        const inner = source[at];
        if (inner === '.') dotted = true;
        if ((inner === '+' || inner === '-') && !/[eE]/.test(text[text.length - 1] ?? '')) break;
        text += inner;
        advance(1);
      }
      tokens.push({ kind: dotted ? 'float' : 'int', value: text, line: startLine, column: startColumn });
      continue;
    }
    if (ch === '.' && source.startsWith('...', at)) {
      advance(3);
      tokens.push({ kind: 'punct', value: '...', line: startLine, column: startColumn });
      continue;
    }
    if (PUNCT.has(ch)) {
      if (ch === '.' && source.startsWith('...', at)) {
        advance(3);
        tokens.push({ kind: 'punct', value: '...', line: startLine, column: startColumn });
        continue;
      }
      advance(1);
      tokens.push({ kind: 'punct', value: ch, line: startLine, column: startColumn });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${startLine}:${startColumn}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export interface Argument {
  name: string;
  value: ValueNode;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Argument[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Argument[];
  selections: Selection[];
  line: number;
  column: number;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export type Selection = FieldNode | InlineFragmentNode | FragmentSpreadNode;

export interface OperationDefinition {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; typeText: string }>;
  selections: Selection[];
}

export interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: Selection[];
}

export type Definition = OperationDefinition | FragmentDefinition;

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (!token) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    return token;
  }

  private skip(value: string): boolean {
    const token = this.peek();
    if (token && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Definition[] {
    const definitions: Definition[] = [];
    while (this.peek() !== undefined) {
      const token = this.next();
      if (token.value === '{') {
        definitions.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variableDefinitions: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`expected a definition, got ${JSON.stringify(token.value)}`);
      if (token.value === 'fragment') {
        const name = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        definitions.push({ kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.value !== 'query' && token.value !== 'mutation' && token.value !== 'subscription') {
        throw new Error(`unexpected keyword ${JSON.stringify(token.value)}`);
      }
      const operation = token.value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      const afterKeyword = this.peek();
      if (afterKeyword && afterKeyword.kind === 'name' && afterKeyword.value !== '{') name = this.next().value;
      const variableDefinitions: Array<{ name: string; typeText: string }> = [];
      if (this.skip('(')) {
        while (!this.skip(')')) {
          this.expect('$');
          const variableName = this.next().value;
          this.expect(':');
          variableDefinitions.push({ name: variableName, typeText: this.parseTypeText() });
          this.skip(',');
        }
      }
      this.parseDirectives();
      const selections = this.parseSelectionSet();
      definitions.push({ kind: 'operation', operation, name, variableDefinitions, selections });
    }
    if (definitions.length === 0) throw new Error('the document holds no operations');
    return definitions;
  }

  private parseTypeText(): string {
    let text = '';
    if (this.skip('[')) {
      text += '[' + this.parseTypeText() + ']';
      this.expect(']');
    } else {
      text += this.next().value;
    }
    if (this.skip('!')) text += '!';
    return text;
  }

  private parseDirectives(): void {
    while (this.skip('@')) {
      this.next();
      if (this.skip('(')) {
        while (!this.skip(')')) {
          this.parseArgument();
          this.skip(',');
        }
      }
    }
  }

  private parseArgument(): Argument {
    const name = this.next().value;
    this.expect(':');
    return { name, value: this.parseValue() };
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (!token) throw new Error('expected a value');
    if (token.value === '$') {
      this.at += 1;
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'int') {
      this.at += 1;
      return { kind: 'int', value: Number(token.value) };
    }
    if (token.kind === 'float') {
      this.at += 1;
      return { kind: 'float', value: Number(token.value) };
    }
    if (token.kind === 'string') {
      this.at += 1;
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.at += 1;
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.value === '[') {
      this.at += 1;
      const items: ValueNode[] = [];
      while (!this.skip(']')) {
        items.push(this.parseValue());
        this.skip(',');
      }
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      this.at += 1;
      const fields: Argument[] = [];
      while (!this.skip('}')) {
        fields.push(this.parseArgument());
        this.skip(',');
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)} where a value was expected`);
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!this.skip('}')) {
      const token = this.next();
      if (token.value === '...') {
        const ahead = this.peek();
        if (ahead && ahead.value === 'on') {
          this.at += 1;
          const typeCondition = this.next().value;
          this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.parseDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      if (token.kind !== 'name') throw new Error(`expected a field, got ${JSON.stringify(token.value)}`);
      let alias: string | null = null;
      let name = token.value;
      if (this.skip(':')) {
        alias = token.value;
        name = this.next().value;
      }
      const args: Argument[] = [];
      if (this.skip('(')) {
        while (!this.skip(')')) {
          args.push(this.parseArgument());
          this.skip(',');
        }
      }
      this.parseDirectives();
      const ahead = this.peek();
      const children = ahead && ahead.value === '{' ? this.parseSelectionSet() : [];
      const field: FieldNode = { kind: 'field', alias, name, args, selections: children, line: token.line, column: token.column };
      selections.push(field);
      continue;
    }
    return selections;
  }

  private parseSelectionSetFresh(): Selection[] {
    return this.parseSelectionSet();
  }
}

/** Parse one GraphQL document into its definitions. */
export function parseDocument(source: string): Definition[] {
  return new Parser(source).parseDocument();
}

// ---------------------------------------------------------------- execution

type FieldSource = Record<string, unknown>;

function resolveValueNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (!(node.name in variables)) throw new Error(`variable $${node.name} was not provided`);
      return variables[node.name];
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValueNode(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValueNode(field.value, variables);
      return out;
    }
  }
}

function argumentValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const found = field.args.find((arg) => arg.name === name);
  return found === undefined ? undefined : resolveValueNode(found.value, variables);
}

function globalId(kind: string, id: number | string): string {
  return NodeBuffer.from(`${kind}:${id}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  const raw = NodeBuffer.from(id, 'base64').toString('utf8');
  const colon = raw.indexOf(':');
  if (colon < 0) return null;
  return { kind: raw.slice(0, colon), key: raw.slice(colon + 1) };
}

// ---------------------------------------------------------------- the schema (for introspection)

interface SchemaField {
  name: string;
  typeText: string;
  args?: Array<{ name: string; typeText: string }>;
}

interface SchemaType {
  kind: 'OBJECT' | 'SCALAR' | 'ENUM' | 'INTERFACE' | 'UNION' | 'INPUT_OBJECT';
  name: string;
  description?: string;
  fields?: SchemaField[];
  enumValues?: string[];
}

const T = (name: string, fields: SchemaField[]): SchemaType => ({ kind: 'OBJECT', name, fields });
const ENUM = (name: string, values: string[]): SchemaType => ({ kind: 'ENUM', name, enumValues: values });
const SCALAR = (name: string): SchemaType => ({ kind: 'SCALAR', name });

const SCHEMA_TYPES: SchemaType[] = [
  T('Query', [
    { name: 'viewer', typeText: 'User!' },
    { name: 'repository', typeText: 'Repository', args: [{ name: 'owner', typeText: 'String!' }, { name: 'name', typeText: 'String!' }] },
    { name: 'node', typeText: 'Node', args: [{ name: 'id', typeText: 'ID!' }] },
  ]),
  T('Mutation', [
    { name: 'createIssue', typeText: 'CreateIssuePayload', args: [{ name: 'input', typeText: 'CreateIssueInput!' }] },
    { name: 'closeIssue', typeText: 'CloseIssuePayload', args: [{ name: 'input', typeText: 'CloseIssueInput!' }] },
    { name: 'createPullRequest', typeText: 'CreatePullRequestPayload', args: [{ name: 'input', typeText: 'CreatePullRequestInput!' }] },
    { name: 'mergePullRequest', typeText: 'MergePullRequestPayload', args: [{ name: 'input', typeText: 'MergePullRequestInput!' }] },
    { name: 'addComment', typeText: 'AddCommentPayload', args: [{ name: 'input', typeText: 'AddCommentInput!' }] },
  ]),
  T('User', [
    { name: 'id', typeText: 'ID!' },
    { name: 'login', typeText: 'String!' },
    { name: 'name', typeText: 'String' },
    { name: 'email', typeText: 'String' },
  ]),
  T('Node', [
    { name: 'id', typeText: 'ID!' },
  ]),
  T('Repository', [
    { name: 'id', typeText: 'ID!' },
    { name: 'databaseId', typeText: 'Int!' },
    { name: 'name', typeText: 'String!' },
    { name: 'nameWithOwner', typeText: 'String!' },
    { name: 'owner', typeText: 'User!' },
    { name: 'description', typeText: 'String' },
    { name: 'defaultBranchRef', typeText: 'Ref' },
    { name: 'viewerPermission', typeText: 'RepositoryPermission!' },
    { name: 'hasIssuesEnabled', typeText: 'Boolean!' },
    { name: 'isPrivate', typeText: 'Boolean!' },
    { name: 'url', typeText: 'URI!' },
    { name: 'createdAt', typeText: 'DateTime!' },
    { name: 'updatedAt', typeText: 'DateTime!' },
    { name: 'issue', typeText: 'Issue', args: [{ name: 'number', typeText: 'Int!' }] },
    { name: 'issues', typeText: 'IssueConnection!', args: [
      { name: 'first', typeText: 'Int' }, { name: 'after', typeText: 'String' },
      { name: 'states', typeText: '[IssueState!]' },
      { name: 'orderBy', typeText: 'IssueOrder' },
      { name: 'filterBy', typeText: 'IssueFilters' },
    ] },
    { name: 'pullRequest', typeText: 'PullRequest', args: [{ name: 'number', typeText: 'Int!' }] },
    { name: 'pullRequests', typeText: 'PullRequestConnection!', args: [{ name: 'first', typeText: 'Int' }, { name: 'after', typeText: 'String' }, { name: 'states', typeText: '[PullRequestState!]' }] },
    { name: 'ref', typeText: 'Ref', args: [{ name: 'refName', typeText: 'String!' }] },
    { name: 'refs', typeText: 'RefConnection', args: [{ name: 'first', typeText: 'Int' }, { name: 'refPrefix', typeText: 'String!' }] },
  ]),
  T('Ref', [
    { name: 'id', typeText: 'ID!' },
    { name: 'name', typeText: 'String!' },
    { name: 'target', typeText: 'GitObject' },
  ]),
  T('GitObject', [
    { name: 'id', typeText: 'ID!' },
    { name: 'oid', typeText: 'GitObjectID!' },
  ]),
  T('Commit', [
    { name: 'id', typeText: 'ID!' },
    { name: 'oid', typeText: 'GitObjectID!' },
    { name: 'message', typeText: 'String!' },
    { name: 'messageHeadline', typeText: 'String!' },
  ]),
  T('Issue', [
    { name: 'id', typeText: 'ID!' },
    { name: 'number', typeText: 'Int!' },
    { name: 'title', typeText: 'String!' },
    { name: 'body', typeText: 'String' },
    { name: 'state', typeText: 'IssueState!' },
    { name: 'author', typeText: 'Actor' },
    { name: 'createdAt', typeText: 'DateTime!' },
    { name: 'updatedAt', typeText: 'DateTime!' },
    { name: 'closedAt', typeText: 'DateTime' },
    { name: 'comments', typeText: 'IssueCommentConnection!', args: [{ name: 'first', typeText: 'Int' }] },
    { name: 'labels', typeText: 'LabelConnection', args: [{ name: 'first', typeText: 'Int' }] },
    { name: 'repository', typeText: 'Repository!' },
    { name: 'url', typeText: 'URI!' },
    { name: 'viewerCanUpdate', typeText: 'Boolean!' },
  ]),
  T('IssueComment', [
    { name: 'id', typeText: 'ID!' },
    { name: 'body', typeText: 'String!' },
    { name: 'author', typeText: 'Actor' },
    { name: 'createdAt', typeText: 'DateTime!' },
    { name: 'updatedAt', typeText: 'DateTime!' },
  ]),
  T('IssueConnection', [
    { name: 'nodes', typeText: '[Issue]' },
    { name: 'edges', typeText: '[IssueEdge]' },
    { name: 'pageInfo', typeText: 'PageInfo!' },
    { name: 'totalCount', typeText: 'Int!' },
  ]),
  T('IssueEdge', [
    { name: 'node', typeText: 'Issue' },
    { name: 'cursor', typeText: 'String!' },
  ]),
  T('Label', [
    { name: 'id', typeText: 'ID!' },
    { name: 'name', typeText: 'String!' },
    { name: 'color', typeText: 'String!' },
    { name: 'description', typeText: 'String' },
  ]),
  T('LabelConnection', [
    { name: 'nodes', typeText: '[Label]' },
    { name: 'totalCount', typeText: 'Int!' },
  ]),
  T('PullRequest', [
    { name: 'id', typeText: 'ID!' },
    { name: 'number', typeText: 'Int!' },
    { name: 'title', typeText: 'String!' },
    { name: 'body', typeText: 'String' },
    { name: 'state', typeText: 'PullRequestState!' },
    { name: 'merged', typeText: 'Boolean!' },
    { name: 'mergedAt', typeText: 'DateTime' },
    { name: 'headRefName', typeText: 'String!' },
    { name: 'headRefOid', typeText: 'GitObjectID!' },
    { name: 'baseRefName', typeText: 'String!' },
    { name: 'baseRefOid', typeText: 'GitObjectID!' },
    { name: 'mergeable', typeText: 'MergeableState!' },
    { name: 'files', typeText: 'PullRequestChangedFileConnection', args: [{ name: 'first', typeText: 'Int' }] },
    { name: 'author', typeText: 'Actor' },
    { name: 'createdAt', typeText: 'DateTime!' },
    { name: 'updatedAt', typeText: 'DateTime!' },
    { name: 'mergeCommit', typeText: 'Commit' },
    { name: 'url', typeText: 'URI!' },
    { name: 'additions', typeText: 'Int!' },
    { name: 'deletions', typeText: 'Int!' },
    { name: 'changedFiles', typeText: 'Int!' },
  ]),
  T('PullRequestConnection', [
    { name: 'nodes', typeText: '[PullRequest]' },
    { name: 'edges', typeText: '[PullRequestEdge]' },
    { name: 'pageInfo', typeText: 'PageInfo!' },
    { name: 'totalCount', typeText: 'Int!' },
  ]),
  T('PullRequestEdge', [
    { name: 'node', typeText: 'PullRequest' },
    { name: 'cursor', typeText: 'String!' },
  ]),
  T('PullRequestChangedFileConnection', [
    { name: 'nodes', typeText: '[PullRequestChangedFile]' },
    { name: 'edges', typeText: '[PullRequestChangedFileEdge]' },
    { name: 'pageInfo', typeText: 'PageInfo!' },
    { name: 'totalCount', typeText: 'Int!' },
  ]),
  T('PullRequestChangedFileEdge', [
    { name: 'node', typeText: 'PullRequestChangedFile' },
    { name: 'cursor', typeText: 'String!' },
  ]),
  T('PullRequestChangedFile', [
    { name: 'path', typeText: 'String!' },
    { name: 'additions', typeText: 'Int!' },
    { name: 'deletions', typeText: 'Int!' },
  ]),
  T('PageInfo', [
    { name: 'hasNextPage', typeText: 'Boolean!' },
    { name: 'hasPreviousPage', typeText: 'Boolean!' },
    { name: 'startCursor', typeText: 'String' },
    { name: 'endCursor', typeText: 'String' },
  ]),
  T('CreateIssuePayload', [{ name: 'issue', typeText: 'Issue' }]),
  T('CloseIssuePayload', [{ name: 'issue', typeText: 'Issue' }]),
  T('CreatePullRequestPayload', [{ name: 'pullRequest', typeText: 'PullRequest' }]),
  T('MergePullRequestPayload', [{ name: 'pullRequest', typeText: 'PullRequest' }]),
  T('AddCommentPayload', [{ name: 'commentEdge', typeText: 'IssueCommentEdge' }, { name: 'subject', typeText: 'Node' }]),
  T('IssueCommentEdge', [{ name: 'node', typeText: 'IssueComment' }, { name: 'cursor', typeText: 'String!' }]),
  T('RefConnection', [
    { name: 'nodes', typeText: '[Ref]' },
    { name: 'pageInfo', typeText: 'PageInfo!' },
    { name: 'totalCount', typeText: 'Int!' },
  ]),
  { kind: 'INTERFACE', name: 'Actor', fields: [{ name: 'login', typeText: 'String!' }, { name: 'id', typeText: 'ID!' }] },
  ENUM('IssueState', ['OPEN', 'CLOSED']),
  ENUM('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']),
  ENUM('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  ENUM('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
  ENUM('SearchType', ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION']),
  ENUM('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']),
  ENUM('OrderDirection', ['ASC', 'DESC']),
  ENUM('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']),
  SCALAR('String'),
  SCALAR('Int'),
  SCALAR('Boolean'),
  SCALAR('ID'),
  SCALAR('DateTime'),
  SCALAR('URI'),
  SCALAR('GitObjectID'),
];

const SCHEMA_BY_NAME = new Map(SCHEMA_TYPES.map((entry) => [entry.name, entry]));

// ---------------------------------------------------------------- the executor

interface ExecState {
  errors: GqlErrorEntry[];
  fragments: Map<string, FragmentDefinition>;
  variables: Record<string, unknown>;
  repo: Repo;
}

function addError(state: ExecState, message: string, node?: { line: number; column: number }): void {
  const entry: GqlErrorEntry = { message };
  if (node) entry.locations = [{ line: node.line, column: node.column }];
  state.errors.push(entry);
}

function mergeSelections(state: ExecState, selections: Selection[], into: Selection[]): void {
  for (const item of selections) {
    if (item.kind === 'spread') {
      const fragment = state.fragments.get(item.name);
      if (!fragment) {
        addError(state, `Fragment "${item.name}" was not defined in the document`);
        continue;
      }
      into.push(...fragment.selections);
      continue;
    }
    into.push(item);
  }
}

function fieldLabel(field: FieldNode): string {
  return field.alias ?? field.name;
}

function connectionPage<T>(items: T[], first: unknown, after: unknown): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  const size = typeof first === 'number' && first > 0 ? Math.trunc(first) : items.length;
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const decoded = NodeBuffer.from(after, 'base64').toString('utf8');
    const index = Number.parseInt(decoded.replace(/^cursor:/, ''), 10);
    start = Number.isFinite(index) ? index + 1 : 0;
  }
  const slice = items.slice(start, start + size);
  return {
    nodes: slice,
    hasNextPage: start + size < items.length,
    endCursor: slice.length > 0 ? NodeBuffer.from(`cursor:${start + slice.length - 1}`).toString('base64') : null,
  };
}

function pageInfoValue(page: { hasNextPage: boolean; endCursor: string | null }): FieldSource {
  return {
    __type: 'PageInfo',
    hasNextPage: page.hasNextPage,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: page.endCursor,
  };
}

function mergeableOf(repo: ExecState['repo'], pull: Pull): string {
  if (pull.merged) return 'MERGEABLE';
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headSha || !baseSha) return 'UNKNOWN';
  return baseSha === pull.baseShaAtCreation ? 'MERGEABLE' : 'CONFLICTING';
}

/** Resolve one field of one typed runtime value; answers a FieldSource or a typed array/scalar. */
function resolveField(state: ExecState, typeName: string, value: FieldSource, field: FieldNode): unknown {
  const key = field.name;
  const repo = state.repo;
  if (typeName === 'User' || typeName === 'Actor') {
    if (key === 'login') return OWNER_LOGIN;
    if (key === 'id') return globalId('User', 1001);
    if (key === 'name') return 'Adai Iversen';
    if (key === 'email') return `${OWNER_LOGIN}@example.invalid`;
    if (key === 'url') return '';
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'Repository') {
    const repo = (value.__repo as Repo | undefined) ?? state.repo;
    if (key === 'id') return value.__id as string;
    if (key === 'databaseId') return repo.id;
    if (key === 'name') return repo.name;
    if (key === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (key === 'owner') return { __type: 'User' };
    if (key === 'description') return repo.description;
    if (key === 'defaultBranchRef') {
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!sha) return null;
      return { __type: 'Ref', name: repo.defaultBranch, oid: sha };
    }
    if (key === 'viewerPermission') return 'ADMIN';
    if (key === 'hasIssuesEnabled') return true;
    if (key === 'isPrivate') return repo.private;
    if (key === 'url') return `https://forge.invalid/${repo.owner}/${repo.name}`;
    if (key === 'createdAt') return isoStamp(repo.createdAt);
    if (key === 'updatedAt') return isoStamp(repo.updatedAt);
    if (key === 'issue') {
      const number = argumentValue(field, 'number', state.variables);
      const issue = repo.issues.get(Number(number));
      return issue ? { __type: 'Issue', issue, __repo: repoOfItem(issue, 'issues') } : null;
    }
    if (key === 'issues') {
      const states = argumentValue(field, 'states', state.variables);
      const order = argumentValue(field, 'orderBy', state.variables) as { field?: string; direction?: string } | undefined;
      const after = argumentValue(field, 'after', state.variables);
      const first = argumentValue(field, 'first', state.variables);
      let list = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) list = list.filter((issue) => (states as string[]).includes(issue.state.toUpperCase()));
      const direction = order?.direction === 'ASC' ? 'asc' : 'desc';
      const orderField = order?.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
      list.sort((a, b) => {
        const left = a[orderField as 'createdAt'].getTime();
        const right = b[orderField as 'createdAt'].getTime();
        const byTime = direction === 'asc' ? left - right : right - left;
        // Equal timestamps keep the suite's contract: ties order by number, DESC.
        return byTime !== 0 ? byTime : b.number - a.number;
      });
      const page = connectionPage(list, first, after);
      return {
        __type: 'IssueConnection',
        issues: page.nodes,
        page,
        totalCount: list.length,
      };
    }
    if (key === 'pullRequest') {
      const number = argumentValue(field, 'number', state.variables);
      const pull = repo.pulls.get(Number(number));
      return pull ? { __type: 'PullRequest', pull, __repo: repoOfItem(pull, 'pulls') } : null;
    }
    if (key === 'pullRequests') {
      const first = argumentValue(field, 'first', state.variables);
      const after = argumentValue(field, 'after', state.variables);
      const states = argumentValue(field, 'states', state.variables);
      let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      if (Array.isArray(states) && states.length > 0) {
        list = list.filter((pull) => {
          const graphqlState = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return (states as string[]).includes(graphqlState);
        });
      }
      const page = connectionPage(list, first, after);
      return { __type: 'PullRequestConnection', pulls: page.nodes, page, totalCount: list.length };
    }
    if (key === 'ref') {
      const refName = String(argumentValue(field, 'refName', state.variables) ?? '');
      const full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
      const sha = repo.refs.get(full);
      return sha ? { __type: 'Ref', name: full, oid: sha } : null;
    }
    if (key === 'refs') {
      const prefix = String(argumentValue(field, 'refPrefix', state.variables) ?? 'refs/');
      const first = argumentValue(field, 'first', state.variables);
      const names = [...repo.refs.keys()].filter((name) => name.startsWith(prefix)).sort();
      const page = connectionPage(names, first, argumentValue(field, 'after', state.variables));
      return { __type: 'RefConnection', names: page.nodes, page, totalCount: names.length };
    }
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'Ref') {
    if (key === 'id') return globalId('Ref', `${value.name}`);
    if (key === 'name') return value.name;
    if (key === 'target') return value.oid ? { __type: 'Commit', oid: value.oid } : null;
    if (key === 'prefix') return 'refs/heads/';
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'Commit' || typeName === 'GitObject') {
    if (key === 'id') return globalId('Commit', value.oid as string);
    if (key === 'oid') return value.oid;
    if (key === 'message') return repo.objects.get(value.oid as string) ? messageOf(repo, value.oid as string) : '';
    if (key === 'messageHeadline') return messageOf(repo, value.oid as string).split('\n')[0] ?? '';
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'Issue') {
    const issue = value.issue as Issue;
    const repo = (value.__repo as Repo | undefined) ?? state.repo;
    if (key === 'id') return globalId('Issue', issue.id);
    if (key === 'number') return issue.number;
    if (key === 'title') return issue.title;
    if (key === 'body') return issue.body;
    if (key === 'state') return issue.state.toUpperCase();
    if (key === 'author') return { __type: 'User' };
    if (key === 'createdAt') return isoStamp(issue.createdAt);
    if (key === 'updatedAt') return isoStamp(issue.updatedAt);
    if (key === 'closedAt') return issue.closedAt ? isoStamp(issue.closedAt) : null;
    if (key === 'comments') {
      const first = argumentValue(field, 'first', state.variables);
      const list = commentsOf(repo, issue.number);
      const page = connectionPage(list, first, argumentValue(field, 'after', state.variables));
      return { __type: 'IssueCommentConnection', comments: page.nodes, page, totalCount: list.length };
    }
    if (key === 'labels') {
      const labels = issue.labels.map((name) => repo.labels.get(name)).filter(Boolean) as Array<{ id: number; name: string; color: string; description: string | null }>;
      return { __type: 'LabelConnection', labels, totalCount: labels.length };
    }
    if (key === 'repository') return repositoryValue(repo);
    if (key === 'url') return '';
    if (key === 'viewerCanUpdate') return true;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'IssueComment') {
    if (key === 'id') return globalId('IssueComment', value.id as number);
    if (key === 'body') return value.body;
    if (key === 'author') return { __type: 'User' };
    if (key === 'createdAt') return isoStamp(value.createdAt as Date);
    if (key === 'updatedAt') return isoStamp(value.updatedAt as Date);
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'IssueCommentConnection') {
    if (key === 'nodes') return (value.comments as Array<FieldSource>).map((comment) => ({ __type: 'IssueComment', ...comment }));
    if (key === 'edges') return (value.comments as Array<FieldSource>).map((comment) => ({ __type: 'IssueCommentEdge', comment }));
    if (key === 'pageInfo') return pageInfoValue(value.page as ReturnType<typeof connectionPage>);
    if (key === 'totalCount') return value.totalCount;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'IssueCommentEdge') {
    if (key === 'node') return value.comment ? { __type: 'IssueComment', ...value.comment } : null;
    if (key === 'cursor') return globalId('IssueCommentCursor', value.comment.id as number);
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'IssueConnection') {
    if (key === 'nodes') return (value.issues as Issue[]).map((issue) => ({ __type: 'Issue', issue, __repo: repoOfItem(issue, 'issues') }));
    if (key === 'edges') return (value.issues as Issue[]).map((issue) => ({ __type: 'IssueEdge', issue }));
    if (key === 'pageInfo') return pageInfoValue(value.page as ReturnType<typeof connectionPage>);
    if (key === 'totalCount') return value.totalCount;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'IssueEdge') {
    if (key === 'node') return { __type: 'Issue', issue: value.issue, __repo: repoOfItem(value.issue as Issue, 'issues') };
    if (key === 'cursor') return NodeBuffer.from(`cursor:${(value.issue as Issue).number}`).toString('base64');
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'LabelConnection') {
    if (key === 'nodes') return (value.labels as Array<FieldSource>).map((label) => ({ __type: 'Label', ...label }));
    if (key === 'totalCount') return value.totalCount;
    if (key === 'pageInfo') return pageInfoValue({ hasNextPage: false, endCursor: null });
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'Label') {
    if (key === 'id') return globalId('Label', value.id as number);
    if (key === 'name') return value.name;
    if (key === 'color') return value.color;
    if (key === 'description') return value.description ?? null;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'PullRequest') {
    const pull = value.pull as Pull;
    const repo = (value.__repo as Repo | undefined) ?? state.repo;
    if (key === 'id') return globalId('PullRequest', pull.id);
    if (key === 'number') return pull.number;
    if (key === 'title') return pull.title;
    if (key === 'body') return pull.body;
    if (key === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (key === 'merged') return pull.merged;
    if (key === 'mergedAt') return pull.mergedAt ? isoStamp(pull.mergedAt) : null;
    if (key === 'headRefName') return pull.head;
    if (key === 'headRefOid') return repo.refs.get(`refs/heads/${pull.head}`) ?? null;
    if (key === 'baseRefName') return pull.base;
    if (key === 'baseRefOid') return repo.refs.get(`refs/heads/${pull.base}`) ?? null;
    if (key === 'mergeable') return mergeableOf(repo, pull);
    if (key === 'files') {
      const first = argumentValue(field, 'first', state.variables);
      const files = pullFileSummaries(repo, pull);
      const page = connectionPage(files, first, null);
      return { __type: 'PullRequestChangedFileConnection', files: page.nodes, page, totalCount: files.length };
    }
    if (key === 'author') return { __type: 'User' };
    if (key === 'createdAt') return isoStamp(pull.createdAt);
    if (key === 'updatedAt') return isoStamp(pull.updatedAt);
    if (key === 'mergeCommit') return pull.mergeCommitSha ? { __type: 'Commit', oid: pull.mergeCommitSha } : null;
    if (key === 'url') return '';
    if (key === 'additions' || key === 'deletions' || key === 'changedFiles') {
      const files = pullFileSummaries(repo, pull);
      if (key === 'additions') return files.reduce((sum, file) => sum + file.additions, 0);
      if (key === 'deletions') return files.reduce((sum, file) => sum + file.deletions, 0);
      return files.length;
    }
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'PullRequestConnection') {
    if (key === 'nodes') return (value.pulls as Pull[]).map((pull) => ({ __type: 'PullRequest', pull, __repo: repoOfItem(pull, 'pulls') }));
    if (key === 'edges') return (value.pulls as Pull[]).map((pull) => ({ __type: 'PullRequestEdge', pull }));
    if (key === 'pageInfo') return pageInfoValue(value.page as ReturnType<typeof connectionPage>);
    if (key === 'totalCount') return value.totalCount;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'PullRequestEdge') {
    if (key === 'node') return { __type: 'PullRequest', pull: value.pull, __repo: repoOfItem(value.pull as Pull, 'pulls') };
    if (key === 'cursor') return NodeBuffer.from(`cursor:${(value.pull as Pull).number}`).toString('base64');
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'PullRequestChangedFileConnection') {
    if (key === 'nodes') return (value.files as Array<FieldSource>).map((file) => ({ __type: 'PullRequestChangedFile', ...file }));
    if (key === 'edges') return (value.files as Array<FieldSource>).map((file) => ({ __type: 'PullRequestChangedFileEdge', file }));
    if (key === 'pageInfo') return pageInfoValue(value.page as ReturnType<typeof connectionPage>);
    if (key === 'totalCount') return value.totalCount;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'PullRequestChangedFileEdge') {
    if (key === 'node') return value.file ? { __type: 'PullRequestChangedFile', ...value.file } : null;
    if (key === 'cursor') return globalId('FileCursor', value.file.path as string);
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'PullRequestChangedFile') {
    if (key === 'path') return value.path;
    if (key === 'additions') return value.additions;
    if (key === 'deletions') return value.deletions;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (key === 'issue') {
      const issue = value.issue as Issue;
      return issue ? { __type: 'Issue', issue, __repo: repoOfItem(issue, 'issues') } : null;
    }
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (key === 'pullRequest') {
      const pull = value.pullRequest as Pull | undefined ?? value.pull as Pull;
      return pull ? { __type: 'PullRequest', pull, __repo: repoOfItem(pull, 'pulls') } : null;
    }
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'AddCommentPayload') {
    if (key === 'commentEdge') {
      const comment = value.comment;
      return comment ? { __type: 'IssueCommentEdge', comment } : null;
    }
    if (key === 'subject') return null;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'PageInfo') {
    if (key === 'hasNextPage') return value.hasNextPage;
    if (key === 'hasPreviousPage') return value.hasPreviousPage;
    if (key === 'startCursor') return value.startCursor;
    if (key === 'endCursor') return value.endCursor;
    throw unknownField(state, typeName, key, field);
  }
  if (typeName === 'RefConnection') {
    if (key === 'nodes') return (value.names as string[]).map((name) => ({ __type: 'Ref', name, oid: repo.refs.get(name) }));
    if (key === 'pageInfo') return pageInfoValue(value.page as ReturnType<typeof connectionPage>);
    if (key === 'totalCount') return value.totalCount;
    throw unknownField(state, typeName, key, field);
  }
  throw unknownField(state, typeName, key, field);
}

function unknownField(state: ExecState, typeName: string, key: string, field: FieldNode): never {
  throw new GqlFieldError(`Field "${key}" doesn't exist on type "${typeName}"`, field);
}

class GqlFieldError extends Error {
  field: FieldNode;
  constructor(message: string, field: FieldNode) {
    super(message);
    this.field = field;
  }
}

function messageOf(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (!obj) return '';
  const text = obj.bytes.toString('utf8');
  const blank = text.indexOf('\n\n');
  return blank < 0 ? '' : text.slice(blank + 2);
}

interface FileSummary {
  path: string;
  additions: number;
  deletions: number;
}

function flattenFiles(repo: Repo, treeOid: string | undefined, prefix: string, into: Map<string, string>): void {
  if (!treeOid) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.kind !== 'tree') return;
  for (const item of listDir(repo, treeOid, '')) {
    const path = prefix === '' ? item.name : `${prefix}/${item.name}`;
    if (item.mode === '40000') flattenFiles(repo, item.oid, path, into);
    else into.set(path, item.oid);
  }
}

function pullFileSummaries(repo: Repo, pull: Pull): FileSummary[] {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  if (headSha) flattenFiles(repo, parseTreeOid(repo, headSha), '', headFiles);
  if (baseSha) flattenFiles(repo, parseTreeOid(repo, baseSha), '', baseFiles);
  const out: FileSummary[] = [];
  for (const [path, headOid] of headFiles) {
    const baseOid = baseFiles.get(path);
    if (!baseOid) {
      const lines = (repo.objects.get(headOid)?.bytes.toString('utf8') ?? '').split('\n').filter((line) => line !== '').length;
      out.push({ path, additions: Math.max(1, lines), deletions: 0 });
      continue;
    }
    if (baseOid === headOid) continue;
    const oldLines = new Set((repo.objects.get(baseOid)?.bytes.toString('utf8') ?? '').split('\n'));
    const newLines = new Set((repo.objects.get(headOid)?.bytes.toString('utf8') ?? '').split('\n'));
    let additions = 0;
    for (const line of newLines) if (!oldLines.has(line)) additions += 1;
    let deletions = 0;
    for (const line of oldLines) if (!newLines.has(line)) deletions += 1;
    out.push({ path, additions: Math.max(1, additions), deletions: Math.max(1, deletions) });
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) out.push({ path, additions: 0, deletions: 1 });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function parseTreeOid(repo: Repo, commitSha: string): string | undefined {
  const obj = repo.objects.get(commitSha);
  if (!obj) return undefined;
  const text = obj.bytes.toString('utf8');
  const match = /^tree ([0-9a-f]{40})/m.exec(text);
  return match ? match[1] : undefined;
}

function repositoryValue(repo: Repo): FieldSource {
  return { __type: 'Repository', __id: globalId('Repository', repo.id), __repo: repo };
}

/** Execute one field's selection set against a runtime value. */
function executeSelection(
  state: ExecState,
  typeName: string,
  value: FieldSource | null,
  selections: Selection[],
  path: Array<string | number>,
): Record<string, unknown> | null {
  if (value === null) return null;
  const flat: Selection[] = [];
  mergeSelections(state, selections, flat);
  const out: Record<string, unknown> = {};
  for (const selection of flat) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== typeName && !inheritsType(typeName, selection.typeCondition)) continue;
      const nested = executeSelection(state, typeName, value, selection.selections, path);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const field = selection;
    const label = fieldLabel(field);
    try {
      const resolved = resolveField(state, typeName, value, field);
      out[label] = executeChild(state, typeName, field, resolved, [...path, label]);
    } catch (error) {
      if (error instanceof GqlFieldError) {
        addError(state, error.message, error.field);
      } else {
        addError(state, (error as Error).message, field);
      }
      out[label] = null;
    }
  }
  return out;
}

function inheritsType(typeName: string, condition: string): boolean {
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label'].includes(typeName);
  if (condition === 'Actor') return typeName === 'User';
  return false;
}

function executeChild(
  state: ExecState,
  parentType: string,
  field: FieldNode,
  resolved: unknown,
  path: Array<string | number>,
): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    return resolved.map((item, index) => executeChild(state, parentType, field, item, [...path, index]));
  }
  if (typeof resolved !== 'object') return resolved;
  const source = resolved as FieldSource;
  const typeName = (source.__type as string) ?? (parentType === 'Query' || parentType === 'Mutation' ? typeNameOfField(field.name) : parentType);
  if (source.__introspection !== undefined) {
    return executeSelection(state, source.__introspection as string, source, field.selections, path);
  }
  if (field.selections.length === 0) {
    // A scalar was resolved but the query selects subfields; treat as an error.
    addError(state, `Field "${field.name}" of type "${typeName}" must have a selection of subfields`, field);
    return null;
  }
  return executeSelection(state, typeName, source, field.selections, path);
}

function typeNameOfField(fieldName: string): string {
  if (fieldName === 'createIssue') return 'CreateIssuePayload';
  if (fieldName === 'closeIssue') return 'CloseIssuePayload';
  if (fieldName === 'createPullRequest') return 'CreatePullRequestPayload';
  if (fieldName === 'mergePullRequest') return 'MergePullRequestPayload';
  if (fieldName === 'addComment') return 'AddCommentPayload';
  if (fieldName === '__schema' || fieldName === '__type') return '__Introspection';
  return 'Query';
}

// ---------------------------------------------------------------- introspection execution

function introspectionValue(state: ExecState, field: FieldNode): FieldSource | null {
  if (field.name === '__typename') return undefined as unknown as FieldSource;
  if (field.name === '__schema') return { __introspection: '__Schema' };
  const name = String(argumentValue(field, 'name', state.variables) ?? '');
  const schemaType = SCHEMA_BY_NAME.get(name);
  if (!schemaType) return null;
  return { __introspection: '__Type', schemaType, includeDeprecated: argumentValue(field, 'includeDeprecated', state.variables) };
}

function executeIntrospection(state: ExecState, typeName: string, value: FieldSource, selections: Selection[]): Record<string, unknown> | null {
  const flat: Selection[] = [];
  mergeSelections(state, selections, flat);
  const out: Record<string, unknown> = {};
  for (const selection of flat) {
    if (selection.kind !== 'field') continue;
    const label = fieldLabel(selection);
    out[label] = resolveIntrospected(state, introspectField(state, typeName, value, selection), selection.selections);
  }
  return out;
}

/** Recurse into whatever introspection values a field resolved to. */
function resolveIntrospected(state: ExecState, value: unknown, selections: Selection[]): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveIntrospected(state, item, selections));
  if (typeof value !== 'object' || value === null) return value;
  const source = value as FieldSource;
  if (source.__introspection !== undefined) return executeIntrospection(state, source.__introspection as string, source, selections);
  return value;
}

function introspectField(state: ExecState, typeName: string, value: FieldSource, field: FieldNode): unknown {
  if (typeName === '__Schema') {
    if (field.name === 'queryType') return { __introspection: '__Type', schemaType: SCHEMA_BY_NAME.get('Query') };
    if (field.name === 'mutationType') return { __introspection: '__Type', schemaType: SCHEMA_BY_NAME.get('Mutation') };
    if (field.name === 'types') return SCHEMA_TYPES.map((schemaType) => ({ __introspection: '__Type', schemaType }));
    if (field.name === 'description') return 'The ghforge schema';
    return null;
  }
  if (typeName === '__Type') {
    const schemaType = value.schemaType as SchemaType;
    if (field.name === 'name') return schemaType?.name ?? null;
    if (field.name === 'kind') return schemaType?.kind ?? null;
    if (field.name === 'description') return schemaType?.description ?? null;
    if (field.name === 'fields') {
      if (!schemaType?.fields) return null;
      const includeDeprecated = value.includeDeprecated === true;
      return schemaType.fields.map((schemaField) => ({ __introspection: '__Field', schemaField, includeDeprecated }));
    }
    if (field.name === 'enumValues') {
      if (!schemaType?.enumValues) return null;
      return schemaType.enumValues.map((name) => ({ __introspection: '__EnumValue', name }));
    }
    if (field.name === 'inputFields') return null;
    if (field.name === 'interfaces') return schemaType?.kind === 'INTERFACE' ? [] : null;
    if (field.name === 'possibleTypes') return null;
    if (field.name === 'ofType') return null;
    return null;
  }
  if (typeName === '__Field') {
    const schemaField = value.schemaField as SchemaField;
    if (field.name === 'name') return schemaField.name;
    if (field.name === 'description') return null;
    if (field.name === 'isDeprecated') return false;
    if (field.name === 'deprecationReason') return null;
    if (field.name === 'type') return { __introspection: '__Type', schemaType: typeOfText(schemaField.typeText) };
    if (field.name === 'args') return (schemaField.args ?? []).map((arg) => ({ __introspection: '__InputValue', arg }));
    return null;
  }
  if (typeName === '__InputValue') {
    const arg = value.arg as { name: string; typeText: string };
    if (field.name === 'name') return arg.name;
    if (field.name === 'type') return { __introspection: '__Type', schemaType: typeOfText(arg.typeText) };
    if (field.name === 'defaultValue') return null;
    return null;
  }
  if (typeName === '__EnumValue') {
    if (field.name === 'name') return value.name;
    if (field.name === 'isDeprecated') return false;
    if (field.name === 'deprecationReason') return null;
    return null;
  }
  return null;
}

function typeOfText(typeText: string): SchemaType | { name: string; kind: string } {
  const bare = typeText.replace(/[!\[\]]/g, '');
  return SCHEMA_BY_NAME.get(bare) ?? { name: bare, kind: 'SCALAR' };
}

// ---------------------------------------------------------------- mutations

function mutationValue(state: ExecState, field: FieldNode): FieldSource | null {
  const repo = state.repo;
  const input = (argumentValue(field, 'input', state.variables) ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repositoryId = String(input.repositoryId ?? '');
      const title = String(input.title ?? '');
      const target = repoById(repositoryId);
      if (!target) return null;
      const now = new Date();
      const number = nextIssueNumberRepo(target);
      const issue: Issue = {
        id: 1_000_000 + number * 10,
        number,
        title,
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        user: OWNER_LOGIN,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        isPull: false,
      };
      target.issues.set(number, issue);
      return { __type: 'CreateIssuePayload', issue };
    }
    case 'closeIssue': {
      const issueId = String(input.issueId ?? '');
      const decoded = decodeGlobalId(issueId);
      const found = decoded?.kind === 'Issue' ? issueById(decoded.key) : null;
      if (!found) return null;
      const issue = found.issue;
      issue.state = 'closed';
      issue.closedAt = new Date();
      issue.updatedAt = new Date();
      return { __type: 'CloseIssuePayload', issue };
    }
    case 'createPullRequest': {
      const repositoryId = String(input.repositoryId ?? '');
      const target = repoById(repositoryId);
      if (!target) return null;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? target.defaultBranch);
      const headSha = target.refs.get(`refs/heads/${head}`);
      const baseSha = target.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return null;
      const number = nextIssueNumberRepo(target);
      const pull: Pull = {
        id: 2_000_000 + number * 10,
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        head,
        base,
        baseShaAtCreation: baseSha,
        user: OWNER_LOGIN,
        createdAt: new Date(),
        updatedAt: new Date(),
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        closedAt: null,
        isPull: true,
      };
      target.pulls.set(number, pull);
      return { __type: 'CreatePullRequestPayload', pullRequest: pull };
    }
    case 'mergePullRequest': {
      const pullId = String(input.pullRequestId ?? '');
      const decoded = decodeGlobalId(pullId);
      const found = decoded?.kind === 'PullRequest' ? pullById(decoded.key) : null;
      if (!found || found.pull.merged || found.pull.state !== 'open') return null;
      const outcome = mergePull(found.repo, found.pull, { merge_method: 'squash' });
      if (outcome.status >= 400) return null;
      return { __type: 'MergePullRequestPayload', pullRequest: found.pull };
    }
    case 'addComment': {
      const subjectId = String(input.subjectId ?? '');
      const body = String(input.body ?? '');
      const decoded = decodeGlobalId(subjectId);
      const found = decoded?.kind === 'Issue' ? issueById(decoded.key) : null;
      if (!found || body === '') return null;
      const comment = makeCommentLocal(found.repo, found.issue.number, body);
      return { __type: 'AddCommentPayload', comment };
    }
    default:
      return null;
  }
}

// small local indirections to keep this module's imports tidy
function hashingOid(kind: 'commit', bytes: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`${kind} ${bytes.length}\u0000`), bytes])).digest('hex');
}

function nextIssueNumberRepo(repo: Repo): number {
  return repo.nextNumber++;
}

function makeCommentLocal(repo: Repo, issueNumber: number, body: string): { id: number; body: string; user: string; createdAt: Date; updatedAt: Date } {
  const comment = {
    id: repo.nextCommentId++,
    issueNumber,
    body,
    user: OWNER_LOGIN,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  repo.comments.set(comment.id, comment);
  const issue = repo.issues.get(issueNumber);
  if (issue) issue.updatedAt = comment.updatedAt;
  return comment;
}

// ---------------------------------------------------------------- top level

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors: GqlErrorEntry[];
}

/** The repository whose global id decodes to `repositoryId`, or null. */
function repoById(repositoryId: string): Repo | null {
  const decoded = decodeGlobalId(repositoryId);
  if (decoded?.kind !== 'Repository') return null;
  return allRepos().find((candidate) => String(candidate.id) === decoded.key) ?? null;
}

/** The repository that holds this issue (or pull), by number. */
function repoOfItem(item: { number: number }, kind: 'issues' | 'pulls'): Repo {
  for (const candidate of allRepos()) {
    if (candidate[kind].has(item.number) && candidate[kind].get(item.number) === item) return candidate;
  }
  return allRepos()[0] as Repo;
}

/** The issue whose global id decodes to `key` (`issue:<id>`), with its owning repo. */
function issueById(key: string): { issue: Issue; repo: Repo } | null {
  const id = Number(key.split(':').pop());
  if (!Number.isFinite(id)) return null;
  for (const candidate of allRepos()) {
    for (const issue of candidate.issues.values()) {
      if (issue.id === id) return { issue, repo: candidate };
    }
  }
  return null;
}

/** The pull request whose global id decodes to `key`, with its owning repo. */
function pullById(key: string): { pull: Pull; repo: Repo } | null {
  const id = Number(key.split(':').pop());
  if (!Number.isFinite(id)) return null;
  for (const candidate of allRepos()) {
    for (const pull of candidate.pulls.values()) {
      if (pull.id === id) return { pull, repo: candidate };
    }
  }
  return null;
}

/** Run one operation document against the store. */
export function executeOperation(document: string, variables: Record<string, unknown>, repo: Repo, operationName?: string): GqlResult {
  const state: ExecState = { errors: [], fragments: new Map(), variables, repo };
  let definitions: Definition[];
  try {
    definitions = parseDocument(document);
  } catch (error) {
    return { data: null, errors: [{ message: `The document could not be parsed: ${(error as Error).message}` }] };
  }
  for (const definition of definitions) {
    if (definition.kind === 'fragment') state.fragments.set(definition.name, definition);
  }
  const operations = definitions.filter((definition): definition is OperationDefinition => definition.kind === 'operation');
  let operation = operations[0];
  if (operationName) {
    const named = operations.find((entry) => entry.name === operationName);
    if (!named) return { data: null, errors: [{ message: `No operation named "${operationName}" in the document` }] };
    operation = named;
  }
  if (!operation) return { data: null, errors: [{ message: 'The document holds no operations' }] };
  if (operation.kind !== 'operation') return { data: null, errors: [{ message: 'not an operation' }] };

  const flat: Selection[] = [];
  mergeSelections(state, operation.selections, flat);
  const data: Record<string, unknown> = {};
  for (const selection of flat) {
    if (selection.kind !== 'field') continue;
    const label = fieldLabel(selection);
    try {
      if (selection.name === '__schema' || selection.name === '__type') {
        const intro = introspectionValue(state, selection);
        data[label] = intro === null ? null : executeIntrospection(state, (intro as FieldSource).__introspection as string, intro as FieldSource, selection.selections);
        continue;
      }
      if (selection.name === '__typename') {
        data[label] = operation.operation === 'mutation' ? 'Mutation' : 'Query';
        continue;
      }
      if (operation.operation === 'mutation') {
        const payload = mutationValue(state, selection);
        data[label] = payload === null ? null : executeSelection(state, (payload as FieldSource).__type as string, payload, selection.selections, [label]);
        continue;
      }
      if (selection.name === 'viewer') {
        data[label] = executeSelection(state, 'User', { __type: 'User' }, selection.selections, [label]);
        continue;
      }
      if (selection.name === 'repository') {
        const owner = String(argumentValue(selection, 'owner', state.variables) ?? '');
        const name = String(argumentValue(selection, 'name', state.variables) ?? '');
        const found = findRepo(owner, name);
        data[label] = found && owner.toLowerCase() === repo.owner.toLowerCase() ? executeSelection(state, 'Repository', repositoryValue(found), selection.selections, [label]) : null;
        continue;
      }
      if (selection.name === 'node') {
        const id = String(argumentValue(selection, 'id', state.variables) ?? '');
        const decoded = decodeGlobalId(id);
        if (!decoded) {
          data[label] = null;
          continue;
        }
        if (decoded.kind === 'Repository') {
          const found = allRepos().find((candidate) => String(candidate.id) === decoded.key);
          data[label] = found ? executeSelection(state, 'Repository', repositoryValue(found), selection.selections, [label]) : null;
        } else if (decoded.kind === 'Issue') {
          const found = issueById(decoded.key);
          data[label] = found ? executeSelection(state, 'Issue', { __type: 'Issue', issue: found.issue, __repo: found.repo }, selection.selections, [label]) : null;
        } else if (decoded.kind === 'PullRequest') {
          const found = pullById(decoded.key);
          data[label] = found ? executeSelection(state, 'PullRequest', { __type: 'PullRequest', pull: found.pull, __repo: found.repo }, selection.selections, [label]) : null;
        } else {
          data[label] = null;
        }
        continue;
      }
      throw new GqlFieldError(`Field "${selection.name}" doesn't exist on type "${operation.operation === 'mutation' ? 'Mutation' : 'Query'}"`, selection);
    } catch (error) {
      if (error instanceof GqlFieldError) addError(state, error.message, error.field);
      else addError(state, (error as Error).message, 'line' in selection ? (selection as FieldNode) : undefined);
      data[label] = null;
    }
  }
  return { data, errors: state.errors };
}

/** Run a request body: one operation ({query,...}) or a batched array of them. */
export function runGraphQLBody(body: unknown, repo: Repo): { status: number; json: unknown } {
  const runOne = (entry: Record<string, unknown>): GqlResult => {
    const query = typeof entry.query === 'string' ? entry.query : '';
    if (query === '') return { data: null, errors: [{ message: 'A query document must be provided' }] };
    const variables = (entry.variables && typeof entry.variables === 'object' ? entry.variables : {}) as Record<string, unknown>;
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    return executeOperation(query, variables, repo, operationName);
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((entry) => serialize(runOne((entry ?? {}) as Record<string, unknown>))) };
  }
  if (!body || typeof body !== 'object') {
    return { status: 400, json: { message: 'Problems parsing JSON' } };
  }
  const result = runOne(body as Record<string, unknown>);
  return { status: 200, json: serialize(result) };
}

function serialize(result: GqlResult): Record<string, unknown> {
  const out: Record<string, unknown> = { data: result.data };
  if (result.errors.length > 0) out.errors = result.errors;
  return out;
}
