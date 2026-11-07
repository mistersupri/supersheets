export type ErrorCode = '#REF!' | '#DIV/0!' | '#VALUE!' | '#NAME?' | '#N/A' | '#NUM!' | '#CYCLE!' | '#ERROR!';

export const ERROR_CODES: ErrorCode[] = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NUM!', '#CYCLE!', '#ERROR!'];

export class FormulaError {
  readonly code: ErrorCode;
  readonly message?: string;
  constructor(code: ErrorCode, message?: string) {
    this.code = code;
    this.message = message;
  }
  toString(): string {
    return this.code;
  }
}

/** A scalar value a cell can hold after evaluation. `null` means empty. */
export type Scalar = number | string | boolean | null | FormulaError;

export function isError(v: unknown): v is FormulaError {
  return v instanceof FormulaError;
}

export const err = {
  ref: (m?: string) => new FormulaError('#REF!', m),
  div0: (m?: string) => new FormulaError('#DIV/0!', m),
  value: (m?: string) => new FormulaError('#VALUE!', m),
  name: (m?: string) => new FormulaError('#NAME?', m),
  na: (m?: string) => new FormulaError('#N/A', m),
  num: (m?: string) => new FormulaError('#NUM!', m),
  cycle: (m?: string) => new FormulaError('#CYCLE!', m),
  parse: (m?: string) => new FormulaError('#ERROR!', m),
};

/** Serialisable form for storage and transport. */
export type StoredValue = number | string | boolean | null | { error: ErrorCode };

export function toStored(v: Scalar): StoredValue {
  if (v instanceof FormulaError) return { error: v.code };
  return v;
}

export function fromStored(v: StoredValue | undefined): Scalar {
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object' && 'error' in v) return new FormulaError(v.error);
  return v as Scalar;
}

export function valueType(v: Scalar): 'empty' | 'number' | 'string' | 'boolean' | 'error' {
  if (v === null) return 'empty';
  if (v instanceof FormulaError) return 'error';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}
