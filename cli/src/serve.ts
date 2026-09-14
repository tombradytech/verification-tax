import { createServer } from 'node:http';
import type { TaxConfig } from './config.js';
import type { PullRequest } from './github.js';
import { churnSubset, pullKey, type ChurnResult } from './churn.js';
import { buildLedger, type Window } from './model.js';
import { buildSeries, defaultGranularity, type Granularity } from './series.js';
import { renderHtml } from './report/html.js';

/** Selectable ranges, in days back from the end of the fetched window. */
export const RANGES: [label: string, days: number][] = [
  ['1d', 1],
  ['1w', 7],
  ['1m', 30],
  ['3m', 91],
  ['6m', 183],
  ['9m', 274],
  ['1y', 365],
  ['2y', 730]
];

const BUCKETS: Granularity[] = ['day', 'week', 'month'];

export interface ServeData {
  org: string;
  pulls: PullRequest[];
  cfg: TaxConfig;
  window: Window;
  repoCount: number;
  churn?: ChurnResult;
  baseline: { pulls: PullRequest[]; window: Window; repoCount: number } | null;
  version: string;
}

const MS_PER_DAY = 86_400_000;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The range and bucket pickers, as plain links.
 *
 * Links rather than a <select> on purpose: the whole report is server-rendered
 * and ships no script, so a dropdown would need JavaScript to do anything. A
 * link is a link.
 */
function controls(active: { days: number; bucket: Granularity }, fetchedDays: number): string {
  const ranges = RANGES.map(([label, days]) => {
    // A range longer than what was fetched would silently show less than it says.
    const available = days <= fetchedDays + 1;
    const current = days === active.days;
    if (!available) {
      return `<span class="opt off" title="Only ${fetchedDays} days were fetched. Rerun with --since to widen.">${label}</span>`;
    }
    return `<a class="opt${current ? ' on' : ''}" href="/?range=${days}&amp;bucket=${active.bucket}"${
      current ? ' aria-current="true"' : ''
    }>${label}</a>`;
  }).join('');

  const buckets = BUCKETS.map((b) => {
    const current = b === active.bucket;
    return `<a class="opt${current ? ' on' : ''}" href="/?range=${active.days}&amp;bucket=${b}"${
      current ? ' aria-current="true"' : ''
    }>${b}</a>`;
  }).join('');

  return `<nav class="ctl" aria-label="Window">
    <span class="lbl">Period</span>${ranges}
    <span class="lbl sp">Buckets</span>${buckets}
  </nav>`;
}

export const CONTROL_CSS = `
  .ctl{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 26px;
       padding:12px 14px;border:1px solid var(--rule);background:var(--card)}
  .ctl .lbl{font-family:var(--f-mono);font-size:10.5px;letter-spacing:0.1em;
            text-transform:uppercase;color:var(--ink-3);margin-right:4px}
  .ctl .lbl.sp{margin-left:16px}
  .ctl .opt{font-family:var(--f-mono);font-size:12.5px;padding:3px 9px;border:1px solid var(--rule);
            color:var(--ink-2);text-decoration:none;background:var(--paper)}
  .ctl a.opt:hover{color:var(--ink);border-color:var(--ink-3)}
  .ctl .opt.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
  .ctl .opt.off{opacity:0.35;cursor:not-allowed}
  .ctl a.opt:focus-visible{outline:2px solid var(--debit);outline-offset:2px}
`;

/**
 * Serves the report on localhost, re-rendering per request from data already in
 * memory. It never calls GitHub: every view is a different slice of the pull
 * requests fetched once at startup.
 */
export function serveReport(data: ServeData, port: number, note: (s: string) => void): Promise<void> {
  const fetchedDays = Math.max(
    1,
    Math.round((+data.window.until - +data.window.since) / MS_PER_DAY)
  );

  const render = (days: number, bucket: Granularity): string => {
    const until = data.window.until;
    const since = new Date(Math.max(+data.window.since, +until - days * MS_PER_DAY));
    const win: Window = { since, until };

    const pulls = data.pulls.filter((p) => {
      const t = +new Date(p.mergedAt);
      return t >= +since && t <= +until;
    });

    const churn = data.churn
      ? churnSubset(
          data.churn,
          pulls.map((p) => pullKey(p.repo, p.number))
        )
      : undefined;

    const ledger = buildLedger(pulls, data.cfg, win, data.repoCount, data.baseline, churn);
    const periods = buildSeries(pulls, data.cfg, win, data.repoCount, bucket, churn);

    return renderHtml(
      ledger,
      data.cfg,
      {
        org: data.org,
        windowLabel: `${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`,
        generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        version: data.version
      },
      periods,
      controls({ days, bucket }, fetchedDays)
    );
  };

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found.');
        return;
      }

      const requested = Number(url.searchParams.get('range'));
      const days =
        Number.isFinite(requested) && requested > 0
          ? Math.min(requested, fetchedDays)
          : Math.min(365, fetchedDays);

      const b = url.searchParams.get('bucket');
      const bucket: Granularity =
        b === 'day' || b === 'week' || b === 'month' ? b : defaultGranularity(days);

      try {
        const html = render(days, bucket);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          // Self-contained: nothing to fetch, so allow nothing to be fetched.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        });
        res.end(req.method === 'HEAD' ? undefined : html);
      } catch (err) {
        res
          .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          .end(`Failed to render: ${esc((err as Error).message)}`);
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use. Pass a different one: --serve 8080`)
          : err
      );
    });

    // 127.0.0.1, not 0.0.0.0: this should not appear on the office network.
    server.listen(port, '127.0.0.1', () => {
      note('');
      note(`  Portal at http://localhost:${port}  (${fetchedDays} days of data in memory)`);
      note('  Changing the period re-slices what is already here. Nothing is fetched. Ctrl-C to stop.');
    });

    const stop = () => {
      server.close(() => resolve());
      note('\n  Stopped.');
      setTimeout(() => process.exit(0), 200).unref();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
