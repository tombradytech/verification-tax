import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, quantile, reviewMinutesPerReviewer } from '../src/metrics.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { pr, resetIds } from './fixtures.js';

const WINDOW = { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-31T00:00:00Z') };
const metrics = (pulls: Parameters<typeof computeMetrics>[0]) =>
  computeMetrics(pulls, DEFAULT_CONFIG, WINDOW, 1);

describe('quantile', () => {
  test('picks the midpoint of an odd-length list', () => {
    assert.equal(quantile([1, 2, 3], 0.5), 2);
  });

  test('interpolates between neighbours on an even-length list', () => {
    assert.equal(quantile([10, 20], 0.5), 15);
  });

  test('p90 of 1..10 interpolates rather than rounding to a member', () => {
    assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  });

  test('p0 and p100 are the endpoints', () => {
    assert.equal(quantile([5, 9], 0), 5);
    assert.equal(quantile([5, 9], 1), 9);
  });

  test('an empty list is zero rather than NaN', () => {
    assert.equal(quantile([], 0.5), 0);
  });
});

describe('reviewMinutesPerReviewer', () => {
  const cfg = DEFAULT_CONFIG.review;

  test('is linear below the soft cap', () => {
    // 8 context-switch minutes + 100 lines * 0.2
    assert.equal(reviewMinutesPerReviewer(100, cfg), 28);
  });

  test('flattens above the soft cap instead of growing linearly', () => {
    const at500 = reviewMinutesPerReviewer(500, cfg);
    const linear = cfg.context_switch_minutes + 500 * cfg.minutes_per_line;
    assert.ok(at500 < linear, 'expected diminishing returns past the cap');
  });

  test('never exceeds the hard ceiling', () => {
    assert.equal(reviewMinutesPerReviewer(1_000_000, cfg), cfg.max_minutes_per_reviewer);
  });

  test('a zero-line PR still costs the context switch', () => {
    assert.equal(reviewMinutesPerReviewer(0, cfg), cfg.context_switch_minutes);
  });
});

describe('computeMetrics', () => {
  test('counts distinct authors, ignoring nulls', () => {
    resetIds();
    const m = metrics([pr({ author: 'a' }), pr({ author: 'a' }), pr({ author: 'b' }), pr({ author: null })]);
    assert.equal(m.engineers, 2);
    assert.equal(m.prsMerged, 4);
  });

  test('unreviewed rate counts PRs with no human reviewer', () => {
    resetIds();
    const m = metrics([
      pr({ reviewers: [], firstReviewAt: null }),
      pr({ reviewers: ['bob'], firstReviewAt: '2026-01-05T09:30:00Z' }),
      pr({ reviewers: [], firstReviewAt: null }),
      pr({ reviewers: [], firstReviewAt: null })
    ]);
    assert.equal(m.unreviewedCount, 3);
    assert.equal(m.pctMergedUnreviewed, 75);
    assert.equal(m.reviewedCount, 1);
  });

  test('cycle time covers every merged PR, reviewed or not', () => {
    resetIds();
    const m = metrics([
      pr({ createdAt: '2026-01-05T00:00:00Z', mergedAt: '2026-01-05T01:00:00Z' }),
      pr({ createdAt: '2026-01-05T00:00:00Z', mergedAt: '2026-01-05T03:00:00Z' })
    ]);
    assert.equal(m.cycleTimeP50, 120); // midpoint of 60 and 180 minutes
  });

  test('review timings only use PRs that got a review', () => {
    resetIds();
    const m = metrics([
      pr({
        createdAt: '2026-01-05T00:00:00Z',
        firstReviewAt: '2026-01-05T02:00:00Z',
        mergedAt: '2026-01-05T05:00:00Z',
        reviewers: ['bob']
      }),
      pr({ createdAt: '2026-01-05T00:00:00Z', mergedAt: '2026-01-05T00:10:00Z', reviewers: [] })
    ]);
    assert.equal(m.timeToFirstReviewP50, 120);
    assert.equal(m.timeInReviewP50, 180);
  });

  test('review timings are null when nothing was reviewed', () => {
    resetIds();
    const m = metrics([pr({ reviewers: [] })]);
    assert.equal(m.timeToFirstReviewP50, null);
    assert.equal(m.timeInReviewP90, null);
  });

  test('reviewers per reviewed PR excludes the unreviewed ones from the denominator', () => {
    resetIds();
    const m = metrics([
      pr({ reviewers: ['b', 'c'], firstReviewAt: '2026-01-05T09:30:00Z' }),
      pr({ reviewers: [], firstReviewAt: null })
    ]);
    // 2 reviewers over 1 reviewed PR, not over 2 PRs.
    assert.equal(m.reviewsPerReviewedPr, 2);
  });

  test('review minutes scale with the number of reviewers', () => {
    resetIds();
    const one = metrics([pr({ additions: 100, deletions: 0, reviewers: ['b'], firstReviewAt: '2026-01-05T09:30:00Z' })]);
    const two = metrics([pr({ additions: 100, deletions: 0, reviewers: ['b', 'c'], firstReviewAt: '2026-01-05T09:30:00Z' })]);
    assert.equal(two.reviewMinutesTotal, one.reviewMinutesTotal * 2);
  });

  test('PR size percentiles use additions plus deletions', () => {
    resetIds();
    const m = metrics([
      pr({ additions: 5, deletions: 5 }),
      pr({ additions: 100, deletions: 0 }),
      pr({ additions: 0, deletions: 40 })
    ]);
    assert.equal(m.prSizeP50, 40);
  });

  test('delay counts only days beyond the threshold', () => {
    resetIds();
    const m = metrics([
      pr({ createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-08T00:00:00Z' }), // 7 days
      pr({ createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z' }) // 1 day
    ]);
    assert.equal(m.delayedPrCount, 1);
    assert.equal(m.excessDelayDays, 2); // 7 - 5
  });

  test('a supplied churn result overrides the file-level proxy', () => {
    resetIds();
    const pulls = [pr({ files: [{ path: 'a.ts', changes: 100 }] })];
    const withLine = computeMetrics(pulls, DEFAULT_CONFIG, WINDOW, 1, {
      reworkedLines: 3,
      addedLines: 12,
      rate: 25,
      method: 'line',
      perPull: new Map()
    });
    assert.equal(withLine.churnMethod, 'line');
    assert.equal(withLine.reworkRate, 25);
    assert.equal(withLine.totalLines, 12);

    const withFile = computeMetrics(pulls, DEFAULT_CONFIG, WINDOW, 1);
    assert.equal(withFile.churnMethod, 'file');
  });

  test('an empty window does not divide by zero', () => {
    const m = metrics([]);
    assert.equal(m.prsMerged, 0);
    assert.equal(m.pctMergedUnreviewed, 0);
    assert.equal(m.reworkRate, 0);
    assert.equal(m.reviewsPerReviewedPr, 0);
  });
});
