import type { Concentration, EngineerRow, RepoRow, SizeRow } from '../breakdown.js';
import { durationShort } from './terminal.js';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

const num = (n: number) => Math.round(n).toLocaleString('en-IE');
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`);
const dur = (n: number | null) => durationShort(n);
const hrs = (n: number) => `${n.toFixed(1)} h`;

/** Red when a cell is in the worst quarter of its column. */
const flag = (v: number | null, worst: number, better: 'lower' | 'higher') => {
  if (v === null) return '';
  const bad = better === 'lower' ? v >= worst : v <= worst;
  return bad ? ' class="hot"' : '';
};

const threshold = (values: (number | null)[], better: 'lower' | 'higher') => {
  const real = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (real.length < 4) return Infinity;
  const i = better === 'lower' ? Math.floor(real.length * 0.75) : Math.floor(real.length * 0.25);
  return real[i] ?? Infinity;
};

export function sizeTable(rows: SizeRow[]): string {
  if (!rows.length) return '';
  return `
  <h2>Does pull request size cost you anything</h2>
  <p class="lede">Your own history, not an assertion. If the bottom rows are not
    materially worse than the top ones, the usual advice about small pull requests does not
    apply here and you can ignore it.</p>
  <div class="scroll"><table class="brk">
    <thead><tr>
      <th scope="col">Lines changed</th><th scope="col">PRs</th><th scope="col">Share</th>
      <th scope="col">Cycle p50</th><th scope="col">Cycle p90</th>
      <th scope="col">Unreviewed</th><th scope="col">Rework</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
      <th scope="row">${esc(r.band)}</th>
      <td>${num(r.prs)}</td><td>${pct(r.share)}</td>
      <td>${dur(r.cycleP50)}</td><td>${dur(r.cycleP90)}</td>
      <td>${pct(r.unreviewedPct)}</td><td>${pct(r.churnPct)}</td>
    </tr>`
      )
      .join('')}</tbody>
  </table></div>`;
}

export function repoTable(rows: RepoRow[]): string {
  if (!rows.length) return '';
  const cycleWorst = threshold(rows.map((r) => r.cycleP90), 'lower');
  const unrevWorst = threshold(rows.map((r) => r.unreviewedPct), 'lower');

  return `
  <h2>By repository</h2>
  <p class="lede">Where the time actually goes. A single slow repository can account for
    most of an organisation's review cost while every other one looks healthy.</p>
  <div class="scroll"><table class="brk">
    <thead><tr>
      <th scope="col">Repository</th><th scope="col">PRs</th><th scope="col">Authors</th>
      <th scope="col">Cycle p50</th><th scope="col">Cycle p90</th>
      <th scope="col">Unreviewed</th><th scope="col">Rework</th>
      <th scope="col">PR size p90</th><th scope="col">Review hrs</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
      <th scope="row">${esc(r.repo)}</th>
      <td>${num(r.prs)}</td><td>${num(r.engineers)}</td>
      <td>${dur(r.cycleP50)}</td><td${flag(r.cycleP90, cycleWorst, 'lower')}>${dur(r.cycleP90)}</td>
      <td${flag(r.unreviewedPct, unrevWorst, 'lower')}>${pct(r.unreviewedPct)}</td>
      <td>${pct(r.churnPct)}</td>
      <td>${r.sizeP90 === null ? '—' : num(r.sizeP90)}</td>
      <td>${hrs(r.reviewHours)}</td>
    </tr>`
      )
      .join('')}</tbody>
  </table></div>`;
}

export function engineerTable(
  rows: EngineerRow[],
  c: Concentration,
  /** Supplied by the portal; the static file has nowhere to link to. */
  hrefFor?: (login: string) => string
): string {
  if (!rows.length) return '';
  const waitWorst = threshold(rows.map((r) => r.waitP90), 'lower');
  const loadWorst = threshold(rows.map((r) => r.reviewHoursGiven), 'lower');

  return `
  <h2>By person</h2>
  <div class="warn">
    <p><b>This table is about load, not performance.</b> It deliberately does not report lines
      written or commits made: those measure typing, and ranking people by them teaches a team to
      write longer diffs. What is here is who carries the review burden, whose work sits waiting,
      and whether giving and receiving are balanced.</p>
    <p>Every figure is a property of the process these people work inside. A high wait time is
      something being done <i>to</i> an engineer, not <i>by</i> them.</p>
  </div>
  <p class="lede">Review load is carried by ${c.reviewers} ${
    c.reviewers === 1 ? 'person' : 'people'
  }; half of it sits with ${c.halfLoadCarriedBy}. The busiest carries ${c.topShare.toFixed(
    0
  )}%. Gini ${c.gini.toFixed(2)} &mdash; 0 would be perfectly even, 1 would be one person doing
    all of it.</p>
  <div class="scroll"><table class="brk">
    <thead><tr>
      <th scope="col">Person</th>
      <th scope="col">Authored</th>
      <th scope="col">Wait p50</th><th scope="col">Wait p90</th>
      <th scope="col">Merged unreviewed</th>
      <th scope="col">Reviews given</th><th scope="col">Review hrs</th>
      <th scope="col">Reviews received</th><th scope="col">Given / received</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
      <th scope="row">${
        hrefFor ? `<a class="who" href="${hrefFor(r.login)}">${esc(r.login)}</a>` : esc(r.login)
      }</th>
      <td>${num(r.authored)}</td>
      <td>${dur(r.waitP50)}</td><td${flag(r.waitP90, waitWorst, 'lower')}>${dur(r.waitP90)}</td>
      <td>${pct(r.unreviewedPct)}</td>
      <td>${num(r.reviewsGiven)}</td>
      <td${flag(r.reviewHoursGiven, loadWorst, 'lower')}>${hrs(r.reviewHoursGiven)}</td>
      <td>${num(r.reviewsReceived)}</td>
      <td>${r.reciprocity === null ? '—' : r.reciprocity.toFixed(2)}</td>
    </tr>`
      )
      .join('')}</tbody>
  </table></div>
  <p class="stamp">GIVEN / RECEIVED BELOW 0.5 IS A ONE-WAY STREET &middot;
    HIGHLIGHTED CELLS ARE THE WORST QUARTER OF THEIR COLUMN</p>`;
}

export const TABLE_CSS = `
  .scroll{overflow-x:auto;border:1px solid var(--rule);margin:8px 0 18px}
  table.brk{border-collapse:collapse;width:100%;min-width:640px;background:var(--card)}
  table.brk th,table.brk td{padding:9px 13px;border-bottom:1px solid var(--rule-soft,var(--rule));
    text-align:right;font-family:var(--f-mono);font-size:12.5px;color:var(--ink-2);white-space:nowrap}
  table.brk th[scope=row]{text-align:left;color:var(--ink);font-weight:400}
  table.brk thead th{position:sticky;top:0;background:var(--card-2);color:var(--ink-3);
    font-family:var(--f-mono);font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;
    font-weight:500;border-bottom:1px solid var(--rule);text-align:right}
  table.brk thead th:first-child{text-align:left}
  table.brk tbody tr:last-child th,table.brk tbody tr:last-child td{border-bottom:0}
  table.brk td.hot{color:var(--debit)}
  .lede{font-size:15px;color:var(--ink-2);max-width:72ch}
  .warn{border:1px solid var(--rule);border-left:3px solid var(--debit);background:var(--card);
        padding:16px 20px;margin:10px 0 16px}
  .warn p{font-size:14.5px;color:var(--ink-2);margin:0 0 8px;max-width:76ch}
  .warn p:last-child{margin-bottom:0}
  .warn b{color:var(--ink)}
  table.brk a.who{color:var(--ink);text-decoration-thickness:1px;text-underline-offset:2px}
  table.brk a.who:hover{color:var(--debit)}
  .back{display:inline-block;font-family:var(--f-mono);font-size:12px;color:var(--ink-2);
        margin:0 0 18px;text-decoration:none;border:1px solid var(--rule);padding:4px 10px;
        background:var(--card)}
  .back:hover{color:var(--ink);border-color:var(--ink-3)}
`;
