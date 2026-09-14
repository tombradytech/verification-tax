import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, defaultGranularity, fullLabelFor, trendOf } from '../src/series.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { computeLineChurn, pullKey } from '../src/churn.js';
import { pr, resetIds } from './fixtures.js';

const win = (since: string, until: string) => ({ since: new Date(since), until: new Date(until) });

describe('defaultGranularity', () => {
  test('steps day, week, month as the window grows', () => {
    assert.equal(defaultGranularity(7), 'day');
    assert.equal(defaultGranularity(21), 'day');
    assert.equal(defaultGranularity(22), 'week');
    assert.equal(defaultGranularity(120), 'week');
    assert.equal(defaultGranularity(121), 'month');
  });
});

describe('fullLabelFor', () => {
  test('names the day, the week, or the month', () => {
    const d = new Date('2026-03-09T00:00:00Z'); // a Monday
    assert.equal(fullLabelFor(d, 'day'), 'Monday 9 March 2026');
    assert.equal(fullLabelFor(d, 'week'), 'Week of 9 March 2026');
    assert.equal(fullLabelFor(d, 'month'), 'March 2026');
  });
});

describe('buildSeries', () => {
  test('seeds empty periods so a quiet week is a zero, not a gap', () => {
    resetIds();
    const periods = buildSeries(
      [pr({ mergedAt: '2026-01-05T12:00:00Z' })],
      DEFAULT_CONFIG,
      win('2026-01-01T00:00:00Z', '2026-01-29T00:00:00Z'),
      1,
      'week'
    );
    assert.ok(periods.length >= 4, `expected at least 4 weekly buckets, got ${periods.length}`);
    assert.equal(
      periods.reduce((a, p) => a + p.prs, 0),
      1
    );
    assert.ok(periods.some((p) => p.prs === 0), 'expected at least one empty bucket');
  });

  test('buckets weeks from Monday', () => {
    resetIds();
    const periods = buildSeries(
      [
        pr({ mergedAt: '2026-03-08T12:00:00Z' }), // Sunday
        pr({ mergedAt: '2026-03-09T12:00:00Z' }) // Monday, next bucket
      ],
      DEFAULT_CONFIG,
      win('2026-03-02T00:00:00Z', '2026-03-16T00:00:00Z'),
      1,
      'week'
    );
    const withPrs = periods.filter((p) => p.prs > 0);
    assert.equal(withPrs.length, 2, 'Sunday and Monday should land in different weeks');
    assert.equal(withPrs[0]!.start, '2026-03-02');
    assert.equal(withPrs[1]!.start, '2026-03-09');
  });

  test('buckets months from the first', () => {
    resetIds();
    const periods = buildSeries(
      [pr({ mergedAt: '2026-01-31T23:00:00Z' }), pr({ mergedAt: '2026-02-01T01:00:00Z' })],
      DEFAULT_CONFIG,
      win('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'),
      1,
      'month'
    );
    assert.deepEqual(
      periods.map((p) => [p.start, p.prs]),
      [
        ['2026-01-01', 1],
        ['2026-02-01', 1]
      ]
    );
  });

  test('attributes churn to the period that wrote the line, not the one that deleted it', () => {
    resetIds();
    const written = pr({ number: 1, mergedAt: '2026-01-10T00:00:00Z' });
    const deleter = pr({ number: 2, mergedAt: '2026-02-10T00:00:00Z' });
    const churn = computeLineChurn(
      [
        { repo: 'app', number: 1, mergedAt: written.mergedAt, files: [{ path: 'a.ts', added: [[1, 10]], removed: [] }] },
        { repo: 'app', number: 2, mergedAt: deleter.mergedAt, files: [{ path: 'a.ts', added: [], removed: [[1, 10]] }] }
      ],
      60
    );
    assert.equal(churn.perPull.get(pullKey('app', 1))?.reworked, 10);

    const periods = buildSeries(
      [written, deleter],
      DEFAULT_CONFIG,
      win('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'),
      1,
      'month',
      churn
    );
    // January wrote ten lines and all ten were later removed: 100%.
    assert.equal(periods[0]!.metrics.reworkRate, 100);
    // February deleted them but wrote none of its own, so it is not charged.
    assert.equal(periods[1]!.metrics.reworkRate, 0);
  });

  test('every period carries both a short and a full label', () => {
    resetIds();
    const periods = buildSeries(
      [pr({ mergedAt: '2026-01-05T12:00:00Z' })],
      DEFAULT_CONFIG,
      win('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      1,
      'month'
    );
    assert.equal(periods[0]!.label, 'Jan 26');
    assert.equal(periods[0]!.full, 'January 2026');
  });
});

describe('trendOf', () => {
  const fake = (values: (number | null)[]) =>
    values.map((v) => ({
      start: '2026-01-01',
      label: 'x',
      full: 'x',
      prs: 0,
      metrics: { cycleTimeP50: v } as never
    }));

  const pick = (m: { cycleTimeP50: number | null }) => m.cycleTimeP50;

  test('compares the mean of the halves, not the endpoints', () => {
    // Endpoints say +900%. Halves say 10 -> 100, which is +900% too, but the
    // point is that one outlier in the middle cannot dominate.
    const t = trendOf(fake([10, 10, 100, 100]) as never, pick as never);
    assert.equal(t.first, 10);
    assert.equal(t.last, 100);
    assert.equal(t.change, 9);
  });

  test('one bad period does not flip a flat trend', () => {
    const t = trendOf(fake([10, 10, 10, 10, 10, 1000]) as never, pick as never);
    // Without half-averaging this would read as a 9900% jump.
    assert.ok(t.change !== null && t.change < 40, `change was ${t.change}`);
  });

  test('a falling series gives a negative change', () => {
    const t = trendOf(fake([100, 100, 50, 50]) as never, pick as never);
    assert.equal(t.change, -0.5);
  });

  test('nulls are dropped rather than treated as zero', () => {
    const t = trendOf(fake([null, 10, 10, null, 20, 20]) as never, pick as never);
    assert.equal(t.first, 10);
    assert.equal(t.last, 20);
  });

  test('fewer than two values yields no trend', () => {
    assert.equal(trendOf(fake([5]) as never, pick as never).change, null);
    assert.equal(trendOf([] as never, pick as never).change, null);
  });

  test('a zero baseline yields no change rather than Infinity', () => {
    const t = trendOf(fake([0, 0, 5, 5]) as never, pick as never);
    assert.equal(t.change, null);
  });
});
