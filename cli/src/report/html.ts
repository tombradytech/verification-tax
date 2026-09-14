import type { TaxConfig } from '../config.js';
import type { Ledger } from '../model.js';
import { durationPair, money } from './terminal.js';
import { SERIES, type Period } from '../series.js';
import { CHART_CSS, chartCard } from './charts.js';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

const num = (n: number) => n.toLocaleString('en-IE');

/**
 * A single self-contained file. No external stylesheet, no font CDN, no script,
 * no image - it has to be readable on a laptop with no network and safe to
 * forward to a CFO without leaking a referrer to anybody.
 */
export function renderHtml(
  ledger: Ledger,
  cfg: TaxConfig,
  meta: { org: string; windowLabel: string; generatedAt: string; version: string },
  periods: Period[] = []
): string {
  const m = ledger.metrics;
  const cur = cfg.currency;

  const stats: [string, string, string][] = [
    ['Engineers', num(m.engineers), 'distinct PR authors, bots excluded'],
    ['PRs merged', num(m.prsMerged), `across ${num(m.repoCount)} repositories`],
    [
      'PR cycle time, p50 / p90',
      durationPair(m.cycleTimeP50, m.cycleTimeP90),
      'opened to merged, every merged PR including the unreviewed ones'
    ],
    [
      'Time to first review, p50 / p90',
      durationPair(m.timeToFirstReviewP50, m.timeToFirstReviewP90),
      `${num(m.reviewedCount)} PRs received a human review`
    ],
    [
      'Time in review, p50 / p90',
      durationPair(m.timeInReviewP50, m.timeInReviewP90),
      'first review to merge'
    ],
    [
      'Merged with no human review',
      `${m.pctMergedUnreviewed.toFixed(1)}%`,
      `${num(m.unreviewedCount)} pull requests`
    ],
    [
      m.churnMethod === 'line'
        ? `Added lines later deleted <${cfg.rework.window_days}d`
        : `Lines in files re-touched <${cfg.rework.window_days}d`,
      `${m.reworkRate.toFixed(1)}%`,
      `${num(m.reworkedLines)} of ${num(m.totalLines)} lines; ${Math.round(cfg.rework.attribution_rate * 100)}% of those charged as rework`
    ],
    [
      m.topDecileReviewerCount === 1 ? 'Review load, busiest reviewer' : 'Review load, top decile',
      `${m.topDecileReviewHoursPerWeek.toFixed(1)} h/wk`,
      m.reviewerCount
        ? `${num(m.topDecileReviewerCount)} of ${num(m.reviewerCount)} reviewers carry ${Math.round(m.topDecileShare * 100)}% of the load`
        : 'no human reviewers found in this window'
    ],
    ['PR size, p50 / p90', `${num(m.prSizeP50)} / ${num(m.prSizeP90)}`, 'lines changed per PR'],
    [
      'Reviewers per reviewed PR',
      m.reviewsPerReviewedPr.toFixed(2),
      'mean human reviewers on the PRs that got any review'
    ],
    [
      'Delayed PRs',
      num(m.delayedPrCount),
      `open longer than ${cfg.delay.threshold_days} days, ${num(Math.round(m.excessDelayDays))} excess PR-days`
    ]
  ];

  const row = (l: { label: string; hoursPerYear: number | null; amount: number; note?: string }) => `
        <tr>
          <th scope="row">${esc(l.label)}${l.note ? `<span class="note">${esc(l.note)}</span>` : ''}</th>
          <td class="n">${l.hoursPerYear === null ? '—' : num(Math.round(l.hoursPerYear)) + ' h/yr'}</td>
          <td class="n money">${esc(money(l.amount, cur))}</td>
        </tr>`;

  const { low, high } = ledger.sensitivity;
  const signed = (n: number) => (n < 0 ? '−' : '+') + money(Math.abs(n), cur);
  const netStr = (ledger.net < 0 ? '−' : '') + money(Math.abs(ledger.net), cur);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>The verification tax — ${esc(meta.org)}</title>
<style>
  :root {
    --paper:#F1F1EF; --card:#FFF; --card-2:#E8E8E5; --ink:#17171A; --ink-2:#4E4E55;
    --ink-3:#6C6C75; --rule:#D4D4CF; --debit:#B0281D; --credit:#1C6A4B;
    --f-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    --f-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){:root{
    --paper:#101012; --card:#17171A; --card-2:#1E1E22; --ink:#EDEDEA; --ink-2:#A9A9B0;
    --ink-3:#86868F; --rule:#2C2C31; --debit:#E58072; --credit:#55B58C;
  }}
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--f-ui);
       font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:820px;margin:0 auto;padding:48px 24px 80px}
  h1{font-size:29px;line-height:1.15;letter-spacing:-0.02em;margin:0 0 6px;font-weight:600}
  .stamp{font-family:var(--f-mono);font-size:12px;letter-spacing:0.06em;color:var(--ink-3);margin:0 0 34px}
  h2{font-size:13px;font-family:var(--f-mono);letter-spacing:0.12em;text-transform:uppercase;
     color:var(--ink-3);font-weight:500;margin:38px 0 12px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--rule)}
  th,td{text-align:left;padding:11px 16px;border-bottom:1px solid var(--rule);vertical-align:top;font-weight:400}
  th[scope=row]{color:var(--ink)}
  tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
  td.n{font-family:var(--f-mono);font-size:13.5px;text-align:right;white-space:nowrap;color:var(--ink-2)}
  td.money{color:var(--ink)}
  .note{display:block;font-size:13px;color:var(--ink-3);font-weight:400;margin-top:2px}
  tr.total th,tr.total td{border-top:2px solid var(--ink);background:var(--card-2)}
  tr.total td.money{color:var(--debit);font-weight:600}
  .net{border:1px solid var(--rule);border-left:3px solid var(--debit);background:var(--card);
       padding:22px 26px;margin:14px 0 0;display:flex;flex-wrap:wrap;gap:8px 24px;
       align-items:baseline;justify-content:space-between}
  .net .k{font-family:var(--f-mono);font-size:12px;letter-spacing:0.12em;color:var(--ink-3)}
  .net .v{font-family:var(--f-mono);font-size:30px;font-weight:500;
          color:${ledger.net < 0 ? 'var(--debit)' : 'var(--credit)'}}
  .caveats{margin-top:40px;border-top:1px solid var(--rule);padding-top:22px}
  .caveats li{color:var(--ink-2);font-size:15px;margin-bottom:9px;max-width:70ch}
  .caveats b{color:var(--ink)}
  footer{margin-top:32px;font-family:var(--f-mono);font-size:11.5px;color:var(--ink-3)}
  @media print{body{background:#fff}.net,table{break-inside:avoid}}
${CHART_CSS}
</style>
</head>
<body>
<div class="wrap">
  <h1>The verification tax &mdash; ${esc(meta.org)}</h1>
  <p class="stamp">${esc(meta.windowLabel.toUpperCase())} &middot; GENERATED ${esc(meta.generatedAt)} &middot; verification-tax ${esc(meta.version)}</p>

  <h2>What your history says</h2>
  <table>
    <tbody>
      ${stats
        .map(
          ([l, v, n]) => `<tr>
        <th scope="row">${esc(l)}<span class="note">${esc(n)}</span></th>
        <td class="n money">${esc(v)}</td>
      </tr>`
        )
        .join('\n      ')}
    </tbody>
  </table>

  ${
    periods.length > 1
      ? `<h2>Is it getting better or worse</h2>
  <div class="grid">${SERIES.map((spec) => chartCard(spec, periods)).join('')}</div>
  <p class="stamp" style="margin-top:12px">
    ${periods.length} PERIODS &middot; TREND COMPARES THE MEAN OF THE FIRST HALF OF THE WINDOW
    WITH THE SECOND, NOT THE FIRST POINT WITH THE LAST
  </p>`
      : ''
  }

  <h2>Debits</h2>
  <table>
    <tbody>${ledger.debits.map(row).join('')}
      <tr class="total">
        <th scope="row">Total</th><td class="n"></td>
        <td class="n money">${esc(money(ledger.debitTotal, cur))}</td>
      </tr>
    </tbody>
  </table>

  <h2>Credits</h2>
  <table>
    <tbody>${ledger.credits.map(row).join('')}</tbody>
  </table>

  <div class="net">
    <span class="k">NET, PER YEAR</span>
    <span class="v">${esc(netStr)}</span>
  </div>
  <p class="stamp" style="margin-top:12px">
    SENSITIVITY ${esc(signed(Math.min(low, high)))} TO ${esc(signed(Math.max(low, high)))}
    AT &plusmn;${Math.round(cfg.sensitivity * 100)}% ON EVERY COEFFICIENT
  </p>

  <div class="caveats">
    <h2 style="margin-top:0">Reasons to distrust this number</h2>
    <ul>
      <li><b>It is an estimate, not a stopwatch.</b> Review hours are inferred from diff size and
        reviewer count using coefficients in <code>tax.config.json</code>. Nobody was timed.</li>
      <li><b>Every coefficient is a placeholder.</b> They ship as plausible round numbers, not
        measurements of this organisation. Edit them and rerun; trust the delta between runs more
        than any absolute figure.</li>
      ${
        ledger.creditComputed
          ? `<li><b>The credit side is softer than the debit side.</b> It cannot see which code AI
        wrote, so hours saved are inferred from how throughput changed between your baseline window
        and this one. Everything else that changed is credited to AI along with it.</li>`
          : `<li><b>The credit side is not in this number at all.</b> No baseline window was given,
        so no authoring saving has been claimed. The net above is debits only.</li>`
      }
      ${
        m.churnMethod === 'line'
          ? `<li><b>Churn is line-level but line numbers drift.</b> A line counts as reworked if a
        later pull request deleted that line number from the same file within
        ${cfg.rework.window_days} days. Intervening edits shift numbering, so individual
        attributions can be wrong in both directions.</li>`
          : `<li><b>Rework is measured at file level, not line level.</b> A line counts as reworked if
        the file it landed in was changed again within ${cfg.rework.window_days} days. This
        overstates churn badly over long windows - nearly every file is eventually touched again -
        so it drifts toward 100%. Rerun with --churn=line for the real measurement.</li>`
      }
      <li><b>Review that happened away from GitHub is invisible here.</b> Pairing, desk
        conversations and Slack threads are not counted, so diligent teams that talk more than they
        comment are undercounted.</li>
      <li><b>It measures cost, not value.</b> A negative net is an argument to find out where the
        money goes, not automatically an argument to spend less.</li>
    </ul>
  </div>

  <footer>
    Generated locally by verification-tax. No data left this machine.
    Hourly cost ${esc(money(cfg.hourly_cost, cur))}, window ${num(m.windowDays)} days,
    annualised &times;${ledger.annualisation.toFixed(2)}.
  </footer>
</div>
</body>
</html>
`;
}
