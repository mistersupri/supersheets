/**
 * Password strength for the sign-up form. It is advice for the person typing, not
 * a gate: the server only requires 8 characters. Everything runs in the browser
 * and the password is never sent anywhere for checking.
 */
export interface PasswordCheck {
  /** 0 (empty) to 4. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  rules: { id: string; label: string; ok: boolean }[];
  /** One sentence on the most useful next step. */
  tip: string;
}

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', 'iloveyou', 'admin123', 'letmein123',
  'welcome123', 'katasandi', 'kata sandi', 'rahasia123', 'indonesia', 'indonesia123', 'sayangku', 'bismillah', 'passw0rd', 'abc12345', '11111111', '00000000',
]);

const LABELS = ['Belum diisi', 'Sangat lemah', 'Lemah', 'Cukup kuat', 'Kuat'] as const;

function hasSequence(p: string): boolean {
  const s = p.toLowerCase();
  for (let i = 0; i + 3 < s.length; i++) {
    const a = s.charCodeAt(i);
    const run = [1, 2, 3].every((k) => s.charCodeAt(i + k) === a + k) || [1, 2, 3].every((k) => s.charCodeAt(i + k) === a - k);
    if (run) return true;
  }
  return /(.)\1{3,}/.test(s);
}

export function checkPassword(password: string, hints: string[] = []): PasswordCheck {
  const rules = [
    { id: 'len', label: 'Minimal 8 karakter', ok: password.length >= 8 },
    { id: 'case', label: 'Huruf besar dan huruf kecil', ok: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { id: 'num', label: 'Ada angka', ok: /\d/.test(password) },
    { id: 'sym', label: 'Ada simbol (misalnya ! @ # ?)', ok: /[^A-Za-z0-9]/.test(password) },
  ];
  if (!password) return { score: 0, label: LABELS[0], rules, tip: 'Gunakan frasa yang panjang dan unik. Panjang lebih penting daripada simbol.' };

  const lower = password.toLowerCase();
  const personal = hints
    .flatMap((h) => h.toLowerCase().split(/[\s@._-]+/))
    .filter((w) => w.length >= 4)
    .some((w) => lower.includes(w));
  const weak = COMMON.has(lower) || hasSequence(password) || personal;

  let points = 0;
  if (password.length >= 8) points++;
  if (password.length >= 12) points++;
  if (password.length >= 16) points++;
  points += rules.filter((r) => r.id !== 'len' && r.ok).length >= 2 ? 1 : 0;
  points += rules.filter((r) => r.id !== 'len' && r.ok).length >= 3 ? 1 : 0;
  if (password.length < 8) points = Math.min(points, 1);
  if (weak) points = Math.min(points, 1);

  const score = (points <= 1 ? (password.length < 6 || weak ? 1 : 2) : points === 2 ? 2 : points === 3 ? 3 : 4) as 1 | 2 | 3 | 4;
  rules.push({ id: 'guess', label: 'Tidak mudah ditebak (bukan urutan, kata umum, atau data diri)', ok: !weak });

  let tip = 'Kata sandi ini sudah baik. Jangan pakai ulang di layanan lain.';
  if (password.length < 8) tip = `Tambah ${8 - password.length} karakter lagi.`;
  else if (weak) tip = personal ? 'Hindari memakai nama atau email Anda.' : 'Hindari urutan seperti 1234 atau kata yang umum dipakai.';
  else if (password.length < 12) tip = 'Perpanjang menjadi 12 karakter atau lebih, misalnya dengan beberapa kata acak.';
  else if (score < 4) tip = 'Campurkan huruf besar, angka, atau simbol agar lebih sulit ditebak.';

  return { score, label: LABELS[score], rules, tip };
}
