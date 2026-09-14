import type { Period, SeriesSpec, Trend } from '../series.js';
import { trendOf } from '../series.js';
import { durationShort } from './terminal.js';

const num = (n: number) => Math.round(n).toLocaleString('en-IE');

export function formatValue(v: number | null, format: SeriesSpec['format']): string {
  if (v === null) return '—';
  switch (format) {
    case 'percent':
      return `${v.toFixed(1)}%`;
    case 'minutes':
      return durationShort(v);
    case 'ratio':
      return v.toFixed(2);
    case 'hours':
      return `${v.toFixed(1)} h/wk`;
    default:
      return num(v);
  }
}

const W = 300;
const H = 76;
const PAD = 4;

/** Path data for one line, breaking the path wherever a period has no value. */
function path(values: (number | null)[], min: number, max: number): string {
  const n = values.length;
  const span = max - min || 1;
  const x = (i: number) => (n === 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2));
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);

  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

function lastPoint(values: (number | null)[], min: number, max: number) {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    const n = values.length;
    const span = max - min || 1;
    return {
      cx: n === 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2),
      cy: H - PAD - ((v - min) / span) * (H - PAD * 2)
    };
  }
  return null;
}

function trendBadge(trend: Trend, better: SeriesSpec['better']): string {
  if (trend.change === null || !Number.isFinite(trend.change)) {
    return '<span class="tr flat">not enough data</span>';
  }
  const pct = Math.abs(trend.change * 100);
  if (pct < 5) return '<span class="tr flat">flat</span>';

  const up = trend.change > 0;
  const good = better === 'neutral' ? null : (better === 'lower') === !up;
  const cls = good === null ? 'flat' : good ? 'good' : 'bad';
  // Arrows describe the data; the colour says whether that is welcome.
  return `<span class="tr ${cls}">${up ? '▲' : '▼'} ${pct.toFixed(0)}%</span>`;
}

/** One small-multiple card: title, latest value, trend, and the line chart. */
export function chartCard(spec: SeriesSpec, periods: Period[]): string {
  const series = spec.lines.map((l) => periods.map((p) => l.pick(p.metrics)));
  const flat = series.flat().filter((v): v is number => v !== null);

  if (!flat.length) {
    return `<figure class="card">
      <figcaption><span class="t">${spec.title}</span></figcaption>
      <p class="empty">No data in this window.</p>
    </figure>`;
  }

  // Always include zero so a flat line near a large value does not look dramatic.
  const min = Math.min(0, ...flat);
  const max = Math.max(...flat);

  // On a p50/p90 pair the tail is the signal - "is it getting worse" is a
  // question about the slow PRs, not the instant ones - so trend the last line.
  const primary = spec.lines.at(-1)!;
  const trend = trendOf(periods, primary.pick);
  const latest = series
    .map((values) => formatValue(values.filter((v): v is number => v !== null).at(-1) ?? null, spec.format))
    .join(' / ');

  const lines = series
    .map((values, i) => {
      const cls = i === 0 ? 'l1' : 'l2';
      const dot = lastPoint(values, min, max);
      return (
        `<path class="${cls}" d="${path(values, min, max)}" fill="none" />` +
        (dot ? `<circle class="${cls}d" cx="${dot.cx.toFixed(1)}" cy="${dot.cy.toFixed(1)}" r="2.5" />` : '')
      );
    })
    .join('');

  const legend =
    spec.lines.length > 1
      ? `<span class="lg"><i class="k1"></i>${spec.lines[0]!.name}` +
        `<i class="k2" style="margin-left:10px"></i>${spec.lines[1]!.name}</span>`
      : '';

  const firstLabel = periods[0]?.label ?? '';
  const lastLabel = periods.at(-1)?.label ?? '';

  const midLabel = periods[Math.floor((periods.length - 1) / 2)]?.label ?? '';

  // One full-height column per period. Hovering anywhere in the column shows
  // the tooltip, so this stays usable at 90 daily points where individual dots
  // would be three pixels apart. Pure CSS - the report ships no script.
  const n = periods.length;
  const colWidth = 100 / n;
  const yPct = (v: number) => {
    const span = max - min || 1;
    return ((H - PAD - ((v - min) / span) * (H - PAD * 2)) / H) * 100;
  };

  const overlay = periods
    .map((period, i) => {
      const values = spec.lines.map((l) => l.pick(period.metrics));
      const dots = values
        .map((v, li) =>
          v === null
            ? ''
            : `<i class="d${li + 1}" style="top:${yPct(v).toFixed(1)}%"></i>`
        )
        .join('');
      const readout = spec.lines
        .map((l, li) => `${spec.lines.length > 1 ? l.name + ' ' : ''}${formatValue(values[li] ?? null, spec.format)}`)
        .join(' · ');
      // Horizontally: anchor inward at the edges so the card does not clip it.
      const side = i < n / 2 ? 'left:0' : 'right:0';
      // Vertically: sit just above the point, or below it when the point is
      // already near the top - otherwise the tooltip covers the card's title.
      const primaryValue = values[values.length - 1];
      const y = primaryValue === null || primaryValue === undefined ? 50 : yPct(primaryValue);
      const vertical =
        y < 45 ? `top:calc(${y.toFixed(1)}% + 10px)` : `bottom:calc(${(100 - y).toFixed(1)}% + 10px)`;
      return `<span class="pt" style="left:${(i * colWidth).toFixed(3)}%;width:${colWidth.toFixed(3)}%">${dots}<span class="tip" style="${side};${vertical}"><b>${period.full}</b>${readout}</span></span>`;
    })
    .join('');

  return `<figure class="card">
      <figcaption>
        <span class="t">${spec.title}</span>
        <span class="v">${latest}</span>
        ${trendBadge(trend, spec.better)}
      </figcaption>
      <div class="plot">
        <div class="yax" aria-hidden="true">
          <span>${formatValue(max, spec.format)}</span>
          <span>${formatValue(min + (max - min) / 2, spec.format)}</span>
          <span>${formatValue(min, spec.format)}</span>
        </div>
        <div class="canvas">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="${spec.title}${spec.lines.length > 1 ? ' (' + primary.name + ')' : ''}: ${formatValue(trend.first, spec.format)} in the first half of the window, ${formatValue(trend.last, spec.format)} in the second.">
        <line class="grid" x1="0" y1="${PAD}" x2="${W}" y2="${PAD}" />
        <line class="grid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" />
        <line class="base" x1="0" y1="${H - PAD}" x2="${W}" y2="${H - PAD}" />
        ${lines}
      </svg>
        <div class="hov" aria-hidden="true">${overlay}</div>
      </div>
      </div>
      <div class="ax">
        <span>${firstLabel}</span><span class="mid">${midLabel}</span><span>${lastLabel}</span>
      </div>
      ${legend}
      <p class="n">${spec.note}</p>
    </figure>`;
}

export const CHART_CSS = `
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1px;
        background:var(--rule);border:1px solid var(--rule);margin:8px 0 0}
  .card{background:var(--card);margin:0;padding:16px 18px 14px}
  .card figcaption{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:10px}
  .card .t{font-size:14px;font-weight:600;color:var(--ink);flex:1 1 auto}
  .card .v{font-family:var(--f-mono);font-size:15px;color:var(--ink)}
  .card .tr{font-family:var(--f-mono);font-size:11px;padding:1px 5px;border:1px solid var(--rule)}
  .card .tr.good{color:var(--credit)}
  .card .tr.bad{color:var(--debit)}
  .card .tr.flat{color:var(--ink-3)}
  .card .plot{display:flex;align-items:stretch;gap:6px}
  .card .yax{display:flex;flex-direction:column;justify-content:space-between;
             font-family:var(--f-mono);font-size:10px;line-height:1;color:var(--ink-3);
             text-align:right;min-width:36px;padding:2px 0}
  .card .canvas{position:relative;flex:1 1 auto;min-width:0}
  .card svg{width:100%;height:76px;display:block;overflow:visible}
  .card .hov{position:absolute;inset:0}
  .card .pt{position:absolute;top:0;bottom:0}
  .card .pt i{position:absolute;left:50%;width:6px;height:6px;margin:-3px 0 0 -3px;
              border-radius:50%;opacity:0;transition:opacity .08s}
  .card .pt i.d1{background:var(--ink)}
  .card .pt i.d2{background:var(--debit)}
  .card .pt:hover i{opacity:1}
  .card .tip{position:absolute;display:none;z-index:2;
             background:var(--ink);color:var(--paper);padding:6px 9px;
             font-family:var(--f-mono);font-size:11px;line-height:1.45;
             white-space:nowrap;pointer-events:none}
  .card .tip b{display:block;font-weight:500;opacity:0.72}
  .card .pt:hover .tip{display:block}
  @media (prefers-reduced-motion:reduce){.card .pt i{transition:none}}
  .card .base{stroke:var(--rule);stroke-width:1}
  .card .grid{stroke:var(--rule-soft,var(--rule));stroke-width:1;stroke-dasharray:2 3;opacity:0.6}
  .card .l1{stroke:var(--ink);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
  .card .l2{stroke:var(--debit);stroke-width:1.5;stroke-dasharray:3 2;
            stroke-linejoin:round;stroke-linecap:round;fill:none}
  .card .l1d{fill:var(--ink)}
  .card .l2d{fill:var(--debit)}
  .card .ax{display:flex;justify-content:space-between;align-items:center;
            font-family:var(--f-mono);font-size:10.5px;color:var(--ink-3);
            margin:6px 0 0 42px}
  .card .ax .mid{color:var(--ink-3);opacity:0.75}
  .card .lg{display:block;font-family:var(--f-mono);font-size:10.5px;color:var(--ink-3);
            margin:6px 0 0 42px}
  .card .lg i{display:inline-block;width:9px;height:2px;margin:0 4px 0 0;vertical-align:middle}
  .card .lg i.k1{background:var(--ink)}
  .card .lg i.k2{background:var(--debit)}
  .card .n{font-size:12.5px;color:var(--ink-3);margin:8px 0 0;max-width:none}
  .card .empty{font-size:13px;color:var(--ink-3);margin:0}
  @media print{.grid{break-inside:avoid}}
`;
