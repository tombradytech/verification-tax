import type { TaxConfig } from './config.js';
import type { PullRequest } from './github.js';
import { computeMetrics, type Metrics } from './metrics.js';

export interface Line {
  label: string;
  hoursPerYear: number | null;
  amount: number;
  note?: string;
}

export interface Ledger {
  metrics: Metrics;
  debits: Line[];
  debitTotal: number;
  credits: Line[];
  creditTotal: number;
  net: number;
  /** Null when --baseline was not supplied; the credit is then not claimed. */
  creditComputed: boolean;
  sensitivity: { low: number; high: number };
  annualisation: number;
}

export interface Window {
  since: Date;
  until: Date;
}

/** Scales a window's figures to a year. */
const annualise = (windowDays: number) => 365 / Math.max(1, windowDays);

function debitsFor(m: Metrics, cfg: TaxConfig) {
  const k = annualise(m.windowDays);

  const reviewHours = (m.reviewMinutesTotal / 60) * k;
  const reworkedAttributed = m.reworkedLines * cfg.rework.attribution_rate;
  const reworkHours = (reworkedAttributed / cfg.rework.lines_per_hour) * k;
  const delayCost = m.excessDelayDays * cfg.delay.cost_per_pr_per_day * k;

  const lines: Line[] = [
    {
      label: 'Review hours consumed',
      hoursPerYear: reviewHours,
      amount: reviewHours * cfg.hourly_cost
    },
    {
      label: 'Rework on already-merged code',
      hoursPerYear: reworkHours,
      amount: reworkHours * cfg.hourly_cost,
      note: `${Math.round(cfg.rework.attribution_rate * 100)}% of flagged lines attributed`
    },
    {
      label: `Cost of delay, PRs over ${cfg.delay.threshold_days} days`,
      hoursPerYear: null,
      amount: delayCost,
      note: cfg.delay.cost_per_pr_per_day === 0 ? 'not claimed (set to 0 in config)' : undefined
    },
    { label: 'AI tooling spend', hoursPerYear: null, amount: cfg.ai_tooling_spend_per_year }
  ];

  return { lines, total: lines.reduce((a, l) => a + l.amount, 0) };
}

/**
 * The credit side. Only computed when a baseline window is supplied, because
 * without a before-and-after there is nothing to infer a saving from - and
 * inventing one is the single least defensible thing this tool could do.
 */
function creditsFor(m: Metrics, baseline: Metrics | null, cfg: TaxConfig) {
  if (!baseline) {
    return {
      lines: [
        {
          label: 'Authoring hours saved',
          hoursPerYear: null,
          amount: 0,
          note: 'not computed - rerun with --baseline to claim this'
        }
      ] as Line[],
      total: 0,
      computed: false
    };
  }

  // Lines merged per engineer per day, now versus then.
  const rateNow = m.engineers ? m.totalLines / m.engineers / m.windowDays : 0;
  const rateThen = baseline.engineers
    ? baseline.totalLines / baseline.engineers / baseline.windowDays
    : 0;

  const deltaLinesPerYear = (rateNow - rateThen) * m.engineers * 365;
  const hours = deltaLinesPerYear / cfg.authoring.lines_per_hour;

  const lines: Line[] = [
    {
      label: 'Authoring hours saved',
      hoursPerYear: hours,
      amount: hours * cfg.hourly_cost,
      note:
        `throughput ${rateThen.toFixed(1)} -> ${rateNow.toFixed(1)} lines/engineer/day` +
        (hours < 0 ? ' (throughput fell; this is a debit, not a saving)' : '')
    }
  ];
  return { lines, total: lines[0]!.amount, computed: true };
}

/** Scales the coefficients that matter, in the direction that hurts or helps. */
function scaled(cfg: TaxConfig, direction: 1 | -1): TaxConfig {
  const s = cfg.sensitivity;
  const up = 1 + direction * s;
  const down = 1 - direction * s;
  return {
    ...cfg,
    review: { ...cfg.review, minutes_per_line: cfg.review.minutes_per_line * up },
    rework: {
      ...cfg.rework,
      lines_per_hour: cfg.rework.lines_per_hour * down,
      attribution_rate: Math.min(1, cfg.rework.attribution_rate * up)
    },
    delay: { ...cfg.delay, cost_per_pr_per_day: cfg.delay.cost_per_pr_per_day * up },
    // More lines per hour means the same throughput delta buys fewer hours.
    authoring: { ...cfg.authoring, lines_per_hour: cfg.authoring.lines_per_hour * up }
  };
}

export function buildLedger(
  pulls: PullRequest[],
  cfg: TaxConfig,
  window: Window,
  repoCount: number,
  baseline: { pulls: PullRequest[]; window: Window; repoCount: number } | null
): Ledger {
  const metrics = computeMetrics(pulls, cfg, window, repoCount);
  const baseMetrics = baseline
    ? computeMetrics(baseline.pulls, cfg, baseline.window, baseline.repoCount)
    : null;

  const d = debitsFor(metrics, cfg);
  const c = creditsFor(metrics, baseMetrics, cfg);

  const netAt = (variant: TaxConfig, dir: 1 | -1): number => {
    const m = computeMetrics(pulls, variant, window, repoCount);
    const bm = baseline
      ? computeMetrics(baseline.pulls, variant, baseline.window, baseline.repoCount)
      : null;
    void dir;
    return creditsFor(m, bm, variant).total - debitsFor(m, variant).total;
  };

  return {
    metrics,
    debits: d.lines,
    debitTotal: d.total,
    credits: c.lines,
    creditTotal: c.total,
    net: c.total - d.total,
    creditComputed: c.computed,
    sensitivity: { low: netAt(scaled(cfg, 1), 1), high: netAt(scaled(cfg, -1), -1) },
    annualisation: annualise(metrics.windowDays)
  };
}
