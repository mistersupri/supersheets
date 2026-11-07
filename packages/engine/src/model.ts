import type { StoredValue } from './values';

/** Shared data model between the web client and the server. */

export type BorderStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';

export interface BorderSide {
  style: BorderStyle;
  color: string;
}

export interface CellStyle {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  textColor?: string;
  backgroundColor?: string;
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  rotation?: number;
  indent?: number;
  numberFormat?: string;
  borders?: { top?: BorderSide; right?: BorderSide; bottom?: BorderSide; left?: BorderSide };
  link?: string;
}

const STYLE_KEYS: (keyof CellStyle)[] = [
  'fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strike', 'textColor', 'backgroundColor',
  'hAlign', 'vAlign', 'wrap', 'rotation', 'indent', 'numberFormat', 'borders', 'link',
];

/** Drops default/empty values so equal styles compare (and hash) equal. */
export function normalizeStyle(s: CellStyle | null | undefined): CellStyle | null {
  if (!s) return null;
  const out: CellStyle = {};
  for (const k of STYLE_KEYS) {
    const v = s[k];
    if (v === undefined || v === null || v === false || v === '' || (k === 'rotation' && v === 0) || (k === 'indent' && v === 0)) continue;
    if (k === 'numberFormat' && v === 'auto') continue;
    if (k === 'borders') {
      const b = v as NonNullable<CellStyle['borders']>;
      const nb: NonNullable<CellStyle['borders']> = {};
      for (const side of ['top', 'right', 'bottom', 'left'] as const) if (b[side]) nb[side] = { style: b[side]!.style, color: b[side]!.color };
      if (Object.keys(nb).length) out.borders = nb;
      continue;
    }
    (out as Record<string, unknown>)[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function styleKey(s: CellStyle | null): string {
  return s ? JSON.stringify(s) : '';
}

/** A cell as transported between client and server. */
export interface CellData {
  row: number;
  col: number;
  raw: string;
  value?: StoredValue;
  style?: CellStyle | null;
  updatedBy?: string | null;
  updatedAt?: string;
}

/** One cell write in a batch. Omitted fields are left unchanged. */
export interface CellOp {
  sheetId: string;
  row: number;
  col: number;
  raw?: string;
  value?: StoredValue;
  style?: CellStyle | null;
}

export interface Merge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export type FilterCriterion =
  | { kind: 'values'; hidden: string[] }
  | { kind: 'condition'; op: ConditionOp; value?: string; value2?: string }
  | { kind: 'color'; color: string };

export interface SheetFilter {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  criteria: Record<number, FilterCriterion>;
}

export interface FilterView {
  id: string;
  name: string;
  filter: SheetFilter;
}

export interface SheetMetadata {
  colWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
  hiddenRows?: number[];
  hiddenCols?: number[];
  merges?: Merge[];
  filter?: SheetFilter | null;
  filterViews?: FilterView[];
  showGridlines?: boolean;
  tabColor?: string | null;
}

export type ConditionOp =
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between'
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith'
  | 'empty' | 'notEmpty' | 'formula';

export interface ConditionalRule {
  op: ConditionOp;
  value?: string;
  value2?: string;
  style: Pick<CellStyle, 'backgroundColor' | 'textColor' | 'bold' | 'italic' | 'strike'>;
}

export type ValidationRule =
  | { kind: 'list'; items: string[]; strict: boolean; showDropdown: boolean }
  | { kind: 'number'; op: 'between' | 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; min?: number; max?: number; strict: boolean }
  | { kind: 'textLength'; max: number; strict: boolean }
  | { kind: 'checkbox' };

export interface RuleRecord<T> {
  id: string;
  range: string;
  rule: T;
}

export interface ProtectedRangeRecord {
  id: string;
  range: string | null;
  description?: string | null;
  editorIds: string[];
}

export interface PresenceUser {
  userId: string;
  socketId: string;
  name: string;
  color: string;
  sheetId?: string;
  selection?: { r1: number; c1: number; r2: number; c2: number };
}
