# Tripting — Sistem Barang & Kas

Backend: Google Sheets + Apps Script · Frontend: `index.html` (React CDN) di GitHub Pages · Biaya: Rp0.
Pengguna: **Eri** (admin, memantau) dan **Deni** (staf, input dari HP).

```
index.html            frontend satu file (GitHub Pages, branch main)
apps-script/
  Code.gs             backend (satu-satunya salinan; di-push dengan clasp)
  appsscript.json     zona waktu Jakarta, V8, web app: jalankan sebagai pemilik, akses anonim
scripts/              deploy.js (push + deploy ulang ke ID yang sama), pages-enable.js
tests/                harness Node + mock Apps Script (npm test)
docs/TEMUAN.md        hasil review kode & status tiap temuan
```

## Yang harus Anda kerjakan sendiri (tidak bisa saya wakili)

Semua langkah ini butuh akun Google/GitHub Anda. Urutannya:

| # | Langkah | Di mana |
|---|---|---|
| 1 | `npm install`, lalu **`npx clasp login`** (membuka browser) | komputer Anda |
| 2 | Aktifkan **Google Apps Script API**: <https://script.google.com/home/usersettings> | browser |
| 3 | Salin **Script ID**, isi `.clasp.json` | Apps Script → Setelan proyek |
| 4 | **Otorisasi Google pertama kali** (jalankan `setup`) | editor Apps Script |
| 5 | **Deploy web app pertama kali** | editor Apps Script |
| 6 | Isi **`API_URL`** di `index.html`, commit & push ke `main` | repo |
| 7 | Aktifkan **GitHub Pages** (`npm run pages:enable` atau 1 klik) | GitHub |
| 8 | Jalankan **smoke test** di bagian bawah (±10 menit) | HP + Sheet Anda |

## Pemasangan pertama kali

### A. Backend

1. Buat Google Sheet baru bernama **Tripting** di akun Google Eri.
2. **Ekstensi → Apps Script**. Di **Setelan proyek** (roda gigi): set zona waktu **(GMT+07:00) Jakarta**, lalu salin **ID Skrip**.
   Di Sheet sendiri: **File → Setelan → Zona waktu** juga **Jakarta** (penting agar tanggal tidak bergeser).
3. Di komputer, di folder repo ini:
   ```bash
   npm install
   npx clasp login                          # login dengan akun Google Eri
   cp .clasp.json.example .clasp.json       # lalu isi scriptId dengan ID Skrip tadi
   npm run push                             # kirim apps-script/ ke proyek Apps Script
   ```
   (Windows: `copy .clasp.json.example .clasp.json`.) `.clasp.json` tidak ikut git.
4. Di editor Apps Script (muat ulang halaman), pilih fungsi **`setup`** → **Jalankan**. Izinkan akses Sheets + Drive.
   Muncul "Google belum memverifikasi aplikasi ini": normal untuk skrip milik sendiri → **Lanjutan → Buka (tidak aman)**.
   Buka **Log eksekusi** dan catat dua PIN: **Eri (admin)** dan **Deni (staf)**.
   `setup()` aman dijalankan ulang kapan saja (tidak mengganti PIN, folder, atau data).
5. **Deploy pertama (manual):** **Terapkan → Deployment baru → jenis: Aplikasi web** → Jalankan sebagai **Saya**,
   Yang memiliki akses **Siapa saja** → Terapkan. Salin URL berakhiran `/exec`.
6. Simpan ID deployment untuk deploy berikutnya:
   ```bash
   npx clasp deployments                    # salin ID yang BUKAN "@HEAD"
   echo <ID-deployment> > .deployment-id    # (Windows: echo <ID> > .deployment-id)
   ```
   (URL `/exec` = `https://script.google.com/macros/s/<ID-deployment>/exec`.)

### B. Frontend (GitHub Pages)

1. Edit satu baris di `index.html`:
   `const API_URL = 'TEMPEL_URL_WEB_APP_DI_SINI';` → isi dengan URL dari langkah A.5. Commit dan push ke **`main`**.
2. Aktifkan Pages dari branch `main` (repo harus **public**; Pages gratis tidak untuk repo private):
   - `gh auth login` lalu `npm run pages:enable`, **atau**
   - GitHub → **Settings → Pages → Deploy from a branch → `main` / `(root)` → Save**.
3. Tunggu 1–2 menit, buka **<https://eyusron98-eng.github.io/tripting/>**, login dengan PIN admin.
4. Kirim link dan PIN Deni lewat chat pribadi. Di HP Deni: menu "Tambahkan ke layar utama".

## Memperbarui kode (rutin)

```bash
npm test          # semua tes harus hijau
npm run deploy    # tes → clasp push → clasp deploy ke ID deployment yang SAMA
```
URL web app **tidak berubah**, jadi `API_URL` tidak perlu diedit. `npm run deploy:dry` hanya mencetak apa yang akan dijalankan.
Jangan memakai "Deployment baru" di editor untuk pembaruan: itu membuat URL baru.
Perubahan `index.html` cukup di-commit dan di-push ke `main`; Pages memperbaruinya sendiri.

### Bila sebelumnya sudah memakai versi lama
`npm run push` → jalankan **`setup()` sekali lagi** (memasang format teks, kolom `req_id` di Log, dan folder foto terpisah)
→ `npm run deploy`. PIN dan data tidak berubah. Semua perangkat **perlu login ulang sekali** (sistem sesi baru). Bila Deni
membuka versi lama yang tersimpan di HP, minta muat ulang halaman (tarik ke bawah / buka ulang).

## Aturan penting

- **Jangan beri Deni akses edit ke Google Sheet maupun folder Drive.** Kalau bisa membuka Sheet, ia bisa mengubah angka tanpa tercatat di Log.
- **Folder "Tripting - Bukti (PRIVAT…)" jangan pernah dibagikan.** Foto barang ada di folder terpisah ("Tripting - Foto barang") dan memang dibagikan via link.
- **Saldo tidak pernah diketik:** selalu dihitung dari sheet Kas.
- **Data tidak pernah dihapus.** Koreksi = **Batalkan** (hanya admin, alasan wajib); transaksi kas yang terkait ikut batal.
  Satu pengecualian: bila sebuah aksi **gagal di tengah jalan** (mis. Google Sheets sedang bermasalah), sistem membatalkan sendiri
  tulisan yang sempat masuk, memberi tanda `[BATAL OTOMATIS …]`, dan mencatatnya di Log sebagai "Rollback otomatis" (pelaku: SISTEM).
- **Harga beli tidak bisa diedit.** Kalau salah, admin membatalkan barangnya lalu input ulang.
- **Rekonsiliasi mingguan:** cocokkan saldo Rekening dengan mutasi bank dan Tunai dengan uang fisik. Selisih dicatat sebagai kas kategori **Penyesuaian** (khusus admin).

## Alur kerja Deni

| Kejadian | Di aplikasi | Bukti |
|---|---|---|
| Beli barang | Barang → **+** (foto barang wajib). Kas keluar tercatat otomatis | Wajib bila dibayar dari **Rekening**; dari Tunai boleh kosong |
| Terjual transfer/tunai | Penjualan → **+** | Transfer: wajib. Ongkir ditanggung toko: bukti ongkir wajib |
| Terjual COD | Penjualan → **+**, metode COD. Barang menjadi *Dipesan*, belum ada uang masuk | Ongkir (bila ada): wajib |
| COD cair | Penjualan → **Konfirmasi → Lunas**, isi uang **bersih** yang diterima | Bukti pencairan wajib |
| COD retur | Penjualan → **Konfirmasi → Retur**. Barang kembali *Tersedia* | Biaya retur (bila ada): wajib |
| Biaya lain (plastik, dll.) | Kas → **+** | Wajib untuk semua catatan kas Deni |
| Setor tunai ke rekening | Kas → **+** → jenis **Pindah** | Wajib |

Ketik angka **tanpa** titik/koma (kolom otomatis menampilkan titik ribuan). Bila sinyal putus saat menekan Simpan, tekan **Muat ulang**
untuk memeriksa; menekan Simpan lagi dari formulir yang sama aman (tidak akan tercatat dobel).

## Yang dilihat Eri
Ringkasan: saldo per akun, laba kotor bulan ini, modal tertahan (stok + barang dipesan), COD yang belum cair, barang belum laku ≥ 30 hari,
log aktivitas, dan banner **"Data di Sheet perlu diperiksa"** bila ada sel yang rusak (mis. angka berisi teks). Daftar temuan review kode
dan status perbaikannya: [`docs/TEMUAN.md`](docs/TEMUAN.md).

## Ganti PIN
Apps Script → Setelan proyek → Properti skrip: hapus `USERS`, lalu jalankan `setup()`. PIN baru muncul di Log eksekusi dan **semua sesi lama
otomatis tidak berlaku**.

## Keamanan & batasan
- Masuk memakai PIN 6 digit, lalu perangkat menyimpan **token sesi** (30 hari), bukan PIN. Setelah 20 PIN salah, **login baru** dikunci 15 menit
  (untuk semua orang, karena Apps Script tidak melihat IP). Perangkat yang sudah punya sesi tidak ikut terkunci. URL API terlihat di repo publik,
  jadi PIN + kunci ini satu-satunya pengaman; cukup untuk 2 orang, bukan setara perbankan. **Jangan menguji kunci ini di produksi**: login baru akan terblokir 15 menit.
- Data dimuat penuh setiap aksi (cepat sampai beberapa ribu baris). Setelah itu, saatnya pindah ke database.
- Aksi tulis butuh sekitar 2–6 detik (beberapa panggilan ke Sheets/Drive di bawah kunci); wajar. Kuota harian gratis Google jauh di atas pemakaian toko kecil.

## Tes
`npm test` menjalankan harness di `tests/` (Node ≥ 20, tanpa dependensi): mock `SpreadsheetApp`, `DriveApp`, `PropertiesService`, `LockService`,
`CacheService`, `Utilities`, `ContentService`. Mencakup siklus tambah barang → jual transfer, COD lunas (diterima < harga), COD retur, pindah saldo,
batal penjualan/barang/kas, penolakan aksi admin oleh staf, PIN salah & lockout, serta tiap temuan review.

Batas yang perlu Anda tahu: ini **model** Apps Script, bukan Google asli. Hijau di sini belum membuktikan perilaku asli Sheets/Drive, karena itu ada smoke test di bawah.

## Smoke test di Sheet asli (±10 menit, sekali setelah pemasangan/pembaruan)

1. Setelah `setup()`: Sheet punya tab Barang, Penjualan, Kas, Log (Log punya 5 kolom, kolom terakhir `req_id`); Drive punya dua folder, "Tripting - Bukti (PRIVAT…)" dan "Tripting - Foto barang".
2. Login Eri → Barang → tambah barang dengan **ukuran `2-3`**, **nama `=1+1`**, kondisi/catatan `3/4`. Di Sheet, nilai itu harus persis teks tersebut (bukan tanggal, bukan `2`). Lalu **Batalkan** barang ini.
3. Foto barang tampil di daftar. Buka link foto di jendela penyamaran → terbuka. Buka link **bukti** (`bukti` di Penjualan/Kas) di jendela penyamaran → harus **minta akses**.
4. Login Deni di HP: tambah kas keluar tanpa bukti → ditolak; dengan bukti → berhasil; tidak ada tombol "batalkan".
5. Jual COD → barang *Dipesan*, saldo tidak berubah. Konfirmasi lunas dengan nominal bersih lebih kecil dari harga → saldo bertambah sebesar nominal bersih.
6. Catat kas dan **tekan Simpan dua kali dengan cepat** → hanya **satu** baris baru di sheet Kas.
7. Bandingkan Saldo di Ringkasan dengan penjumlahan manual kolom `nominal` (status Aktif) di sheet Kas.
8. Pastikan tanggal di sheet berupa `2026-11-03` (teks) dan sesuai hari ini (WIB).

Bila langkah 2 atau 8 gagal (sel berubah jadi tanggal/angka), catat perilakunya: itu bagian yang hanya bisa dipastikan di Google asli.

## Pemecahan masalah
- **"Sesi berakhir. Masuk lagi dengan PIN."**: wajar setelah 30 hari, setelah ganti PIN, atau setelah "Keluar" di perangkat lain. Masuk lagi.
- **"Terlalu banyak percobaan PIN salah"**: tunggu 15 menit; perangkat yang sudah masuk tidak terpengaruh.
- **"Server sedang sibuk"**: dua orang menyimpan bersamaan; coba lagi sebentar lagi.
- **Pesan berisi "dibatalkan otomatis"**: aksi gagal dan sudah dipulihkan; ulangi. Jika ada kalimat "GAGAL dipulihkan", hubungi admin dan periksa sheet Log.
- **`clasp push` menolak / API belum aktif**: aktifkan Apps Script API (langkah 2 di atas), lalu `npx clasp login` ulang.
- **`npm run deploy` berkata ID belum diketahui**: lihat langkah A.6.
