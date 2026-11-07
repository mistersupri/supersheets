# OpenSheet

Aplikasi spreadsheet berbasis web dengan database sendiri (PostgreSQL), sesuai PRD *OpenSheet v1.0*. Mendukung banyak pengguna, formula, format sel, kolaborasi real-time, berbagi dengan hak akses, riwayat versi, serta impor/ekspor XLSX, CSV, TSV dan PDF.

## Menjalankan

### Docker (paling cepat)

```bash
docker compose up --build
```

Buka `http://localhost:3000`. Akun pertama yang mendaftar otomatis menjadi **Super Admin**.

### Pengembangan lokal

Prasyarat: Node.js 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env      # sesuaikan DATABASE_URL
cd apps/server && npx prisma migrate deploy && npx prisma generate && cd ../..
pnpm --filter @opensheet/server dev               # API + WebSocket di :3000
pnpm --filter @opensheet/web dev                  # Web di :5173 (proxy ke :3000)
```

Tanpa `SMTP_URL`, email (atur ulang kata sandi, undangan) dicetak ke log server.

### Pengujian

```bash
pnpm --filter @opensheet/engine test   # 27 test formula engine
pnpm --filter @opensheet/server test   # 25 test API terhadap PostgreSQL (database *_test)
pnpm typecheck
```

Test server membutuhkan database `opensheet_test` (atau `TEST_DATABASE_URL` yang namanya berakhiran `_test`); setup test mengosongkan skema database itu, dan menolak database lain.

## Arsitektur

```
packages/engine   Formula engine murni TypeScript: parser, evaluator, dependency graph,
                  format angka/tanggal, translasi referensi. Tanpa React, tanpa eval().
apps/server       Express 5 + Prisma 7 (PostgreSQL) + Socket.IO. REST API sesuai PRD bab 8.
apps/web          React 19 + Vite + Tailwind 4 + Base UI + TanStack Query + Zustand.
```

Keputusan teknis PRD bab 14 yang dipertahankan:

| Keputusan | Implementasi |
|---|---|
| Sparse cell storage | Hanya sel berisi nilai/format disimpan; sel yang dikosongkan dihapus (`services/cells.ts`). |
| Batch operations | Klien mengumpulkan perubahan 700 ms lalu mengirim satu batch; server menulis dengan `INSERT ... ON CONFLICT` per 500 baris. |
| Formula engine terpisah | `packages/engine`, dipakai klien (kalkulasi langsung) dan server (impor, ekspor, pemulihan versi). |
| Virtualized rendering | Grid digambar di `<canvas>` hanya untuk sel yang terlihat; editor, dropdown dan popover memakai DOM overlay. |
| Revision-based sync | Setiap batch membawa `baseRevision`; server menolak (409) bila sel yang sama diubah klien lain sejak revisi itu. |
| Database independence | Semua data di PostgreSQL. |

Riwayat versi memakai **snapshot** (revisi 0 dan setiap 100 revisi) ditambah **perubahan inkremental** per batch (nilai sebelum/sesudah per sel). Pemulihan versi = snapshot terdekat + perubahan hingga revisi tujuan, lalu diterapkan sebagai revisi baru.

## Cakupan terhadap PRD

**Sudah berjalan** (diverifikasi lewat test API, test engine, dan click-through browser):

- Auth: daftar (bisa dimatikan admin), masuk, keluar, ingat saya, lupa/atur ulang kata sandi, sesi di cookie HttpOnly + SameSite, kunci akun setelah 5 kali gagal + rate limit, kelola sesi aktif.
- Peran aplikasi (Super Admin/Pengguna) terpisah dari peran workbook (Pemilik, Editor + kelola akses, Editor, Komentator, Pembaca). Super Admin tidak otomatis bisa membuka isi workbook orang lain.
- Dasbor: terakhir dibuka, milik saya, dibagikan, berbintang, sampah, folder, pencarian, filter pemilik/tanggal, tampilan daftar/kisi, warna dokumen, ganti nama, salin, pindah folder, pulihkan, hapus permanen.
- Editor: header kolom/baris, seleksi sel/rentang/baris/kolom, drag selection, fill handle (deret angka dan formula relatif), scroll virtual, freeze, sembunyikan/tampilkan, ubah ukuran (drag + autofit), keyboard (Enter, Tab, panah, Ctrl+panah, F2, Delete, dsb.), salin/potong/tempel (termasuk dari Excel/Sheets), tempel nilai/format saja, undo/redo, formula bar dengan autocomplete dan petunjuk argumen, kotak nama, menu konteks, menu File sampai Bantuan.
- Format: jenis/ukuran huruf, tebal, miring, garis bawah, coret, warna, perataan horizontal/vertikal, bungkus teks, rotasi, indentasi, warna isian, batas (gaya dan warna), format angka (otomatis, angka, Rupiah, persen, tanggal, waktu, kustom), gabung/pisah sel, format bersyarat, validasi data, dropdown, kotak centang.
- Formula MVP lengkap (SUM ... ISTEXT) plus ROUNDUP, ROUNDDOWN, INT, MOD, POWER, SQRT, MEDIAN, COUNTBLANK, IFNA, COUNTIFS, SUMIFS, UPPER, LOWER, TEXT, TEXTJOIN, REGEXMATCH, REGEXEXTRACT, XLOOKUP, ISERROR. Referensi relatif/absolut/campuran, rentang, rentang kolom/baris penuh, antar-sheet, dependency tracking, deteksi referensi melingkar, error #REF! #DIV/0! #VALUE! #NAME? #N/A #NUM! #CYCLE!.
- Data: urutkan, filter (nilai, kondisi, warna), tampilan filter, hapus duplikat, cari dan ganti (semua sheet, regex, di dalam formula), pisahkan teks ke kolom, rentang/sheet dilindungi (ditegakkan di server).
- Kolaborasi: presence, kursor/seleksi pengguna lain dengan warna, pembaruan real-time, info terakhir diubah per sel, autosave dengan status Menyimpan/Tersimpan/Offline/Gagal menyimpan/Konflik terdeteksi, rollback bila server menolak.
- Berbagi: undang lewat email (pengguna baru menerima undangan saat mendaftar), ubah/cabut akses (berlaku langsung pada sesi terbuka), akses lewat tautan (dapat dimatikan admin).
- Riwayat versi, komentar dengan balasan dan status selesai, log audit, panel admin.
- Impor XLSX (nilai, formula, format dasar, sel gabungan, lebar kolom, tinggi baris, freeze), CSV, TSV; ekspor XLSX, CSV, TSV, PDF.
- Responsif: tata letak ponsel dengan panel edit khusus, panel format, menu ringkas, dan pemilih sheet ringkas. Tema terang/gelap.

**Belum atau sebagian** (jujur, agar tidak dianggap selesai):

- Formula lanjutan berbasis array (FILTER, SORT, UNIQUE, QUERY, ARRAYFORMULA, SEQUENCE) dan IMPORTRANGE belum ada karena butuh hasil "spill".
- ODS belum didukung (PRD: pengembangan).
- Penyorotan sintaks di formula bar belum; referensi yang sedang diketik sudah disorot berwarna di grid.
- "Siapa pun dengan tautan" tetap mewajibkan login.
- Redis dan penyimpanan S3 tidak dipakai: berkas unggahan diproses di memori dan tidak disimpan (hanya metadatanya di `file_attachments`).
- Sisip/hapus baris/kolom menulis ulang sel yang bergeser sebagai batch biasa, dibatasi 50.000 sel per langkah.
- Tinggi baris tidak menyesuaikan otomatis untuk teks terbungkus.
- Target performa bab 10 belum dibenchmark dengan dataset nyata.

## Keamanan (PRD bab 9)

Argon2id untuk kata sandi; cookie sesi HttpOnly, SameSite=Lax, Secure di produksi; header CSRF wajib + pengecekan Origin untuk request yang mengubah data; Helmet + CSP; rate limit API dan login; validasi input dengan Zod; Prisma/parameterized SQL; validasi akses workbook di setiap endpoint dan koneksi WebSocket; perlindungan rentang di server; batas ukuran dan pengecekan tipe berkas unggahan; formula tidak pernah memakai `eval()`/`Function()` (dicek oleh test). HTTPS dan backup database diatur di sisi deployment (reverse proxy dan `pg_dump` terjadwal).
