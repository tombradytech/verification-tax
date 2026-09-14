import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { churnSubset, computeLineChurn, parsePatch, pullKey } from '../src/churn.js';
import type { PullDiff } from '../src/churn.js';

describe('parsePatch', () => {
  test('reads added and removed line numbers from one hunk', () => {
    const patch = ['@@ -10,3 +10,4 @@', ' context', '-gone', '+new one', '+new two', ' tail'].join(
      '\n'
    );
    const { added, removed } = parsePatch(patch);
    // New side: 10 context, 11 and 12 added.
    assert.deepEqual(added, [[11, 12]]);
    // Old side: 10 context, 11 removed.
    assert.deepEqual(removed, [[11, 11]]);
  });

  test('advances both sides independently across several hunks', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      ' keep',
      '@@ -50,2 +50,3 @@',
      ' ctx',
      '+added'
    ].join('\n');
    const { added, removed } = parsePatch(patch);
    assert.deepEqual(added, [
      [1, 1],
      [51, 51]
    ]);
    assert.deepEqual(removed, [[1, 1]]);
  });

  test('collapses consecutive lines into ranges but not gaps', () => {
    const patch = ['@@ -1,0 +1,5 @@', '+a', '+b', ' ctx', '+d', '+e'].join('\n');
    assert.deepEqual(parsePatch(patch).added, [
      [1, 2],
      [4, 5]
    ]);
  });

  test('ignores the no-newline marker without shifting line numbers', () => {
    const withMarker = ['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new'].join(
      '\n'
    );
    const { added, removed } = parsePatch(withMarker);
    assert.deepEqual(added, [[1, 1]]);
    assert.deepEqual(removed, [[1, 1]]);
  });

  test('ignores anything before the first hunk header', () => {
    const patch = ['diff --git a/x b/x', 'index abc..def 100644', '@@ -1,1 +1,2 @@', '+x'].join(
      '\n'
    );
    assert.deepEqual(parsePatch(patch).added, [[1, 1]]);
  });

  test('handles single-line hunk headers with no count', () => {
    const { added } = parsePatch('@@ -5 +5 @@\n+only');
    assert.deepEqual(added, [[5, 5]]);
  });

  test('an empty patch yields nothing rather than throwing', () => {
    assert.deepEqual(parsePatch(''), { added: [], removed: [] });
  });
});

const diff = (
  number: number,
  mergedAt: string,
  files: { path: string; added?: [number, number][]; removed?: [number, number][] }[]
): PullDiff => ({
  repo: 'app',
  number,
  mergedAt,
  files: files.map((f) => ({ path: f.path, added: f.added ?? [], removed: f.removed ?? [] }))
});

describe('computeLineChurn', () => {
  test('counts lines a later PR deleted', () => {
    const r = computeLineChurn(
      [
        diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[1, 10]] }]),
        diff(2, '2026-01-05T00:00:00Z', [{ path: 'a.ts', removed: [[1, 4]] }])
      ],
      21
    );
    assert.equal(r.addedLines, 10);
    assert.equal(r.reworkedLines, 4);
    assert.equal(r.rate, 40);
  });

  test('ignores a deletion outside the rework window', () => {
    const r = computeLineChurn(
      [
        diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[1, 10]] }]),
        diff(2, '2026-03-01T00:00:00Z', [{ path: 'a.ts', removed: [[1, 10]] }])
      ],
      21
    );
    assert.equal(r.reworkedLines, 0);
  });

  test('ignores deletions in a different file', () => {
    const r = computeLineChurn(
      [
        diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[1, 10]] }]),
        diff(2, '2026-01-02T00:00:00Z', [{ path: 'b.ts', removed: [[1, 10]] }])
      ],
      21
    );
    assert.equal(r.reworkedLines, 0);
  });

  test('a PR deleting its own lines is not rework', () => {
    const r = computeLineChurn(
      [diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[1, 5]], removed: [[1, 5]] }])],
      21
    );
    assert.equal(r.reworkedLines, 0);
  });

  test('counts only the overlapping part of a partial deletion', () => {
    const r = computeLineChurn(
      [
        diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[10, 20]] }]),
        diff(2, '2026-01-02T00:00:00Z', [{ path: 'a.ts', removed: [[15, 30]] }])
      ],
      21
    );
    // 15..20 overlaps; 21..30 was never ours.
    assert.equal(r.reworkedLines, 6);
  });

  test('a line deleted by two later PRs is counted once', () => {
    const r = computeLineChurn(
      [
        diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[1, 10]] }]),
        diff(2, '2026-01-02T00:00:00Z', [{ path: 'a.ts', removed: [[1, 5]] }]),
        diff(3, '2026-01-03T00:00:00Z', [{ path: 'a.ts', removed: [[3, 8]] }])
      ],
      21
    );
    // 1..8 touched, not 5 + 6 = 11.
    assert.equal(r.reworkedLines, 8);
  });

  test('an earlier deletion does not count against a later addition', () => {
    const r = computeLineChurn(
      [
        diff(1, '2026-01-05T00:00:00Z', [{ path: 'a.ts', removed: [[1, 10]] }]),
        diff(2, '2026-01-06T00:00:00Z', [{ path: 'a.ts', added: [[1, 10]] }])
      ],
      21
    );
    assert.equal(r.reworkedLines, 0);
  });

  test('attributes churn to the PR that wrote the line', () => {
    const r = computeLineChurn(
      [
        diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[1, 10]] }]),
        diff(2, '2026-01-05T00:00:00Z', [{ path: 'a.ts', removed: [[1, 4]] }])
      ],
      21
    );
    assert.equal(r.perPull.get(pullKey('app', 1))?.reworked, 4);
    assert.equal(r.perPull.get(pullKey('app', 2))?.reworked ?? 0, 0);
  });

  test('rate is zero rather than NaN when nothing was added', () => {
    const r = computeLineChurn([], 21);
    assert.equal(r.rate, 0);
    assert.equal(r.addedLines, 0);
  });
});

describe('churnSubset', () => {
  test('recomputes the rate over the chosen pull requests only', () => {
    const full = computeLineChurn(
      [
        diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[1, 10]] }]),
        diff(2, '2026-01-05T00:00:00Z', [{ path: 'a.ts', added: [[50, 59]], removed: [[1, 10]] }])
      ],
      21
    );
    assert.equal(full.addedLines, 20);
    assert.equal(full.reworkedLines, 10);

    const only1 = churnSubset(full, [pullKey('app', 1)]);
    assert.equal(only1.addedLines, 10);
    assert.equal(only1.reworkedLines, 10);
    assert.equal(only1.rate, 100);

    const only2 = churnSubset(full, [pullKey('app', 2)]);
    assert.equal(only2.rate, 0);
  });

  test('unknown keys are skipped, not counted as zero-line entries', () => {
    const full = computeLineChurn(
      [diff(1, '2026-01-01T00:00:00Z', [{ path: 'a.ts', added: [[1, 4]] }])],
      21
    );
    const sub = churnSubset(full, [pullKey('app', 1), pullKey('app', 999)]);
    assert.equal(sub.addedLines, 4);
  });
});
