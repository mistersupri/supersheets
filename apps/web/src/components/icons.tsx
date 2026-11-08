import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownAZ,
  ArrowDownZA,
  Baseline,
  Calculator,
  ChartArea,
  ChartBar,
  ChartColumn,
  ChartLine,
  ChartPie,
  ChartScatter,
  LockOpen,
  Pipette,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cloud,
  CloudOff,
  Columns3,
  Copy,
  Download,
  Ellipsis,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Filter,
  Folder,
  FolderInput,
  Grid2x2,
  History,
  LayoutGrid,
  Link,
  List,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Minus,
  Moon,
  PaintBucket,
  Palette,
  Pencil,
  Pin,
  Plus,
  RemoveFormatting,
  Rows3,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  SquareDashedMousePointer,
  ClipboardPaste,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Star,
  Sun,
  TableCellsMerge,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  UserPlus,
  Users,
  WrapText,
  X,
  type LucideProps,
} from 'lucide-react';

/**
 * Icons come from lucide, as requested for the product. Each name maps to one
 * spreadsheet action, so call sites read as `Icon.Merge`, not as a library glyph.
 */
type P = Omit<LucideProps, 'ref'> & { size?: number };

const wrap =
  (C: React.ComponentType<LucideProps>) =>
  ({ size = 16, strokeWidth = 1.75, ...rest }: P) => <C size={size} strokeWidth={strokeWidth} aria-hidden="true" focusable="false" {...rest} />;

export const Icon = {
  Undo: wrap(Undo2),
  Redo: wrap(Redo2),
  AlignLeft: wrap(AlignLeft),
  AlignCenter: wrap(AlignCenter),
  AlignRight: wrap(AlignRight),
  VTop: wrap(AlignVerticalJustifyStart),
  VMiddle: wrap(AlignVerticalJustifyCenter),
  VBottom: wrap(AlignVerticalJustifyEnd),
  Wrap: wrap(WrapText),
  Rotate: wrap(RotateCw),
  Borders: wrap(Grid2x2),
  Merge: wrap(TableCellsMerge),
  Fill: wrap(PaintBucket),
  TextColor: wrap(Baseline),
  Filter: wrap(Filter),
  SortAsc: wrap(ArrowDownAZ),
  SortDesc: wrap(ArrowDownZA),
  Comment: wrap(MessageSquare),
  History: wrap(History),
  Share: wrap(UserPlus),
  ShareLink: wrap(Share2),
  Search: wrap(Search),
  Plus: wrap(Plus),
  Minus: wrap(Minus),
  ChevronDown: wrap(ChevronDown),
  ChevronRight: wrap(ChevronRight),
  ChevronLeft: wrap(ChevronLeft),
  Close: wrap(X),
  Menu: wrap(Menu),
  More: wrap(Ellipsis),
  Star: ({ filled, ...p }: P & { filled?: boolean }) => wrap(Star)({ ...p, fill: filled ? 'currentColor' : 'none' }),
  Trash: wrap(Trash2),
  Folder: wrap(Folder),
  MoveFolder: wrap(FolderInput),
  GridView: wrap(LayoutGrid),
  ListView: wrap(List),
  Sun: wrap(Sun),
  Moon: wrap(Moon),
  Sheet: wrap(FileSpreadsheet),
  Upload: wrap(Upload),
  Download: wrap(Download),
  Check: wrap(Check),
  Warning: wrap(TriangleAlert),
  Lock: wrap(Lock),
  Link: wrap(Link),
  Cloud: wrap(Cloud),
  CloudOff: wrap(CloudOff),
  Paint: wrap(Palette),
  ClearFormat: wrap(RemoveFormatting),
  Settings: wrap(Settings),
  Users: wrap(Users),
  LogOut: wrap(LogOut),
  Eye: wrap(Eye),
  EyeOff: wrap(EyeOff),
  Freeze: wrap(Pin),
  Palette: wrap(Palette),
  Copy: wrap(Copy),
  Pencil: wrap(Pencil),
  Open: wrap(ExternalLink),
  Restore: wrap(RotateCcw),
  Recent: wrap(Clock),
  Cut: wrap(Scissors),
  Paste: wrap(ClipboardPaste),
  Eraser: wrap(Eraser),
  Calc: wrap(Calculator),
  Rows: wrap(Rows3),
  Cols: wrap(Columns3),
  Shield: wrap(ShieldCheck),
  Pipette: wrap(Pipette),
  PickRange: wrap(SquareDashedMousePointer),
  Unlock: wrap(LockOpen),
  ChartColumn: wrap(ChartColumn),
  ChartBar: wrap(ChartBar),
  ChartLine: wrap(ChartLine),
  ChartPie: wrap(ChartPie),
  ChartArea: wrap(ChartArea),
  ChartScatter: wrap(ChartScatter),
};

export type IconName = keyof typeof Icon;

export type BorderKind = 'all' | 'outer' | 'inner' | 'top' | 'bottom' | 'left' | 'right' | 'none';

/**
 * Border menu glyphs. lucide has no per-side border icons, so these are drawn on the same
 * 16px grid and stroke: faint lines are the cell grid, bold lines are the edges the action sets.
 */
export function BorderGlyph({ kind, size = 16 }: { kind: BorderKind; size?: number }) {
  const on = (side: 'top' | 'bottom' | 'left' | 'right' | 'cross') => {
    if (kind === 'all') return true;
    if (kind === 'outer') return side !== 'cross';
    if (kind === 'inner') return side === 'cross';
    return kind === side;
  };
  const line = (d: string, bold: boolean) => <path d={d} strokeWidth={bold ? 2 : 1} opacity={bold ? 1 : 0.28} strokeDasharray={bold ? undefined : '1.5 1.5'} />;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="square" aria-hidden="true" focusable="false">
      {line('M2 2.5h12', on('top'))}
      {line('M2 13.5h12', on('bottom'))}
      {line('M2.5 2v12', on('left'))}
      {line('M13.5 2v12', on('right'))}
      {line('M8 3v10M3 8h10', on('cross'))}
    </svg>
  );
}
