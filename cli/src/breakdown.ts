import type { TaxConfig } from './config.js';
import type { PullRequest } from './github.js';
import type { ChurnResult } from './churn.js';
import { pullKey } from './churn.js';
import { quantile, reviewMinutesPerReviewer } from './metrics.js';

/**
 * Slices of the same pull requests: by repository, by pull request size, and by
 * person.
 *
 * A note on the per-person table, because it is the part of this tool most
 * easily misused. It deliberately does not report lines written, commits, or
 * anything shaped like output per head - those measure typing, not value, and
 * ranking engineers by them is how you teach a team to write longer diffs. What
 * it reports is load and blockage: who is carrying the review burden, whose
 * work sits waiting, and whether giving and receiving are anywhere near
 * balanced. Those are questions about a process, and the answers belong to the
 * process rather than to the individuals in it.
 */

const p50 = (xs: number[]) => (xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : null);
const p90 = (xs: number[]) => (xs.length ? quantile([...xs].sort((a, b) => a - b), 0.9) : null);
const MS_PER_MIN = 60_000;

const lines = (p: PullRequest) => p.additions + p.deletions;

interface Common {
  prs: number;
  cycleP50: number | null;
  cycleP90: number | null;
  ttfrP50: number | null;
  unreviewedPct: number;
  churnPct: number | null;
  reviewHours: number;
}

function commonOf(pulls: PullRequest[], cfg: TaxConfig, churn?: ChurnResult): Common {
  const cycles: number[] = [];
  const ttfr: number[] = [];
  let unreviewed = 0;
  let reviewMinutes = 0;
  let added = 0;
  let reworked = 0;

  for (const p of pulls) {
    cycles.push((+new Date(p.mergedAt) - +new Date(p.createdAt)) / MS_PER_MIN);
    if (p.reviewers.length === 0) unreviewed++;
    else if (p.firstReviewAt) {
      ttfr.push((+new Date(p.firstReviewAt) - +new Date(p.createdAt)) / MS_PER_MIN);
    }
    reviewMinutes += reviewMinutesPerReviewer(lines(p), cfg.review) * p.reviewers.length;

    const c = churn?.perPull.get(pullKey(p.repo, p.number));
    if (c) {
      added += c.added;
      reworked += c.reworked;
    }
  }

  return {
    prs: pulls.length,
    cycleP50: p50(cycles),
    cycleP90: p90(cycles),
    ttfrP50: p50(ttfr),
    unreviewedPct: pulls.length ? (unreviewed / pulls.length) * 100 : 0,
    churnPct: added ? (reworked / added) * 100 : null,
    reviewHours: reviewMinutes / 60
  };
}

export interface RepoRow extends Common {
  repo: string;
  engineers: number;
  sizeP90: number | null;
}

export function byRepo(pulls: PullRequest[], cfg: TaxConfig, churn?: ChurnResult): RepoRow[] {
  const groups = new Map<string, PullRequest[]>();
  for (const p of pulls) {
    const g = groups.get(p.repo);
    if (g) g.push(p);
    else groups.set(p.repo, [p]);
  }

  return [...groups.entries()]
    .map(([repo, list]) => ({
      repo,
      engineers: new Set(list.map((p) => p.author).filter(Boolean)).size,
      sizeP90: p90(list.map(lines)),
      ...commonOf(list, cfg, churn)
    }))
    .sort((a, b) => b.prs - a.prs);
}

/** Size bands, chosen so the boundaries are ones people actually argue about. */
const SIZE_BANDS: [label: string, max: number][] = [
  ['1 – 50', 50],
  ['51 – 200', 200],
  ['201 – 500', 500],
  ['501 – 1,000', 1000],
  ['over 1,000', Infinity]
];

export interface SizeRow extends Common {
  band: string;
  share: number;
}

/**
 * The most actionable table in the report: it tests whether big pull requests
 * actually cost more, using this org's own history rather than an assertion.
 */
export function bySize(pulls: PullRequest[], cfg: TaxConfig, churn?: ChurnResult): SizeRow[] {
  return SIZE_BANDS.map(([band, max], i) => {
    const min = i === 0 ? 0 : SIZE_BANDS[i - 1]![1];
    const list = pulls.filter((p) => lines(p) > min && lines(p) <= max);
    return {
      band,
      share: pulls.length ? (list.length / pulls.length) * 100 : 0,
      ...commonOf(list, cfg, churn)
    };
  }).filter((r) => r.prs > 0);
}

export interface EngineerRow {
  login: string;
  authored: number;
  /** How long this person's own pull requests wait for a first review. */
  waitP50: number | null;
  waitP90: number | null;
  /** Their pull requests that merged with nobody reviewing. */
  unreviewedPct: number;
  reviewsGiven: number;
  reviewHoursGiven: number;
  reviewsReceived: number;
  /** Reviews given per review received. Below ~0.5 is a one-way street. */
  reciprocity: number | null;
}

export function byEngineer(pulls: PullRequest[], cfg: TaxConfig): EngineerRow[] {
  const rows = new Map<string, EngineerRow>();
  const waits = new Map<string, number[]>();

  const row = (login: string): EngineerRow => {
    let r = rows.get(login);
    if (!r) {
      r = {
        login,
        authored: 0,
        waitP50: null,
        waitP90: null,
        unreviewedPct: 0,
        reviewsGiven: 0,
        reviewHoursGiven: 0,
        reviewsReceived: 0,
        reciprocity: null
      };
      rows.set(login, r);
    }
    return r;
  };

  const unreviewedBy = new Map<string, number>();

  for (const p of pulls) {
    if (p.author) {
      const a = row(p.author);
      a.authored++;
      a.reviewsReceived += p.reviewers.length;
      if (p.reviewers.length === 0) {
        unreviewedBy.set(p.author, (unreviewedBy.get(p.author) ?? 0) + 1);
      } else if (p.firstReviewAt) {
        const w = (+new Date(p.firstReviewAt) - +new Date(p.createdAt)) / MS_PER_MIN;
        const list = waits.get(p.author);
        if (list) list.push(w);
        else waits.set(p.author, [w]);
      }
    }

    const minutes = reviewMinutesPerReviewer(lines(p), cfg.review);
    for (const reviewer of p.reviewers) {
      const r = row(reviewer);
      r.reviewsGiven++;
      r.reviewHoursGiven += minutes / 60;
    }
  }

  for (const r of rows.values()) {
    const w = waits.get(r.login) ?? [];
    r.waitP50 = p50(w);
    r.waitP90 = p90(w);
    r.unreviewedPct = r.authored ? ((unreviewedBy.get(r.login) ?? 0) / r.authored) * 100 : 0;
    r.reciprocity = r.reviewsReceived ? r.reviewsGiven / r.reviewsReceived : null;
  }

  return [...rows.values()].sort((a, b) => b.reviewHoursGiven - a.reviewHoursGiven);
}

export interface Concentration {
  reviewers: number;
  /** Reviewers who between them carry half of all review hours. */
  halfLoadCarriedBy: number;
  topShare: number;
  /** 0 = load spread perfectly evenly, 1 = one person doing everything. */
  gini: number;
}

/** How unevenly review work is distributed - the bus factor, quantified. */
export function concentrationOf(engineers: EngineerRow[]): Concentration {
  const loads = engineers
    .map((e) => e.reviewHoursGiven)
    .filter((h) => h > 0)
    .sort((a, b) => b - a);

  const total = loads.reduce((a, b) => a + b, 0);
  if (!total) return { reviewers: 0, halfLoadCarriedBy: 0, topShare: 0, gini: 0 };

  let running = 0;
  let half = 0;
  for (const l of loads) {
    running += l;
    half++;
    if (running >= total / 2) break;
  }

  // Gini over the ascending distribution.
  const asc = [...loads].reverse();
  const n = asc.length;
  let weighted = 0;
  asc.forEach((v, i) => {
    weighted += (i + 1) * v;
  });
  const gini = n > 1 ? (2 * weighted) / (n * total) - (n + 1) / n : 0;

  return { reviewers: n, halfLoadCarriedBy: half, topShare: (loads[0]! / total) * 100, gini };
}

/** Stable pseudonyms, so a report can be shared without naming anyone. */
export function anonymise(engineers: EngineerRow[]): EngineerRow[] {
  const sorted = [...engineers].sort((a, b) => a.login.localeCompare(b.login));
  const names = new Map(sorted.map((e, i) => [e.login, `Engineer ${i + 1}`]));
  return engineers.map((e) => ({ ...e, login: names.get(e.login) ?? e.login }));
}


/** The per-person charts, and what each one is for. */
export const ENGINEER_SERIES: {
  title: string;
  lineNames: string[];
  format: 'count' | 'percent' | 'minutes' | 'ratio' | 'hours';
  better: 'lower' | 'higher' | 'neutral';
  note: string;
  pick: (r: EngineerRow | null) => (number | null)[];
}[] = [
  {
    title: 'Wait for first review',
    lineNames: ['p50', 'p90'],
    format: 'minutes',
    better: 'lower',
    note: 'How long this person\u2019s own work sits before anyone looks. Done to them, not by them.',
    pick: (r) => [r?.waitP50 ?? null, r?.waitP90 ?? null]
  },
  {
    title: 'Review hours given',
    lineNames: ['hours'],
    format: 'hours',
    better: 'neutral',
    note: 'Their share of the review burden. Rising here is a load problem, not a merit.',
    pick: (r) => [r ? r.reviewHoursGiven : null]
  },
  {
    title: 'Their PRs merged unreviewed',
    lineNames: ['%'],
    format: 'percent',
    better: 'lower',
    note: 'Usually a queue signal: waiting got expensive enough that merging alone won.',
    pick: (r) => [r ? r.unreviewedPct : null]
  },
  {
    title: 'Given / received',
    lineNames: ['ratio'],
    format: 'ratio',
    better: 'neutral',
    note: 'Reviews given per review received. Persistently far from 1 in either direction is worth a conversation.',
    pick: (r) => [r?.reciprocity ?? null]
  },
  {
    title: 'PRs authored',
    lineNames: ['merged'],
    format: 'count',
    better: 'neutral',
    note: 'Context for the rest. Not a productivity measure - a big PR and a typo fix both count once.',
    pick: (r) => [r ? r.authored : null]
  },
  {
    title: 'Reviews given',
    lineNames: ['count'],
    format: 'count',
    better: 'neutral',
    note: 'How many pull requests they looked at.',
    pick: (r) => [r ? r.reviewsGiven : null]
  }
];

/** This person's row within each period, or null where they were absent. */
export function engineerByPeriod(
  periodPulls: PullRequest[][],
  cfg: TaxConfig,
  login: string
): (EngineerRow | null)[] {
  return periodPulls.map((pulls) => byEngineer(pulls, cfg).find((r) => r.login === login) ?? null);
}
