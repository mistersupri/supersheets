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
