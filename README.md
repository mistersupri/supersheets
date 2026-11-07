# OpenSheet

Aplikasi spreadsheet berbasis web dengan database sendiri (PostgreSQL), sesuai PRD *OpenSheet v1.0*. Mendukung banyak pengguna, formula (termasuk formula array), format sel, kolaborasi real-time, berbagi dengan hak akses, riwayat versi, serta impor/ekspor XLSX, ODS, CSV, TSV dan PDF.

## Menjalankan

### Docker

```bash
docker compose up --build
```

Buka `http://localhost:3000`. Akun pertama yang mendaftar otomatis menjadi **Super Admin**. Compose menjalankan PostgreSQL, Redis, dan aplikasi dengan 2 proses worker (`WORKERS`); naikkan sesuai jumlah core CPU server.

### Pengembangan lokal

Prasyarat: Node.js 22, pnpm 10, PostgreSQL 16 (Redis opsional).

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
pnpm --filter @opensheet/engine test    # 43 test formula engine (termasuk formula array dan spill)
pnpm --filter @opensheet/server test    # 35 test API terhadap PostgreSQL, SMTP lokal dan penyimpanan berkas
pnpm --filter @opensheet/engine bench   # benchmark engine terhadap target bab 10
pnpm typecheck
```

Test server membutuhkan database `opensheet_test` (atau `TEST_DATABASE_URL` yang namanya berakhiran `_test`); setup test mengosongkan skema database itu dan menolak database lain.

## Kapasitas: 500 pengguna bersamaan

Uji beban (`apps/server/loadtest`) mensimulasikan pengguna yang masuk, membuka dasbor, membuka workbook (metadata + seluruh sel), tersambung WebSocket, mengirim posisi kursor setiap detik, dan mengedit sel setiap 3 sampai 6 detik.

```bash
cd apps/server
npx tsx loadtest/seed.ts 500 5      # 500 akun, 1 workbook per 5 pengguna (200 baris data)
BASE=http://localhost:3000 npx tsx loadtest/run.ts 500 60
```

Hasil pada satu mesin 4 core / 15 GB (server, PostgreSQL, Redis dan generator beban berbagi CPU yang sama), 500 pengguna masuk dalam 10 detik:

| Skenario | Berhasil | Login p95 | Buka workbook p95 | Edit p50 / p95 | Real-time p95 |
|---|---|---|---|---|---|
| 1 proses, 5 pengguna per workbook | 500/500, 0 error | 0,58 s | 1,0 s + 0,5 s | 11 ms / 291 ms | 290 ms |
| 4 worker + Redis, 5 per workbook | 500/500, 0 error | 2,0 s | 1,9 s + 1,8 s | 14 ms / 44 ms | 44 ms |
| 1 proses, 20 editor per workbook | lihat catatan rilis | | | | |

Yang membuat ini mungkin:

- **Rate limit sesuai kenyataan kantor/sekolah**: login dibatasi per IP + email (anti tebak sandi) dengan batas per IP yang longgar, karena ratusan pegawai sering berbagi satu IP publik. Batas API dihitung per pengguna.
- **Argon2id profil minimum OWASP** (19 MiB, 2 iterasi) dan thread pool 16: 500 login serentak tidak menghabiskan CPU. Hash lama diperbarui otomatis saat login.
- **Cache** sesi, peran workbook dan pengaturan sistem dengan invalidasi langsung saat berubah (lintas proses lewat Redis).
- **Mode cluster** (`WORKERS` > 1 + `REDIS_URL`): koneksi dibagi ke beberapa proses dengan sticky session; ruang real-time, invalidasi cache dan rate limit dibagi lewat Redis; daftar kehadiran dibaca dari socket sehingga benar lintas proses.
- Edit dikirim per batch (debounce 700 ms) dengan `INSERT ... ON CONFLICT`; posisi kursor dikirim sebagai pesan *volatile*.

Pengaturan terkait ada di `apps/server/.env.example` (`WORKERS`, `REDIS_URL`, `DB_POOL_MAX`, `LOGIN_IP_LIMIT`, `LOGIN_ACCOUNT_LIMIT`, `API_RATE_LIMIT`). Untuk server produksi: satu worker per core, `DB_POOL_MAX × WORKERS` di bawah `max_connections` PostgreSQL.

## Target performa (PRD bab 10)

| Target | Hasil terukur |
|---|---|
| Dasbor < 3 s | 0,84 s (browser, `apps/web/perf/browser-bench.cjs`) |
| Membuka spreadsheet < 3 s | 1,5 s untuk 20.000 baris / 60.000 sel / 20.000 formula |
| Respons edit < 100 ms | 62 ms: edit yang memicu 4 agregat atas 50.000 baris (median) |
| Kalkulasi ulang < 200 ms (sederhana) | 0,6 ms di sheet 1.000 sel; 7 ms rantai 2.000 baris; FILTER+SORT 50.000 baris 159 ms |
| Real-time < 500 ms | p95 44 sampai 290 ms pada 500 pengguna |
| Grid 60 FPS | rata-rata 57 FPS, p95 frame 17 ms saat scroll terus-menerus (Chromium headless) |
| 5 sampai 20 pengguna per workbook | diuji dengan 5 dan 20 editor aktif per workbook |

## Arsitektur

```
packages/engine   Formula engine murni TypeScript: parser, evaluator, dependency graph,
                  formula array (spill), format angka/tanggal, translasi referensi,
                  pergeseran baris/kolom. Tanpa React, tanpa eval().
apps/server       Express 5 + Prisma 7 (PostgreSQL) + Socket.IO (+ Redis opsional).
apps/web          React 19 + Vite + Tailwind 4 + Base UI + TanStack Query + Zustand.
```

| Keputusan PRD bab 14 | Implementasi |
|---|---|
| Sparse cell storage | Hanya sel berisi nilai/format disimpan; sel yang dikosongkan dihapus. |
| Batch operations | Klien mengumpulkan perubahan 700 ms lalu mengirim satu batch. Sisip/hapus baris dan kolom dijalankan sebagai satu pergeseran SQL di server, tanpa batas jumlah sel. |
| Formula engine terpisah | `packages/engine`, dipakai klien (kalkulasi langsung) dan server (impor, ekspor, IMPORTRANGE, pemulihan versi). |
| Virtualized rendering | Grid digambar di `<canvas>` hanya untuk sel yang terlihat; editor, dropdown dan popover memakai DOM overlay. |
| Revision-based sync | Setiap batch membawa revisi dasar per sel; server menolak (409) bila sel yang sama diubah orang lain sejak itu, atau bila baris/kolom sheet itu bergeser. |
| Database independence | Semua data di PostgreSQL; berkas asli impor di disk lokal atau penyimpanan S3. |

Riwayat versi memakai snapshot (revisi 0 dan setiap 100 revisi) ditambah perubahan inkremental per batch, termasuk sisip/hapus baris dan kolom. Pemulihan = snapshot terdekat + perubahan sampai revisi tujuan, diterapkan sebagai revisi baru.

## Cakupan terhadap PRD

Semua modul bab 2.1 dan kriteria penerimaan bab 13 berjalan dan diuji (test otomatis dan uji klik di browser). Ringkasnya:

- **Auth dan pengguna**: daftar (bisa dimatikan admin), masuk, keluar, ingat saya, lupa/atur ulang kata sandi lewat email, sesi cookie HttpOnly + SameSite, kunci akun + rate limit, kelola sesi aktif, panel admin dan log audit.
- **Peran**: peran aplikasi (Super Admin/Pengguna) terpisah dari peran workbook (Pemilik, Editor + kelola akses, Editor, Komentator, Pembaca).
- **Dasbor**: terakhir dibuka, milik saya, dibagikan, berbintang, sampah, folder, pencarian, filter, tampilan daftar/kisi, warna dokumen.
- **Editor**: seleksi, fill handle, freeze, sembunyikan/tampilkan, ubah ukuran, tinggi baris otomatis untuk teks terbungkus, keyboard, salin/tempel, undo/redo (termasuk sisip/hapus baris dan kolom), formula bar dengan autocomplete dan pewarnaan sintaks, menu konteks, menu lengkap.
- **Format**: huruf, warna, perataan, bungkus, rotasi, indentasi, isian, batas, format angka (termasuk kustom), gabung sel, format bersyarat, validasi data, dropdown, kotak centang.
- **Formula**: semua formula MVP, ditambah formula lanjutan **FILTER, SORT, UNIQUE, SEQUENCE, QUERY, ARRAYFORMULA, TRANSPOSE, IMPORTRANGE, TEXTJOIN, XLOOKUP, REGEXMATCH, REGEXEXTRACT** dan lainnya. Hasil array "tumpah" ke sel di sebelahnya; bila terhalang data, formula menampilkan #REF!. Operasi pada rentang (`=A1:A10*2`, `IF(B2:B9>70, ...)`) menghasilkan array.
- **IMPORTRANGE** mengambil rentang dari workbook OpenSheet lain; pengguna harus punya akses baca ke workbook sumber.
- **Data**: urutkan, filter (nilai, kondisi, warna), tampilan filter, hapus duplikat, cari dan ganti, pisah teks ke kolom, rentang/sheet dilindungi.
- **Kolaborasi**: kehadiran, seleksi kolaborator berwarna, pembaruan real-time, info terakhir diubah, autosave dengan status lengkap, deteksi konflik.
- **Berbagi**: undang lewat email, ubah/cabut akses langsung, akses lewat tautan, dan (opsional, dimatikan secara default) **tamu tanpa akun** yang membuka tautan sebagai Pembaca.
- **Impor/ekspor**: impor XLSX, **ODS**, CSV, TSV; ekspor XLSX, **ODS**, CSV, TSV, PDF. ODS diuji pulang-pergi dengan LibreOffice. Berkas asli impor disimpan (disk lokal atau **S3**) dan bisa diunduh lagi dari menu File.
- **Responsif dan tema**: tata letak ponsel dengan panel edit khusus; tema terang/gelap.

### Batasan yang perlu diketahui

- Kompatibilitas XLSX/ODS terbatas pada formula dan format yang didukung (PRD 14.7); fungsi yang tidak dikenal tetap disimpan tetapi menampilkan #NAME?.
- Formula yang dirujuk sebagai teks tidak ikut divektorkan otomatis kecuali lewat operator, IF, IFERROR atau ARRAYFORMULA (misalnya `LEFT(A1:A3,1)` tidak menghasilkan array).
- Data IMPORTRANGE terlihat oleh semua yang dapat membuka workbook tujuan, seperti di Google Sheets.
- Pengaturan cluster diuji dengan Redis di satu mesin; di banyak mesin, load balancer perlu sticky session.

## Keamanan (PRD bab 9)

Argon2id; cookie sesi HttpOnly, SameSite=Lax, Secure di produksi; header CSRF wajib + pengecekan Origin; Helmet + CSP; rate limit login (per IP+email) dan API (per pengguna); validasi input dengan Zod; Prisma/parameterized SQL; validasi akses di setiap endpoint dan koneksi WebSocket; perlindungan rentang di server; batas ukuran dan pengecekan tipe berkas; berkas unggahan disimpan dengan nama acak tanpa ekstensi dan hanya dikirim balik sebagai unduhan (`application/octet-stream`, `nosniff`); formula tidak pernah memakai `eval()`/`Function()` (dicek oleh test). HTTPS dan backup database diatur di sisi deployment (reverse proxy dan `pg_dump` terjadwal).
