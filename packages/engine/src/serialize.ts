import { colToLetters, quoteSheetName } from './address';
import { Node, RefPart } from './parser';

function refText(r: RefPart): string {
  return `${r.colAbs ? '$' : ''}${colToLetters(r.col)}${r.rowAbs ? '$' : ''}${r.row + 1}`;
}

function sheetPrefix(sheet?: string): string {
  return sheet === undefined ? '' : `${quoteSheetName(sheet)}!`;
}

function numText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(n);
}

const PREC: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
};

/** Turns an AST back into formula text (without the leading "="). */
export function serialize(node: Node): string {
  switch (node.type) {
    case 'num':
      return numText(node.value);
    case 'str':
      return `"${node.value.replace(/"/g, '""')}"`;
    case 'bool':
      return node.value ? 'TRUE' : 'FALSE';
    case 'err':
      return node.code;
    case 'name':
      return node.name;
    case 'ref':
      return sheetPrefix(node.sheet) + refText(node.ref);
    case 'range': {
      const p = sheetPrefix(node.sheet);
      if (node.kind === 'cols') {
        return `${p}${node.start.colAbs ? '$' : ''}${colToLetters(node.start.col)}:${node.end.colAbs ? '$' : ''}${colToLetters(node.end.col)}`;
      }
      if (node.kind === 'rows') {
        return `${p}${node.start.rowAbs ? '$' : ''}${node.start.row + 1}:${node.end.rowAbs ? '$' : ''}${node.end.row + 1}`;
      }
      return `${p}${refText(node.start)}:${refText(node.end)}`;
    }
    case 'func':
      return `${node.name}(${node.args.map(serialize).join(',')})`;
    case 'unary':
      return `${node.op}${serialize(node.arg)}`;
    case 'percent':
      return `${serialize(node.arg)}%`;
    case 'paren':
      return `(${serialize(node.inner)})`;
    case 'binary': {
      const p = PREC[node.op];
      const wrap = (n: Node, right: boolean) => {
        if (n.type === 'binary') {
          const q = PREC[n.op];
          if (q < p || (right && q === p)) return `(${serialize(n)})`;
        }
        return serialize(n);
      };
      return `${wrap(node.left, false)}${node.op}${wrap(node.right, true)}`;
    }
  }
}
