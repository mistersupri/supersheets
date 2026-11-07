/**
 * Document colours are user data (PRD 4.3: "mengganti ikon atau warna dokumen"),
 * used only to tint the sheet glyph next to a title. Each keeps at least 3:1
 * against both light and dark surfaces.
 */
export const DOC_COLORS = [
  { id: 'green', label: 'Hijau', hex: '#2E8B57' },
  { id: 'teal', label: 'Toska', hex: '#13858F' },
  { id: 'blue', label: 'Biru', hex: '#3B73C4' },
  { id: 'plum', label: 'Ungu', hex: '#8E5BB5' },
  { id: 'rust', label: 'Bata', hex: '#C2582B' },
  { id: 'amber', label: 'Kuning tua', hex: '#B07A12' },
  { id: 'slate', label: 'Abu', hex: '#6E7B86' },
];

export function docColor(id: string): string {
  return DOC_COLORS.find((c) => c.id === id)?.hex ?? DOC_COLORS[0].hex;
}
