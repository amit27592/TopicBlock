/**
 * Lightweight Canvas 2D charting utilities for the TopicBlock monitoring dashboard.
 *
 * All drawing functions take a CanvasRenderingContext2D and a data payload.
 * They handle their own clearing, scaling, and rendering — no external deps.
 */

// ─── Colour palette ────────────────────────────────────────────────────────

const PURPLE_500 = '#8b5cf6';
const PURPLE_400 = '#a78bfa';
const PURPLE_300 = '#c4b5fd';
const GREEN_400 = '#34d399';
const RED_400 = '#f87171';
const AMBER_400 = '#fbbf24';
const GRID_COLOR = 'rgba(139,92,246,0.08)';
const LABEL_COLOR = 'rgba(255,255,255,0.5)';

// ─── Helpers ────────────────────────────────────────────────────────────────

function setDPR(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
}

/** Smooth Bézier-interpolated path through a set of points. */
function smoothPath(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
): void {
  if (points.length < 2) return;
  const first = points[0]!;
  ctx.moveTo(first.x, first.y);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

// ─── Line Chart ─────────────────────────────────────────────────────────────

export interface LineChartOpts {
  maxPoints?: number;
  yMin?: number;
  yMax?: number;
  color?: string;
  fillAlpha?: number;
  label?: string;
  unit?: string;
  budgetLine?: number;
}

export function drawLineChart(
  canvas: HTMLCanvasElement,
  data: number[],
  opts: LineChartOpts = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  setDPR(canvas, ctx);

  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const pad = { top: 28, right: 16, bottom: 28, left: 48 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  const color = opts.color ?? PURPLE_500;
  const maxPts = opts.maxPoints ?? 100;
  const sliced = data.slice(-maxPts);
  if (sliced.length === 0) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for data…', w / 2, h / 2);
    return;
  }

  const yMin = opts.yMin ?? 0;
  const yMax = opts.yMax ?? Math.max(10, ...sliced) * 1.15;

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  const gridLines = 4;
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= gridLines; i++) {
    const y = pad.top + (ch / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    // Y-axis labels
    const val = yMax - ((yMax - yMin) / gridLines) * i;
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(0) + (opts.unit ?? ''), pad.left - 6, y + 3);
  }
  ctx.setLineDash([]);

  // Budget line
  if (opts.budgetLine !== undefined) {
    const by = pad.top + ch - ((opts.budgetLine - yMin) / (yMax - yMin)) * ch;
    ctx.strokeStyle = RED_400;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, by);
    ctx.lineTo(w - pad.right, by);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = RED_400;
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`budget ${opts.budgetLine}${opts.unit ?? ''}`, w - pad.right + 4, by + 3);
  }

  // Points
  const points = sliced.map((v, i) => ({
    x: pad.left + (i / Math.max(1, sliced.length - 1)) * cw,
    y: pad.top + ch - ((Math.min(v, yMax) - yMin) / (yMax - yMin)) * ch,
  }));

  // Fill
  const lastPt = points[points.length - 1];
  const firstPt = points[0];
  if (lastPt && firstPt) {
    ctx.beginPath();
    smoothPath(ctx, points);
    ctx.lineTo(lastPt.x, pad.top + ch);
    ctx.lineTo(firstPt.x, pad.top + ch);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, color + (opts.fillAlpha !== undefined ? Math.round(opts.fillAlpha * 255).toString(16).padStart(2, '0') : '30'));
    grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Stroke
  ctx.beginPath();
  smoothPath(ctx, points);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Dot on latest
  if (lastPt) {
    ctx.beginPath();
    ctx.arc(lastPt.x, lastPt.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastPt.x, lastPt.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color + '30';
    ctx.fill();
  }

  // Title
  if (opts.label) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(opts.label, pad.left, 16);
  }

  // Latest value
  const latest = sliced[sliced.length - 1];
  if (latest !== undefined) {
    ctx.fillStyle = color;
    ctx.font = 'bold 12px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(latest.toFixed(1) + (opts.unit ?? ''), w - pad.right, 16);
  }
}

// ─── Stacked Area Chart ─────────────────────────────────────────────────────

export interface AreaSeries {
  label: string;
  data: number[];
  color: string;
}

export function drawAreaChart(
  canvas: HTMLCanvasElement,
  series: AreaSeries[],
  opts: { maxPoints?: number; label?: string; unit?: string } = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  setDPR(canvas, ctx);

  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const pad = { top: 28, right: 16, bottom: 28, left: 48 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const maxPts = opts.maxPoints ?? 100;

  const firstSeries = series[0];
  if (series.length === 0 || !firstSeries || firstSeries.data.length === 0) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for data…', w / 2, h / 2);
    return;
  }

  // Stack the data
  const len = Math.min(maxPts, firstSeries.data.length);
  const stacked: number[][] = [];
  for (let s = 0; s < series.length; s++) {
    const src = series[s]!;
    const d = src.data.slice(-len);
    const prevStack = s > 0 ? stacked[s - 1] : undefined;
    stacked.push(d.map((v, i) => v + (prevStack ? (prevStack[i] ?? 0) : 0)));
  }

  const topStack = stacked[stacked.length - 1] ?? [];
  const yMax = Math.max(10, ...topStack) * 1.15;

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    const val = yMax - (yMax / 4) * i;
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(0) + (opts.unit ?? ''), pad.left - 6, y + 3);
  }
  ctx.setLineDash([]);

  // Draw areas back-to-front
  for (let s = series.length - 1; s >= 0; s--) {
    const sData = stacked[s];
    const baseData = s > 0 ? stacked[s - 1] : undefined;
    const currentSeries = series[s];
    if (!sData || !currentSeries) continue;

    const points = sData.map((v, i) => ({
      x: pad.left + (i / Math.max(1, len - 1)) * cw,
      y: pad.top + ch - (v / yMax) * ch,
    }));
    const basePoints = (baseData ?? sData.map(() => 0)).map((v, i) => ({
      x: pad.left + (i / Math.max(1, len - 1)) * cw,
      y: pad.top + ch - (v / yMax) * ch,
    }));

    ctx.beginPath();
    smoothPath(ctx, points);
    for (let i = basePoints.length - 1; i >= 0; i--) {
      const bp = basePoints[i]!;
      ctx.lineTo(bp.x, bp.y);
    }
    ctx.closePath();
    ctx.fillStyle = currentSeries.color + '40';
    ctx.fill();

    ctx.beginPath();
    smoothPath(ctx, points);
    ctx.strokeStyle = currentSeries.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Title
  if (opts.label) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(opts.label, pad.left, 16);
  }

  // Legend
  let lx = w - pad.right;
  ctx.textAlign = 'right';
  for (let s = series.length - 1; s >= 0; s--) {
    const ser = series[s];
    if (!ser) continue;
    const lbl = ser.label;
    ctx.fillStyle = ser.color;
    ctx.font = '10px Inter, system-ui, sans-serif';
    const tw = ctx.measureText(lbl).width;
    ctx.fillRect(lx - tw - 12, 10, 8, 8);
    ctx.fillText(lbl, lx, 17);
    lx -= tw + 24;
  }
}

// ─── Circular Gauge ─────────────────────────────────────────────────────────

export interface GaugeOpts {
  color?: string;
  bgColor?: string;
  label?: string;
  formatValue?: (v: number) => string;
  size?: number;
}

export function drawGauge(
  canvas: HTMLCanvasElement,
  value: number,
  max: number,
  opts: GaugeOpts = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  setDPR(canvas, ctx);

  const size = opts.size ?? Math.min(canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const lw = size * 0.08;
  const pct = Math.min(1, max > 0 ? value / max : 0);
  const color = opts.color ?? (pct > 0.85 ? RED_400 : pct > 0.6 ? AMBER_400 : PURPLE_500);

  ctx.clearRect(0, 0, size, size);

  // Background ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI * 0.75, Math.PI * 0.75);
  ctx.strokeStyle = opts.bgColor ?? 'rgba(139,92,246,0.12)';
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  const startAngle = -Math.PI * 0.75;
  const totalAngle = Math.PI * 1.5;
  const endAngle = startAngle + totalAngle * pct;
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Center value
  const fmt = opts.formatValue ?? ((v: number) => v.toString());
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = `bold ${size * 0.18}px JetBrains Mono, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmt(value), cx, cy - 4);

  // Label
  if (opts.label) {
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = `${size * 0.09}px Inter, system-ui, sans-serif`;
    ctx.fillText(opts.label, cx, cy + size * 0.16);
  }
}

// ─── Horizontal Bar ─────────────────────────────────────────────────────────

export interface BarOpts {
  color?: string;
  bgColor?: string;
  height?: number;
  borderRadius?: number;
}

export function drawBar(
  canvas: HTMLCanvasElement,
  value: number,
  max: number,
  opts: BarOpts = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  setDPR(canvas, ctx);

  const w = canvas.getBoundingClientRect().width;
  const barH = opts.height ?? canvas.getBoundingClientRect().height;
  const br = opts.borderRadius ?? barH / 2;
  const pct = Math.min(1, max > 0 ? value / max : 0);
  const color = opts.color ?? (pct > 0.85 ? RED_400 : pct > 0.6 ? AMBER_400 : GREEN_400);

  ctx.clearRect(0, 0, w, barH);

  // Background
  ctx.beginPath();
  ctx.roundRect(0, 0, w, barH, br);
  ctx.fillStyle = opts.bgColor ?? 'rgba(139,92,246,0.1)';
  ctx.fill();

  // Fill
  if (pct > 0) {
    const fw = Math.max(barH, w * pct); // Ensure the bar has at least the radius as width
    ctx.beginPath();
    ctx.roundRect(0, 0, fw, barH, br);
    const grad = ctx.createLinearGradient(0, 0, fw, 0);
    grad.addColorStop(0, color + 'cc');
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

export { PURPLE_500, PURPLE_400, PURPLE_300, GREEN_400, RED_400, AMBER_400 };
