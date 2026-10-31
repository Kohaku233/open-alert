import { OVERLAY_SPECS, factoryStyleFor, setDefaultStyleOverride } from 'lightweight-charts-drawing';
import type { Drawing, DrawingKind, DrawingStyle, LevelDef } from 'lightweight-charts-drawing';

/** How each tool actually paints, checked against the library's renderers: level tools take their line and band
 * colours from `levels`, the regression trend from `regressionLines`; the drawing-wide `color` is ignored there. */
export const LINE_STYLES: { value: DrawingStyle['lineStyle']; label: string }[] = [{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }];
export const FONT_SIZES = [10, 12, 14, 16, 20, 24, 28, 32, 40];

export const LEVEL_KINDS = new Set<DrawingKind>(['fib-retracement', 'trend-based-fib-extension', 'fib-channel', 'fib-time-zone', 'pitchfork', 'gann-fan', 'parallel-channel']);
export const isLevelKind = (kind: DrawingKind) => LEVEL_KINDS.has(kind);
// Markers and pure text boxes have no stroke width; their colour is the mark (or the text) itself.
const NO_STROKE = new Set<DrawingKind>(['text', 'note', 'price-label', 'arrow-mark-up', 'arrow-mark-down']);
// Always-filled boxes: the fill can change colour and opacity but cannot be switched off.
const ALWAYS_FILLED = new Set<DrawingKind>(['callout', 'price-label']);
// The note paints its background fully opaque.
const NO_OPACITY = new Set<DrawingKind>(['note']);

export const hasStroke = (kind: DrawingKind) => !NO_STROKE.has(kind);
export const isTextKind = (kind: DrawingKind) => OVERLAY_SPECS[kind]?.textEditable === true;
export const widthsFor = (kind: DrawingKind) => kind === 'highlighter' ? [10, 15, 20, 30, 40] : [1, 2, 3, 4];
/** 'palette': the fill has its own colour; 'toggle': fill on/off and opacity only (bands take the level colours). */
export function fillMode(kind: DrawingKind): 'palette' | 'toggle' | null {
  if (kind === 'parallel-channel' || 'backgroundColor' in factoryStyleFor(kind)) return 'palette';
  if (LEVEL_KINDS.has(kind) || kind === 'regression-trend') return 'toggle';
  return null;
}
export const canUnfill = (kind: DrawingKind) => !ALWAYS_FILLED.has(kind);
export const hasOpacity = (kind: DrawingKind) => !NO_OPACITY.has(kind);
export const isFilled = (d: Drawing) => ALWAYS_FILLED.has(d.kind) || (d.style.fillBackground ?? factoryStyleFor(d.kind).fillBackground ?? true) !== false;
export const fillColorOf = (d: Drawing) => d.style.backgroundColor ?? d.style.color;
// Fill transparency on TradingView's 0-100 scale; the library's own fallback is 80 for most fills.
export const opacityOf = (d: Drawing) => 100 - (d.style.transparency ?? factoryStyleFor(d.kind).transparency ?? 80);

export function levelsOf(d: Drawing): LevelDef[] { return d.style.levels ?? factoryStyleFor(d.kind).levels ?? []; }
type Lines = NonNullable<DrawingStyle['regressionLines']>;
const regressionOf = (d: Drawing): Lines => d.style.regressionLines ?? factoryStyleFor('regression-trend').regressionLines!;
// The parallel channel's border lines carry their own width and style; the other levels keep theirs.
const isBorder = (level: LevelDef) => level.coeff === 0 || level.coeff === 1;

/** The edit bar's one-click colour: every line of the tool, not just the (often unused) drawing colour. */
export function paint(d: Drawing, color: string): Drawing {
  if (LEVEL_KINDS.has(d.kind)) return { ...d, style: { ...d.style, color, levels: levelsOf(d).map(level => ({ ...level, color })) } };
  if (d.kind === 'regression-trend') {
    const lines = regressionOf(d);
    return { ...d, style: { ...d.style, color, regressionLines: { base: { ...lines.base, color }, up: { ...lines.up, color }, down: { ...lines.down, color } } } };
  }
  return { ...d, style: { ...d.style, color } };
}
/** The colour shown on the edit bar's swatch: the first visible level, the regression channel, or the drawing colour. */
export function colorOf(d: Drawing): string {
  if (LEVEL_KINDS.has(d.kind) && d.kind !== 'pitchfork') return levelsOf(d).find(level => level.visible)?.color ?? d.style.color;
  if (d.kind === 'regression-trend') return regressionOf(d).up.color;
  return d.style.color;
}
export function setWidth(d: Drawing, width: number): Drawing {
  if (d.kind === 'parallel-channel') return { ...d, style: { ...d.style, width, levels: levelsOf(d).map(level => isBorder(level) ? { ...level, width } : level) } };
  if (d.kind === 'regression-trend') { const lines = regressionOf(d); return { ...d, style: { ...d.style, width, regressionLines: { ...lines, up: { ...lines.up, width }, down: { ...lines.down, width } } } }; }
  return { ...d, style: { ...d.style, width } };
}
export function setLineStyle(d: Drawing, lineStyle: DrawingStyle['lineStyle']): Drawing {
  if (d.kind === 'parallel-channel') return { ...d, style: { ...d.style, lineStyle, levels: levelsOf(d).map(level => isBorder(level) ? { ...level, style: lineStyle } : level) } };
  if (d.kind === 'regression-trend') { const lines = regressionOf(d); return { ...d, style: { ...d.style, lineStyle, regressionLines: { ...lines, up: { ...lines.up, style: lineStyle }, down: { ...lines.down, style: lineStyle } } } }; }
  return { ...d, style: { ...d.style, lineStyle } };
}
export function widthOf(d: Drawing): number {
  if (d.kind === 'parallel-channel') return levelsOf(d).find(isBorder)?.width ?? d.style.width;
  if (d.kind === 'regression-trend') return regressionOf(d).up.width;
  return d.style.width;
}
export function lineStyleOf(d: Drawing): DrawingStyle['lineStyle'] {
  if (d.kind === 'parallel-channel') return levelsOf(d).find(isBorder)?.style ?? d.style.lineStyle;
  if (d.kind === 'regression-trend') return regressionOf(d).up.style;
  return d.style.lineStyle;
}
export { regressionOf };

// "Set as default": new drawings of a kind start from the user's saved style (TradingView's default template).
const DEFAULTS_KEY = 'open-alert-draw-defaults';
function readDefaults(): Record<string, DrawingStyle> {
  try { const saved = JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? '{}') as unknown; return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, DrawingStyle> : {}; }
  catch { return {}; }
}
let defaults = readDefaults();
// The library merges this over its factory style for every new drawing (and the placement preview).
setDefaultStyleOverride(kind => defaults[kind] && typeof defaults[kind] === 'object' ? structuredClone(defaults[kind]) : undefined);
export function saveDefaultStyle(kind: DrawingKind, style: DrawingStyle) {
  defaults = { ...defaults, [kind]: structuredClone(style) };
  try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults)); } catch { /* keep for this session */ }
}
