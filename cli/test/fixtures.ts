import type { PullRequest } from '../src/github.js';

let counter = 0;

/**
 * A merged pull request with sane defaults. Override only what a test is
 * actually about, so the intent of each case stays readable.
 */
export function pr(over: Partial<PullRequest> = {}): PullRequest {
  counter++;
  const createdAt = over.createdAt ?? '2026-01-05T09:00:00Z';
  return {
    repo: 'app',
    number: counter,
    author: 'alice',
    createdAt,
    mergedAt: over.mergedAt ?? '2026-01-05T10:00:00Z',
    additions: 10,
    deletions: 0,
    firstReviewAt: null,
    reviewers: [],
    files: [],
    filesTruncated: false,
    ...over
  };
}

/** Resets numbering so ids are stable within a test file. */
export const resetIds = () => {
  counter = 0;
};

export const iso = (s: string) => new Date(s);
