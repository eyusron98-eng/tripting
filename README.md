# Tripting — Sistem Barang & Kas

Backend: Google Sheets + Apps Script · Frontend: `index.html` (React CDN) di GitHub Pages · Biaya: Rp0.

## Pemasangan (±20 menit)

### A. Backend (Google Sheets)
1. Buat Google Sheet baru bernama **Tripting** di akun Google Eri.
2. Menu **Ekstensi → Apps Script**. Hapus isi `Code.gs`, tempel isi file `Code.gs` dari paket ini, lalu simpan.
3. Di **Setelan proyek** (ikon roda gigi), set zona waktu ke **(GMT+07:00) Jakarta**.
4. Pilih fungsi `setup` di toolbar, lalu klik **Jalankan**. Izinkan akses (Sheets + Drive).
   - Akan muncul peringatan "Google belum memverifikasi aplikasi ini". Ini normal untuk skrip milik sendiri: klik **Lanjutan → Buka (tidak aman)**.
5. Buka **Log eksekusi** dan catat dua PIN: **Eri (admin)** dan **Deni (staf)**.
6. Klik **Terapkan → Deployment baru → jenis: Aplikasi web**:
   - Jalankan sebagai: **Saya**
   - Yang memiliki akses: **Siapa saja**
   - Salin URL yang berakhiran `/exec`.

### B. Frontend (GitHub Pages)
1. Buat repo baru (misal `tripting`). Repo harus **public**, karena GitHub Pages gratis tidak bisa dipakai untuk repo private.
2. Upload `index.html`, lalu edit baris berikut dan isi dengan URL dari langkah A.6:
   `const API_URL = 'TEMPEL_URL_WEB_APP_DI_SINI';`
3. Buka **Settings → Pages → Deploy from branch → main / (root)**.
4. Buka `https://<username>.github.io/tripting/`. Login dengan PIN admin untuk mengetes.
5. Kirim link dan PIN Deni lewat chat pribadi. Di HP Deni, pilih menu "Tambahkan ke layar utama" supaya bisa dibuka seperti aplikasi.

## Aturan penting

- **Jangan beri Deni akses edit ke Google Sheet-nya.** Kalau dia bisa membuka Sheet, dia bisa mengubah angka langsung tanpa tercatat di Log. Semua input Deni harus lewat aplikasi.
- **Data tidak pernah dihapus.** Kesalahan dibetulkan dengan **Batalkan** (khusus admin, wajib diisi alasan), lalu input ulang. Transaksi kas yang terkait ikut dibatalkan otomatis.
- **Harga beli tidak bisa diedit.** Kalau salah, admin membatalkan barangnya, lalu barang diinput ulang.
- **Rekonsiliasi mingguan:** cocokkan saldo Rekening dengan mutasi bank, dan saldo Tunai dengan uang fisik. Selisihnya dicatat sebagai kas kategori **Penyesuaian** (khusus admin) dengan keterangan yang jelas.

## Alur kerja Deni

| Kejadian | Di aplikasi |
|---|---|
| Beli barang | Barang → **+** (wajib foto barang). Kas keluar tercatat otomatis. |
| Terjual transfer/tunai | Penjualan → **+** (transfer wajib bukti). Kas masuk tercatat otomatis. |
| Terjual COD | Penjualan → **+**, metode COD. Status barang menjadi *Dipesan*. |
| COD cair / retur | Penjualan → **Konfirmasi**. Isi uang bersih yang diterima, atau pilih retur. |
| Biaya lain (plastik, ongkir, dll.) | Kas → **+** (wajib bukti). |
| Setor tunai ke rekening | Kas → **+** → jenis **Pindah**. |

## Hal yang dilihat Eri
Ringkasan berisi saldo per akun, laba kotor bulan ini, modal yang tertahan di stok, COD yang belum cair, barang yang belum laku ≥30 hari, dan log aktivitas (siapa melakukan apa dan kapan).

## Saat mengubah kode
- **Code.gs:** setelah mengedit, buka **Terapkan → Kelola deployment → ✏️ → Versi: Versi baru → Terapkan**. Dengan cara ini URL tetap sama. Kalau memilih "Deployment baru", URL akan berubah dan `index.html` harus diedit ulang.
- **Ganti PIN:** buka Setelan proyek → Properti skrip, hapus `USERS`, lalu jalankan `setup` lagi.

## Batasan yang perlu diketahui
- Keamanan berupa PIN 6 digit, dengan kunci otomatis setelah 20 kali salah dalam 15 menit. Tingkat ini cukup untuk 2 orang, tetapi bukan setara perbankan. URL API terlihat di repo publik, jadi PIN-lah satu-satunya pengaman.
- Foto barang dibagikan "siapa saja yang punya link" agar bisa tampil di katalog. Bukti transfer **tidak** dibagikan, sehingga hanya bisa dibuka dari akun Google Eri.
- Data dimuat ulang penuh setiap kali ada aksi. Ini masih cepat sampai beberapa ribu baris. Kalau sudah lewat dari itu, saatnya pindah ke database.
