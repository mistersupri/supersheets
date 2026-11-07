import type { SVGProps } from 'react';

/**
 * A small custom icon set drawn on a 16px grid with 1.5px square-capped strokes,
 * echoing ruled ledger lines. Each glyph maps to one spreadsheet action, so we
 * draw only what the product needs instead of shipping a generic icon library.
 */
type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Undo: (p: P) => (
    <Svg {...p}>
      <path d="M5 3.5 2.5 6 5 8.5" />
      <path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H7" />
    </Svg>
  ),
  Redo: (p: P) => (
    <Svg {...p}>
      <path d="M11 3.5 13.5 6 11 8.5" />
      <path d="M13 6H6.5a3.5 3.5 0 0 0 0 7H9" />
    </Svg>
  ),
  AlignLeft: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7" />
    </Svg>
  ),
  AlignCenter: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7" />
    </Svg>
  ),
  AlignRight: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7" />
    </Svg>
  ),
  VTop: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 2.5h11M8 5v8.5M5.5 7.5 8 5l2.5 2.5" />
    </Svg>
  ),
  VMiddle: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 8h11M8 1.5v3.5M8 11v3.5M6 3.5 8 5.5l2-2M6 12.5l2-2 2 2" />
    </Svg>
  ),
  VBottom: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 13.5h11M8 2.5V11M5.5 8.5 8 11l2.5-2.5" />
    </Svg>
  ),
  Wrap: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5h11M2.5 7.5h9a2 2 0 0 1 0 4H8.5M10 10l-1.5 1.5L10 13M2.5 11.5h3" />
    </Svg>
  ),
  Rotate: (p: P) => (
    <Svg {...p}>
      <path d="M3 13 12.5 3.5M8.5 3.5h4v4" />
    </Svg>
  ),
  Borders: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 2.5h11v11h-11zM8 2.5v11M2.5 8h11" />
    </Svg>
  ),
  Merge: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5v9M13.5 3.5v9M4.5 8h2.5M9 8h2.5M5.5 6.5 7 8 5.5 9.5M10.5 6.5 9 8l1.5 1.5" />
    </Svg>
  ),
  Fill: (p: P) => (
    <Svg {...p}>
      <path d="m7 2.5 5 5-4.5 4.5-5-5zM3 7.5h9M13 10.5c0 1-.5 2-1 2s-1-1-1-2l1-1.5z" />
    </Svg>
  ),
  TextColor: (p: P) => (
    <Svg {...p}>
      <path d="m4.5 11 3.5-8.5 3.5 8.5M5.7 8h4.6" />
    </Svg>
  ),
  Filter: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5h11L9.5 8.5v4l-3 1.5v-5.5z" />
    </Svg>
  ),
  SortAsc: (p: P) => (
    <Svg {...p}>
      <path d="M4.5 2.5v11M2.5 11.5l2 2 2-2M9 4.5h2.5M9 8h3.5M9 11.5h4.5" />
    </Svg>
  ),
  SortDesc: (p: P) => (
    <Svg {...p}>
      <path d="M4.5 2.5v11M2.5 11.5l2 2 2-2M9 4.5h4.5M9 8h3.5M9 11.5h2.5" />
    </Svg>
  ),
  Comment: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3h11v8H7l-3 2.5V11H2.5z" />
    </Svg>
  ),
  History: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3.5l2.5 1.5" />
    </Svg>
  ),
  Share: (p: P) => (
    <Svg {...p}>
      <path d="M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4M12.5 5v5M10 7.5h5" />
    </Svg>
  ),
  Search: (p: P) => (
    <Svg {...p}>
      <path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.5 10.5l3 3" />
    </Svg>
  ),
  Plus: (p: P) => (
    <Svg {...p}>
      <path d="M8 2.5v11M2.5 8h11" />
    </Svg>
  ),
  Minus: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 8h11" />
    </Svg>
  ),
  ChevronDown: (p: P) => (
    <Svg {...p}>
      <path d="m4 6 4 4 4-4" />
    </Svg>
  ),
  ChevronRight: (p: P) => (
    <Svg {...p}>
      <path d="m6 4 4 4-4 4" />
    </Svg>
  ),
  ChevronLeft: (p: P) => (
    <Svg {...p}>
      <path d="m10 4-4 4 4 4" />
    </Svg>
  ),
  Close: (p: P) => (
    <Svg {...p}>
      <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
    </Svg>
  ),
  Menu: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </Svg>
  ),
  More: (p: P) => (
    <Svg {...p} strokeWidth={2.25}>
      <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
    </Svg>
  ),
  Star: (p: P & { filled?: boolean }) => {
    const { filled, ...rest } = p;
    return (
      <Svg {...rest} fill={filled ? 'currentColor' : 'none'} strokeLinejoin="round">
        <path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" />
      </Svg>
    );
  },
  Trash: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v4.5M9.5 6.5v4.5" />
    </Svg>
  ),
  Folder: (p: P) => (
    <Svg {...p}>
      <path d="M2 3.5h4.5l1.5 1.5H14v8H2z" />
    </Svg>
  ),
  GridView: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9H7v4.5H2.5zM9 9h4.5v4.5H9z" />
    </Svg>
  ),
  ListView: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11" />
    </Svg>
  ),
  Sun: (p: P) => (
    <Svg {...p}>
      <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
    </Svg>
  ),
  Moon: (p: P) => (
    <Svg {...p}>
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />
    </Svg>
  ),
  Sheet: (p: P) => (
    <Svg {...p}>
      <path d="M3 1.5h7l3 3v10H3zM5.5 7.5h5M5.5 10h5M5.5 12.5h5M8 7.5v5" />
    </Svg>
  ),
  Upload: (p: P) => (
    <Svg {...p}>
      <path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10.5v3h11v-3" />
    </Svg>
  ),
  Download: (p: P) => (
    <Svg {...p}>
      <path d="M8 2.5v8M5 7.5l3 3 3-3M2.5 10.5v3h11v-3" />
    </Svg>
  ),
  Check: (p: P) => (
    <Svg {...p}>
      <path d="m3 8.5 3 3 7-7" />
    </Svg>
  ),
  Warning: (p: P) => (
    <Svg {...p} strokeLinejoin="round">
      <path d="M8 2 1.5 13.5h13zM8 6.5v3.5M8 12h.01" />
    </Svg>
  ),
  Lock: (p: P) => (
    <Svg {...p}>
      <path d="M3.5 7h9v6.5h-9zM5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  ),
  Link: (p: P) => (
    <Svg {...p}>
      <path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" />
    </Svg>
  ),
  Cloud: (p: P) => (
    <Svg {...p} strokeLinejoin="round">
      <path d="M4.5 12.5a3 3 0 0 1-.3-6A4 4 0 0 1 12 6a3.2 3.2 0 0 1 0 6.5z" />
    </Svg>
  ),
  CloudOff: (p: P) => (
    <Svg {...p} strokeLinejoin="round">
      <path d="M4.5 12.5a3 3 0 0 1-.3-6M7 3.6A4 4 0 0 1 12 6a3.2 3.2 0 0 1 1.3 6.1M2 2l12 12" />
    </Svg>
  ),
  Paint: (p: P) => (
    <Svg {...p}>
      <path d="M3 2.5h9v4H3zM12 4.5h1.5v3.5H8v2M7 10h2v4H7z" />
    </Svg>
  ),
  ClearFormat: (p: P) => (
    <Svg {...p}>
      <path d="M3.5 3h9M8 3l-2.5 10M10 9l4 4M14 9l-4 4" />
    </Svg>
  ),
  Settings: (p: P) => (
    <Svg {...p}>
      <path d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </Svg>
  ),
  Users: (p: P) => (
    <Svg {...p}>
      <path d="M5.5 7a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM1.5 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5M10.5 2.6a2.25 2.25 0 0 1 0 4.3M11.5 9.6c1.6.3 2.7 1.5 3 3.4" />
    </Svg>
  ),
  LogOut: (p: P) => (
    <Svg {...p}>
      <path d="M6.5 2.5h-4v11h4M10 5l3 3-3 3M13 8H6" />
    </Svg>
  ),
  EyeOff: (p: P) => (
    <Svg {...p}>
      <path d="M2 2l12 12M6.5 4a6.5 6.5 0 0 1 7.5 4 7 7 0 0 1-1.6 2.3M9.9 11.6A6.5 6.5 0 0 1 2 8a7 7 0 0 1 2-2.8M6.7 6.7a1.8 1.8 0 0 0 2.6 2.6" />
    </Svg>
  ),
  Freeze: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 2.5h11v11h-11zM2.5 6h11M6 2.5v11" />
    </Svg>
  ),
  Palette: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9H7v4.5H2.5z" />
    </Svg>
  ),
  Copy: (p: P) => (
    <Svg {...p}>
      <path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3" />
    </Svg>
  ),
  Pencil: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 13.5 3 11l8-8 2 2-8 8zM9.5 4.5l2 2" />
    </Svg>
  ),
  Open: (p: P) => (
    <Svg {...p}>
      <path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v4h-9v-9h4" />
    </Svg>
  ),
  Restore: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5" />
    </Svg>
  ),
};

export type IconName = keyof typeof Icon;
