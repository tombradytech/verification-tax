import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parsePatch, type DiffFile } from './churn.js';

const execFileAsync = promisify(execFile);
const ENDPOINT = 'https://api.github.com/graphql';
export const CACHE_DIR = '.verification-tax-cache';

export interface PullRequest {
  repo: string;
  number: number;
  author: string | null;
  createdAt: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  /** Earliest human review or review comment, ISO string, or null if none. */
  firstReviewAt: string | null;
  /** Distinct human reviewers, excluding the PR author and bots. */
  reviewers: string[];
  /** Paths touched, with line counts. Capped at 100 files per PR. */
  files: { path: string; changes: number }[];
  filesTruncated: boolean;
}

/** Resolves a token without ever asking the user to paste one. */
export async function resolveToken(): Promise<string> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    /* gh not installed or not logged in */
  }
  throw new Error(
    'No GitHub token found. Set GITHUB_TOKEN, or install the gh CLI and run `gh auth login`.\n' +
      'The token stays on this machine; nothing is sent anywhere else.'
  );
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string;
}

interface RepoConnection {
  repositories: {
    pageInfo: PageInfo;
    nodes: { name: string; isArchived: boolean; pushedAt: string | null }[];
  };
}

/** `--org` may name either an organisation or a personal account. */
interface ReposResponse {
  organization: RepoConnection | null;
  user: RepoConnection | null;
}

interface PullsResponse {
  repository: {
    pullRequests: { pageInfo: PageInfo; nodes: RawPull[] };
  } | null;
}

interface GqlResult<T> {
  data?: T;
  errors?: { message: string; type?: string }[];
}

export class Github {
  private calls = 0;
  private pointsUsed = 0;

  constructor(
    private token: string,
    private log: (msg: string) => void
  ) {}

  get stats() {
    return { calls: this.calls, pointsUsed: this.pointsUsed };
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `bearer ${this.token}`,
          'content-type': 'application/json',
          'user-agent': 'verification-tax'
        },
        body: JSON.stringify({ query, variables })
      });

      this.calls++;

      if (res.status === 401) throw new Error('GitHub rejected the token (401). Is it still valid?');
      if (res.status === 403 || res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 0) || 2 ** attempt * 5;
        this.log(`  rate limited, waiting ${wait}s...`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 500) {
        await sleep(2 ** attempt * 1000);
        continue;
      }

      const body = (await res.json()) as GqlResult<T & { rateLimit?: { cost: number } }>;
      if (body.errors?.length) {
        // A query that probes several roots at once (organization AND user)
        // always reports NOT_FOUND for the roots that do not apply. Those are
        // expected, and GitHub still returns the data for the root that did
        // resolve, so only throw when something else went wrong.
        const fatal = body.errors.filter((e) => e.type !== 'NOT_FOUND');
        if (fatal.length || !body.data) {
          throw new Error(
            `GitHub GraphQL error: ${(fatal.length ? fatal : body.errors).map((e) => e.message).join('; ')}`
          );
        }
      }
      if (!body.data) throw new Error('GitHub returned no data');
      this.pointsUsed += body.data.rateLimit?.cost ?? 0;
      return body.data;
    }
    throw new Error('GitHub kept rate limiting or failing after 5 attempts.');
  }

  /** REST GET with the same rate-limit backoff as the GraphQL path. */
  private async rest<T>(path: string): Promise<T | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: {
          authorization: `bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'verification-tax'
        }
      });
      this.calls++;
      if (res.status === 404) return null;
      if (res.status === 401) throw new Error('GitHub rejected the token (401).');
      if (res.status === 403 || res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 0) || 2 ** attempt * 5;
        this.log(`  rate limited, waiting ${wait}s...`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 500) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      return (await res.json()) as T;
    }
    throw new Error('GitHub kept failing after 5 attempts.');
  }

  /**
   * The diff of one PR, reduced to line ranges immediately.
   *
   * NOTE: this reads your source. It is only reached via --churn=line. Only the
   * derived line numbers are ever kept, and nothing is transmitted anywhere,
   * but the default path avoids diffs entirely so that "it does not read your
   * code" stays literally true.
   */
  async pullDiffRanges(org: string, repo: string, number: number): Promise<DiffFile[]> {
    const out: DiffFile[] = [];
    for (let page = 1; page <= 3; page++) {
      const files = await this.rest<RestFile[]>(
        `/repos/${org}/${repo}/pulls/${number}/files?per_page=100&page=${page}`
      );
      if (!files?.length) break;
      for (const f of files) {
        if (!f.patch) continue; // binary, or too large for GitHub to return
        const { added, removed } = parsePatch(f.patch);
        if (added.length || removed.length) out.push({ path: f.filename, added, removed });
      }
      if (files.length < 100) break;
    }
    return out;
  }

  /**
   * Every non-archived repo owned by `org` that saw a push since `since`.
   * Works for organisations and for personal accounts - the site says "org"
   * but plenty of people will point this at their own username.
   */
  async repos(org: string, since: string): Promise<string[]> {
    const query = `
      query($org: String!, $cursor: String) {
        rateLimit { cost }
        organization(login: $org) {
          repositories(first: 100, after: $cursor, orderBy: {field: PUSHED_AT, direction: DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes { name isArchived pushedAt }
          }
        }
        user(login: $org) {
          repositories(first: 100, after: $cursor, ownerAffiliations: OWNER,
                       orderBy: {field: PUSHED_AT, direction: DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes { name isArchived pushedAt }
          }
        }
      }`;

    const out: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data: ReposResponse = await this.gql<ReposResponse>(query, { org, cursor });

      const owner = data.organization ?? data.user;
      if (!owner) {
        throw new Error(
          `Cannot see "${org}" as either an organisation or a user. Check the spelling, ` +
            'and that your token has read access to it.'
        );
      }

      const { nodes, pageInfo } = owner.repositories;
      let exhausted = false;
      for (const r of nodes) {
        if (!r.pushedAt) continue;
        if (r.pushedAt < since) {
          // Ordered by pushedAt desc, so everything after this is older too.
          exhausted = true;
          break;
        }
        if (!r.isArchived) out.push(r.name);
      }
      if (exhausted || !pageInfo.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }
    return out;
  }

  /** Merged PRs in one repo whose mergedAt falls inside the window. */
  async mergedPulls(org: string, repo: string, since: string, until: string): Promise<PullRequest[]> {
    const query = `
      query($org: String!, $repo: String!, $cursor: String) {
        rateLimit { cost }
        repository(owner: $org, name: $repo) {
          pullRequests(first: 50, after: $cursor, states: MERGED,
                       orderBy: {field: UPDATED_AT, direction: DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              createdAt
              mergedAt
              updatedAt
              additions
              deletions
              author { login __typename }
              reviews(first: 50) {
                nodes { submittedAt author { login __typename } }
              }
              comments(first: 1) { nodes { createdAt } }
              files(first: 100) {
                pageInfo { hasNextPage }
                nodes { path additions deletions }
              }
            }
          }
        }
      }`;

    const out: PullRequest[] = [];
    let cursor: string | null = null;

    for (;;) {
      const data: PullsResponse = await this.gql<PullsResponse>(query, { org, repo, cursor });

      if (!data.repository) break;
      const { nodes, pageInfo } = data.repository.pullRequests;

      let olderThanWindow = false;
      for (const n of nodes) {
        // Sorted by updatedAt desc; a PR merged in-window always has
        // updatedAt >= mergedAt, so once updatedAt precedes the window we can stop.
        if (n.updatedAt < since) {
          olderThanWindow = true;
          break;
        }
        if (!n.mergedAt || n.mergedAt < since || n.mergedAt > until) continue;
        out.push(normalise(repo, n));
      }

      if (olderThanWindow || !pageInfo.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }
    return out;
  }
}

interface RawPull {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  updatedAt: string;
  additions: number;
  deletions: number;
  author: { login: string; __typename: string } | null;
  reviews: { nodes: { submittedAt: string | null; author: { login: string; __typename: string } | null }[] };
  comments: { nodes: { createdAt: string }[] };
  files: { pageInfo: { hasNextPage: boolean }; nodes: { path: string; additions: number; deletions: number }[] };
}

const isBot = (a: { login: string; __typename: string } | null) =>
  !a || a.__typename === 'Bot' || /\[bot\]$/.test(a.login) || /-bot$/.test(a.login);

function normalise(repo: string, n: RawPull): PullRequest {
  const author = isBot(n.author) ? null : (n.author?.login ?? null);

  const humanReviews = n.reviews.nodes.filter(
    (r) => r.submittedAt && !isBot(r.author) && r.author?.login !== author
  );
  const reviewers = [...new Set(humanReviews.map((r) => r.author!.login))];

  const reviewTimes = humanReviews.map((r) => r.submittedAt!).sort();
  const firstReviewAt = reviewTimes[0] ?? null;

  return {
    repo,
    number: n.number,
    author,
    createdAt: n.createdAt,
    mergedAt: n.mergedAt!,
    additions: n.additions,
    deletions: n.deletions,
    firstReviewAt,
    reviewers,
    files: n.files.nodes.map((f) => ({ path: f.path, changes: f.additions + f.deletions })),
    filesTruncated: n.files.pageInfo.hasNextPage
  };
}

interface RestFile {
  filename: string;
  patch?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** On-disk cache so the second run is instant, as advertised. */
export async function cached<T>(cwd: string, key: string, produce: () => Promise<T>): Promise<T> {
  const dir = resolve(cwd, CACHE_DIR);
  const file = join(dir, createHash('sha256').update(key).digest('hex').slice(0, 24) + '.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    const value = await produce();
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(value), 'utf8');
    return value;
  }
}
