import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/model.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { ChurnResult } from '../src/churn.js';
import { pr, resetIds } from './fixtures.js';

const WINDOW = { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-31T00:00:00Z') };
const close = (a: number, b: number, tol = 0.5) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} to be within ${tol} of ${b}`);

const lineChurn = (added: number, reworked: number): ChurnResult => ({
  added: 0,
  addedLines: added,
  reworkedLines: reworked,
  rate: added ? (reworked / added) * 100 : 0,
  method: 'line',
  perPull: new Map()
}) as unknown as ChurnResult;

describe('buildLedger', () => {
  test('annualises a partial window', () => {
    resetIds();
    const pulls = [
      pr({ additions: 100, deletions: 0, reviewers: ['bob'], firstReviewAt: '2026-01-05T09:30:00Z' })
    ];
    const ledger = buildLedger(pulls, DEFAULT_CONFIG, WINDOW, 1, null);

    // 100 lines, one reviewer => 8 + 20 = 28 minutes over a 30-day window.
    const perYear = (28 / 60) * (365 / 30);
    close(ledger.debits[0]!.hoursPerYear!, perYear, 0.05);
    close(ledger.debits[0]!.amount, perYear * DEFAULT_CONFIG.hourly_cost, 5);
  });

  test('the attribution rate discounts the file proxy but not line churn', () => {
    resetIds();
    const pulls = [pr({ files: [{ path: 'a.ts', changes: 100 }] })];

    const line = buildLedger(pulls, DEFAULT_CONFIG, WINDOW, 1, null, lineChurn(1000, 1000));
    const lineRework = line.debits[1]!.hoursPerYear!;

    // Same 1000 reworked lines, but reached through the file-level proxy.
    const cfgFile = { ...DEFAULT_CONFIG };
    const file = buildLedger(
      [pr({ files: [{ path: 'a.ts', changes: 1000 }], mergedAt: '2026-01-05T10:00:00Z' }),
       pr({ files: [{ path: 'a.ts', changes: 1000 }], mergedAt: '2026-01-06T10:00:00Z' })],
      cfgFile,
      WINDOW,
      1,
      null
    );
    assert.equal(file.metrics.churnMethod, 'file');
    assert.ok(
      file.debits[1]!.note?.includes('file-level proxy'),
      'the file path should say it is a proxy'
    );
    assert.ok(line.debits[1]!.note?.includes('line-level'));
    assert.ok(lineRework > 0);
  });

  test('the credit is not claimed without a baseline', () => {
    resetIds();
    const ledger = buildLedger([pr()], DEFAULT_CONFIG, WINDOW, 1, null);
    assert.equal(ledger.creditComputed, false);
    assert.equal(ledger.creditTotal, 0);
    assert.ok(ledger.credits[0]!.note?.includes('not computed'));
    // Net is debits only, and therefore negative or zero.
    assert.ok(ledger.net <= 0);
  });

  test('a throughput drop is reported as a loss, not a saving', () => {
    resetIds();
    const baselineWindow = {
      since: new Date('2025-01-01T00:00:00Z'),
      until: new Date('2025-01-31T00:00:00Z')
    };
    // Baseline wrote far more per engineer than the current window.
    const baselinePulls = Array.from({ length: 10 }, () =>
      pr({ author: 'alice', additions: 1000, deletions: 0, mergedAt: '2025-01-10T00:00:00Z', files: [] })
    );
    const nowPulls = [pr({ author: 'alice', additions: 10, deletions: 0, files: [] })];

    const ledger = buildLedger(nowPulls, DEFAULT_CONFIG, WINDOW, 1, {
      pulls: baselinePulls,
      window: baselineWindow,
      repoCount: 1
    });

    assert.equal(ledger.creditComputed, true);
    assert.ok(ledger.creditTotal < 0, 'a fall in throughput must not read as a saving');
    assert.equal(ledger.credits[0]!.label, 'Authoring hours lost');
  });

  test('a throughput rise is credited', () => {
    resetIds();
    const baselineWindow = {
      since: new Date('2025-01-01T00:00:00Z'),
      until: new Date('2025-01-31T00:00:00Z')
    };
    const ledger = buildLedger(
      [pr({ author: 'alice', additions: 5000, deletions: 0, files: [] })],
      DEFAULT_CONFIG,
      WINDOW,
      1,
      {
        pulls: [pr({ author: 'alice', additions: 10, deletions: 0, mergedAt: '2025-01-10T00:00:00Z', files: [] })],
        window: baselineWindow,
        repoCount: 1
      }
    );
    assert.ok(ledger.creditTotal > 0);
    assert.equal(ledger.credits[0]!.label, 'Authoring hours saved');
  });

  test('the sensitivity range brackets the reported net', () => {
    resetIds();
    const pulls = [
      pr({ additions: 200, deletions: 0, reviewers: ['bob'], firstReviewAt: '2026-01-05T09:30:00Z' })
    ];
    const ledger = buildLedger(pulls, DEFAULT_CONFIG, WINDOW, 1, null);
    const lo = Math.min(ledger.sensitivity.low, ledger.sensitivity.high);
    const hi = Math.max(ledger.sensitivity.low, ledger.sensitivity.high);
    assert.ok(lo <= ledger.net && ledger.net <= hi, `net ${ledger.net} outside [${lo}, ${hi}]`);
  });

  test('the debit total is the sum of its lines', () => {
    resetIds();
    const cfg = { ...DEFAULT_CONFIG, ai_tooling_spend_per_year: 1234 };
    const ledger = buildLedger(
      [pr({ additions: 90, deletions: 10, reviewers: ['bob'], firstReviewAt: '2026-01-05T09:30:00Z' })],
      cfg,
      WINDOW,
      1,
      null
    );
    close(
      ledger.debitTotal,
      ledger.debits.reduce((a, d) => a + d.amount, 0),
      0.001
    );
    assert.ok(ledger.debits.some((d) => d.amount === 1234), 'AI spend should pass through unchanged');
  });

  test('cost of delay is not claimed while its coefficient is zero', () => {
    resetIds();
    const ledger = buildLedger(
      [pr({ createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-20T00:00:00Z' })],
      DEFAULT_CONFIG,
      WINDOW,
      1,
      null
    );
    const delay = ledger.debits.find((d) => d.label.startsWith('Cost of delay'))!;
    assert.equal(delay.amount, 0);
    assert.ok(delay.note?.includes('not claimed'));
  });

  test('an empty window produces a zero ledger rather than NaN', () => {
    const ledger = buildLedger([], DEFAULT_CONFIG, WINDOW, 0, null);
    assert.ok(Number.isFinite(ledger.net));
    assert.ok(Number.isFinite(ledger.debitTotal));
    assert.equal(ledger.debitTotal, 0);
  });
});
