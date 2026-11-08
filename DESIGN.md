# Arah desain OpenSheet

Sumber arah: PRD bagian 5.1 (modern, minimalis, profesional, bersih, responsif, familiar bagi pengguna Google Sheets).

**Design Read:** aplikasi spreadsheet untuk pegawai instansi, tim administrasi dan satuan pendidikan, dengan bahasa visual "kertas buku besar" yang tenang dan profesional. Dial: **ENERGY 1 / RHYTHM 1 / MOTION 1**. Alat kerja yang dipakai berjam-jam: data pengguna harus menjadi hal paling menonjol, bukan antarmukanya.

| Keputusan | Alasan |
|---|---|
| Warna netral kertas (`#F6F5F1`) + satu hijau buku besar (`#17603F`) | Hijau menandai seleksi dan aksi utama saja; latar hangat mengurangi silau pada pemakaian lama. |
| Satu aksen bata (`#9C4219`) | Hanya untuk hal yang butuh perhatian: komentar, bintang, konflik, offline. |
| IBM Plex Sans | Dirancang untuk antarmuka padat data, angka tabular jelas di 13 px. |
| IBM Plex Mono untuk alamat sel, kotak nama, dan formula | Motif identitas: "suara alamat". Kurung dan referensi lebih mudah dibaca saat menyunting formula. |
| Ikon garis 16 px buatan sendiri, ujung persegi | Mengikuti garis tabel buku besar; hanya ikon yang memang dipakai. |
| Logo berupa teks "OpenSheet" | Belum ada logo resmi; favicon huruf "O" adalah placeholder. |
| Tidak ada kartu dekoratif, gradien, atau glow | Kartu hanya untuk daftar dokumen di tampilan kisi; selebihnya daftar dan tabel. |
| Gerak: menu/popover 150 ms ease-out dari pemicu, dialog 200 ms, lembar bawah ponsel 280 ms | Mengikuti prinsip Emil Kowalski: navigasi sel, seleksi, dan pintasan keyboard tidak dianimasikan karena dipakai ratusan kali sehari. `prefers-reduced-motion` dihormati. |
| Tema terang dan gelap dengan toggle | Tidak ada alasan merek untuk memaksa satu tema; warna sel pilihan pengguna dijaga tetap terbaca di kedua tema. |
| Warna dokumen dan warna sel | Data milik pengguna (PRD 4.3, 4.5), bukan palet antarmuka. |
| Pewarnaan formula di formula bar dan editor sel | Warna referensi mengikuti urutan dan warna kotak referensi di grid, jadi mata bisa mencocokkan teks dengan sel yang dirujuk. Fungsi tebal, teks berwarna aksen, angka abu. |
| Garis putus-putus di sekitar hasil array | Menunjukkan area yang diisi satu formula (FILTER, SORT, QUERY, ...). Hijau bila tampil, merah bila terhalang data. |
| Tinggi baris otomatis | Baris tanpa tinggi manual tumbuh mengikuti teks terbungkus dan huruf besar, sehingga isi tidak terpotong. |
| Ikon dari lucide-react (permintaan produk) | Mengganti set ikon buatan sendiri. Satu pemetaan nama aksi ke ikon di `components/icons.tsx`, jadi pemanggil membaca `Icon.Merge`, bukan nama glyph. Teks dikurangi di navigasi, menu, dan filter dengan ikon pendamping. |
| Dasbor default berupa kisi dengan thumbnail | Isi sheet lebih cepat dikenali daripada judul "Spreadsheet tanpa judul". Thumbnail adalah SVG yang digambar server dari nilai sel, di-cache per revisi. |
| Filter pribadi memakai aksen bata putus-putus, filter bersama hijau solid | Perbedaan siapa yang terpengaruh harus terlihat tanpa membaca teks. |
| Kekuatan sandi: batang empat segmen, label, saran satu kalimat, daftar syarat | Warna tidak berdiri sendiri; label dan daftar tetap terbaca bagi yang tidak membedakan warna. |
| Bagan digambar sebagai SVG sendiri, warna dari token `--chart-1..8` | Enam jenis memakai satu tata letak (judul, legenda, sumbu), tanpa pustaka tambahan. Token punya varian terang dan gelap, dan nama seri tetap ada di legenda dan tooltip jadi warna tidak berdiri sendiri. Disimpan di metadata sheet, jadi ikut undo, riwayat, dan realtime. |
| Rentang dipilih dengan seret di sheet | Dialog menyingkir selama memilih (bukan disembunyikan, supaya tidak mengunci pointer), bilah kecil di bawah menampilkan rentang langsung. Enter memilih, Esc membatalkan. |
| Panah kecil di header untuk baris/kolom tersembunyi | Dua segitiga di batas tempat baris/kolom disembunyikan; klik ganda menampilkannya lagi. Baris yang disembunyikan filter tidak diberi panah karena hilang lewat filter. |
| Seret untuk memindah baris, kolom, dan sel | Header yang sudah dipilih dan garis tepi seleksi menjadi pegangan (kursor `grab`). Rumus yang menunjuk ke sel yang dipindah ikut berpindah, satu langkah undo. |
| Kursor `pointer` untuk semua yang bisa diklik | Satu aturan global di `@layer base` (tombol, tautan, role menu/tab/opsi, label radio dan kotak centang). Yang nonaktif menjadi `not-allowed`. |
| Gabungkan sel meminta konfirmasi bila ada data dan menolak di area beku | Sel yang digabung hanya menyisakan nilai kiri atas; baris atau kolom beku tetap diam saat scroll, jadi sel gabungan tidak bisa ikut. |
| Sambungan Google Sheets lewat kunci baca-saja, bukan login Google | OpenSheet tidak punya izin ke akun Google pengguna. Kunci disimpan hanya sebagai hash SHA-256, ditampilkan sekali, tercatat di audit, bisa dicabut seketika, dan hanya memberi akses baca ke satu workbook. Jawaban 304 lewat ETag membuat polling tiap menit murah. |
