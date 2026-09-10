import type { TaxConfig } from '../config.js';
import type { Ledger } from '../model.js';

const useColour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = wrap('2');
const red = wrap('31');
const green = wrap('32');
const bold = wrap('1');

/** Visible width, ignoring any colour codes already applied. */
const width = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const padTo = (s: string, col: number) => s + ' '.repeat(Math.max(1, col - width(s)));
/** Appends `text` so that it ENDS at column `endCol`, padding the gap. */
const at = (line: string, endCol: number, text: string) =>
  line + ' '.repeat(Math.max(1, endCol - width(line) - width(text))) + text;

export const money = (n: number, currency: string) =>
  new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0
  }).format(Math.round(n));

export function duration(mins: number | null): string {
  if (mins === null) return '—';
  const h = Math.floor(mins / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
  return `${h}h ${String(Math.round(mins % 60)).padStart(2, '0')}m`;
}

const num = (n: number) => n.toLocaleString('en-IE');
const hrs = (n: number) => `${Math.round(n).toLocaleString('en-IE')} h/yr`;

const STAT_VALUE_END = 44;
const NOTE_COL = 48;
const HOURS_END = 50;
const AMOUNT_END = 68;
const RULE = '—'.repeat(12);

function stat(label: string, value: string, note?: string): string {
  const line = at('  ' + label, STAT_VALUE_END, value);
  return note ? padTo(line, NOTE_COL) + dim(note) : line;
}

function ledgerLine(
  label: string,
  hours: string,
  amount: string,
  colour: (s: string) => string,
  note?: string
): string {
  let line = at('  ' + label, HOURS_END, dim(hours));
  line = at(line, AMOUNT_END, colour(amount));
  return note ? line + '  ' + dim(note) : line;
}

export function renderTerminal(
  ledger: Ledger,
  cfg: TaxConfig,
  meta: { org: string; windowLabel: string; reportPath: string; configPath: string; cached: boolean }
): string {
  const m = ledger.metrics;
  const cur = cfg.currency;
  const L: string[] = [''];

  L.push(
    dim(
      `  Read ${num(m.prsMerged)} merged pull requests from ${meta.org} ` +
        `(${num(m.repoCount)} repos)${meta.cached ? '   [cached]' : ''}`
    )
  );
  L.push(dim(`  Nothing sent anywhere. Report written to ${meta.reportPath}`));
  L.push('');
  L.push(bold(`  THE VERIFICATION TAX — ${meta.org}, ${meta.windowLabel}`));
  L.push('');

  L.push(stat('Engineers', num(m.engineers)));
  L.push(stat('PRs merged', num(m.prsMerged)));
  L.push(
    stat(
      'Median time to first review',
      duration(m.medianTimeToFirstReviewMins),
      `${num(m.reviewedCount)} reviewed PRs`
    )
  );
  L.push(stat('Median time in review', duration(m.medianTimeInReviewMins)));
  L.push(
    stat(
      'Merged with no human review',
      `${m.pctMergedUnreviewed.toFixed(1)}%`,
      `${num(m.unreviewedCount)} PRs`
    )
  );
  L.push(
    stat(
      `Lines in files re-touched <${cfg.rework.window_days}d`,
      `${m.reworkRate.toFixed(1)}%`,
      `${num(m.reworkedLines)} of ${num(m.totalLines)} lines`
    )
  );
  L.push(
    stat(
      'Review load, top decile',
      `${m.topDecileReviewHoursPerWeek.toFixed(1)} h/wk`,
      m.reviewerCount
        ? `${num(m.topDecileReviewerCount)} of ${num(m.reviewerCount)} carry ` +
            `${Math.round(m.topDecileShare * 100)}%`
        : 'no human reviewers found'
    )
  );
  L.push(stat('PR size, p50 / p90', `${num(m.prSizeP50)} / ${num(m.prSizeP90)}`, 'lines changed'));
  L.push('');

  L.push(bold('  DEBITS'));
  L.push('');
  for (const d of ledger.debits) {
    L.push(
      ledgerLine(
        d.label,
        d.hoursPerYear === null ? '—' : hrs(d.hoursPerYear),
        money(d.amount, cur),
        dim,
        d.note
      )
    );
  }
  L.push(at('', AMOUNT_END, dim(RULE)));
  L.push(at('', AMOUNT_END, red(money(ledger.debitTotal, cur))));
  L.push('');

  L.push(bold('  CREDITS'));
  L.push('');
  for (const cr of ledger.credits) {
    L.push(
      ledgerLine(
        cr.label,
        cr.hoursPerYear === null ? '—' : hrs(cr.hoursPerYear),
        money(cr.amount, cur),
        cr.amount >= 0 ? green : red,
        cr.note
      )
    );
  }
  L.push(at('', AMOUNT_END, dim(RULE)));

  const netStr = (ledger.net < 0 ? '−' : '') + money(Math.abs(ledger.net), cur);
  L.push(at(bold('  NET'), AMOUNT_END, ledger.net < 0 ? red(netStr) : green(netStr)));
  L.push('');

  const { low, high } = ledger.sensitivity;
  const signed = (n: number) => (n < 0 ? '−' : '+') + money(Math.abs(n), cur);
  L.push(
    dim(
      `  Sensitivity: ${signed(Math.min(low, high))} to ${signed(Math.max(low, high))} ` +
        `at ±${Math.round(cfg.sensitivity * 100)}% on every coefficient.`
    )
  );
  if (!ledger.creditComputed) {
    L.push(
      dim('  The credit side is NOT in the net above. Pass --baseline <since>..<until> to claim it.')
    );
  }
  L.push(dim(`  Every coefficient lives in ${meta.configPath}. Disagree, edit, rerun.`));
  if (m.filesTruncatedCount) {
    L.push(
      dim(
        `  ${num(m.filesTruncatedCount)} PRs touched over 100 files; rework is undercounted there.`
      )
    );
  }
  L.push('');
  return L.join('\n');
}
