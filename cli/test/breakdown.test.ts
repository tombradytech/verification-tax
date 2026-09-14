import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { anonymise, byEngineer, byRepo, bySize, concentrationOf } from '../src/breakdown.js';
import { DEFAULT_CONFIG as CFG } from '../src/config.js';
import { pr, resetIds } from './fixtures.js';

describe('bySize', () => {
  test('bands are exclusive at the lower bound and inclusive at the upper', () => {
    resetIds();
    const rows = bySize(
      [
        pr({ additions: 50, deletions: 0 }), // 50 -> "1 - 50"
        pr({ additions: 51, deletions: 0 }), // 51 -> "51 - 200"
        pr({ additions: 200, deletions: 0 }), // 200 -> "51 - 200"
        pr({ additions: 201, deletions: 0 }) // 201 -> "201 - 500"
      ],
      CFG
    );
    const byBand = Object.fromEntries(rows.map((r) => [r.band, r.prs]));
    assert.equal(byBand['1 – 50'], 1);
    assert.equal(byBand['51 – 200'], 2);
    assert.equal(byBand['201 – 500'], 1);
  });

  test('empty bands are dropped rather than shown as zero rows', () => {
    resetIds();
    const rows = bySize([pr({ additions: 10, deletions: 0 })], CFG);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.share, 100);
  });

  test('a zero-line PR falls outside every band rather than into the first', () => {
    resetIds();
    const rows = bySize([pr({ additions: 0, deletions: 0 })], CFG);
    assert.equal(rows.length, 0, 'a PR changing nothing should not be banded');
  });

  test('shares sum to one hundred', () => {
    resetIds();
    const rows = bySize(
      [
        pr({ additions: 10, deletions: 0 }),
        pr({ additions: 300, deletions: 0 }),
        pr({ additions: 5000, deletions: 0 })
      ],
      CFG
    );
    assert.equal(Math.round(rows.reduce((a, r) => a + r.share, 0)), 100);
  });
});

describe('byRepo', () => {
  test('groups and counts distinct authors per repository', () => {
    resetIds();
    const rows = byRepo(
      [
        pr({ repo: 'app', author: 'a' }),
        pr({ repo: 'app', author: 'b' }),
        pr({ repo: 'api', author: 'a' })
      ],
      CFG
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.repo, 'app');
    assert.equal(rows[0]!.prs, 2);
    assert.equal(rows[0]!.engineers, 2);
    assert.equal(rows[1]!.engineers, 1);
  });

  test('sorts busiest first', () => {
    resetIds();
    const rows = byRepo(
      [pr({ repo: 'quiet' }), pr({ repo: 'busy' }), pr({ repo: 'busy' })],
      CFG
    );
    assert.equal(rows[0]!.repo, 'busy');
  });
});

describe('byEngineer', () => {
  test('separates authoring from reviewing', () => {
    resetIds();
    const rows = byEngineer(
      [
        pr({ author: 'alice', reviewers: ['bob'], firstReviewAt: '2026-01-05T09:30:00Z' }),
        pr({ author: 'alice', reviewers: ['bob'], firstReviewAt: '2026-01-05T09:30:00Z' })
      ],
      CFG
    );
    const alice = rows.find((r) => r.login === 'alice')!;
    const bob = rows.find((r) => r.login === 'bob')!;
    assert.equal(alice.authored, 2);
    assert.equal(alice.reviewsGiven, 0);
    assert.equal(alice.reviewsReceived, 2);
    assert.equal(bob.authored, 0);
    assert.equal(bob.reviewsGiven, 2);
  });

  test('reciprocity is given over received', () => {
    resetIds();
    const rows = byEngineer(
      [
        // alice authors 2, each reviewed by bob -> alice receives 2
        pr({ author: 'alice', reviewers: ['bob'], firstReviewAt: '2026-01-05T09:30:00Z' }),
        pr({ author: 'alice', reviewers: ['bob'], firstReviewAt: '2026-01-05T09:30:00Z' }),
        // alice reviews one of bob's -> alice gives 1
        pr({ author: 'bob', reviewers: ['alice'], firstReviewAt: '2026-01-05T09:30:00Z' })
      ],
      CFG
    );
    assert.equal(rows.find((r) => r.login === 'alice')!.reciprocity, 0.5);
    assert.equal(rows.find((r) => r.login === 'bob')!.reciprocity, 2);
  });

  test('reciprocity is null, not Infinity, for someone who received nothing', () => {
    resetIds();
    const rows = byEngineer([pr({ author: 'alice', reviewers: [] })], CFG);
    assert.equal(rows.find((r) => r.login === 'alice')!.reciprocity, null);
  });

  test("wait times use only the author's own reviewed PRs", () => {
    resetIds();
    const rows = byEngineer(
      [
        pr({
          author: 'alice',
          createdAt: '2026-01-05T00:00:00Z',
          firstReviewAt: '2026-01-05T04:00:00Z',
          reviewers: ['bob']
        }),
        pr({ author: 'alice', reviewers: [] })
      ],
      CFG
    );
    const alice = rows.find((r) => r.login === 'alice')!;
    assert.equal(alice.waitP50, 240);
    assert.equal(alice.unreviewedPct, 50);
  });

  test('a null author is not counted as a person', () => {
    resetIds();
    const rows = byEngineer([pr({ author: null, reviewers: [] })], CFG);
    assert.equal(rows.length, 0);
  });

  test('sorted by review hours carried, heaviest first', () => {
    resetIds();
    const rows = byEngineer(
      [
        pr({ author: 'x', reviewers: ['heavy'], additions: 400, firstReviewAt: '2026-01-05T09:30:00Z' }),
        pr({ author: 'x', reviewers: ['light'], additions: 5, firstReviewAt: '2026-01-05T09:30:00Z' })
      ],
      CFG
    );
    assert.equal(rows[0]!.login, 'heavy');
  });
});

describe('concentrationOf', () => {
  const rows = (hours: number[]) =>
    hours.map((h, i) => ({
      login: `e${i}`,
      authored: 0,
      waitP50: null,
      waitP90: null,
      unreviewedPct: 0,
      reviewsGiven: 0,
      reviewHoursGiven: h,
      reviewsReceived: 0,
      reciprocity: null
    }));

  test('perfectly even load gives a Gini near zero', () => {
    const c = concentrationOf(rows([10, 10, 10, 10]));
    assert.ok(Math.abs(c.gini) < 0.01, `gini was ${c.gini}`);
    assert.equal(c.reviewers, 4);
  });

  test('one person doing everything gives a high Gini', () => {
    const c = concentrationOf(rows([100, 0.0001, 0.0001, 0.0001]));
    assert.ok(c.gini > 0.7, `gini was ${c.gini}`);
    assert.equal(c.halfLoadCarriedBy, 1);
    assert.ok(c.topShare > 99);
  });

  test('counts how many people carry half the load', () => {
    const c = concentrationOf(rows([30, 30, 20, 20]));
    assert.equal(c.halfLoadCarriedBy, 2);
  });

  test('people with no review hours are not counted as reviewers', () => {
    const c = concentrationOf(rows([10, 0, 0]));
    assert.equal(c.reviewers, 1);
  });

  test('no reviewers at all does not divide by zero', () => {
    const c = concentrationOf(rows([]));
    assert.deepEqual(c, { reviewers: 0, halfLoadCarriedBy: 0, topShare: 0, gini: 0 });
  });
});

describe('anonymise', () => {
  test('replaces logins with stable pseudonyms', () => {
    const input = [
      { login: 'zoe' },
      { login: 'adam' }
    ] as Parameters<typeof anonymise>[0];
    const out = anonymise(input);
    // Numbered by sorted login, so adam is 1 regardless of row order.
    assert.equal(out.find((r) => r.login === 'Engineer 1') !== undefined, true);
    assert.equal(out.length, 2);
    assert.ok(!out.some((r) => r.login === 'zoe' || r.login === 'adam'));
  });

  test('the same login maps to the same pseudonym across calls', () => {
    const input = [{ login: 'b' }, { login: 'a' }] as Parameters<typeof anonymise>[0];
    assert.deepEqual(
      anonymise(input).map((r) => r.login),
      anonymise(input).map((r) => r.login)
    );
  });
});
