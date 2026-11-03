# Temuan review & status perbaikan

Review atas `Code.gs` dan `index.html` versi awal (commit `ac6252a`). Semua temuan bertanda **TERBUKTI**
direproduksi dengan eksekusi di mock Apps Script sebelum diperbaiki; setelah diperbaiki, tiap temuan dijaga
oleh tes di `tests/` (dan tiap perbaikan diuji dengan *mutation test*: perbaikan dirusak sengaja, tes harus gagal).

Keyakinan: **TERBUKTI** = dijalankan · **BACA** = kesimpulan kuat dari membaca kode · **ASUMSI** = perilaku Google
Sheets/Drive yang tidak bisa diverifikasi di luar Google (lihat checklist smoke test di README).

## Ringkasan

| ID | Keparahan | Temuan | Status |
|---|---|---|---|
| K1 | Kritis | PIN `constructor` / `__proto__` / `toString` lolos autentikasi (TERBUKTI) | Diperbaiki |
| T1 | Tinggi | Batalkan penjualan *Retur* lama mengembalikan barang ke Tersedia padahal sudah dijual ulang → terjual 3× (TERBUKTI) | Diperbaiki |
| T2 | Tinggi | Penulisan tidak atomik: barang tanpa kas, uang "hilang" di Pindah Saldo (TERBUKTI) | Diperbaiki (keputusan D2) |
| T3 | Tinggi | Tanpa idempotensi: retry/double-submit menggandakan Barang & Kas (TERBUKTI) | Diperbaiki |
| T4 | Tinggi | Staf bisa membuat kas keluar tanpa bukti lewat 4 jalur otomatis (TERBUKTI) | Diperbaiki (keputusan D1, D3) |
| S1 | Sedang | Lockout global = DoS; frontend mengeluarkan semua perangkat saat terkunci (TERBUKTI) | Diperbaiki sebagian (keputusan D4); sisa risiko didokumentasikan |
| S2 | Sedang | Validasi: tanggal sembarang, COD diterima 0, `"50.000"` → Rp50, desimal dibulatkan diam-diam, nama kosong (TERBUKTI) | Diperbaiki |
| S3 | Sedang | File apa pun (mis. `text/html`) diterima & dibagikan publik; foto & bukti satu folder (TERBUKTI) | Diperbaiki |
| S4 | Sedang | Tanggal/angka/teks dari Sheets: zona waktu bergeser (TERBUKTI), teks → tanggal/formula (ASUMSI), format hilang di baris > 1000 (ASUMSI), angka berupa teks (BACA) | Diperbaiki; perilaku Sheets perlu smoke test |
| S5 | Sedang | `getAll` tanpa lock, error lock berbahasa Inggris, `update_` per sel (BACA) | Diperbaiki |
| S6 | Sedang | Kode barang bisa kembar bila properti urutan hilang; ID 32-bit (BACA) | Diperbaiki |
| R1 | Rendah | `ACTIONS['__proto__']` → "fn is not a function" (TERBUKTI) | Diperbaiki (satu akar dengan K1) |
| R2 | Rendah | Frontend: tanpa timeout, guard kirim-ganda lewat state, klik latar menutup form & membuang foto, harga jual tak ikut barang, "Modal tertahan" tanpa Dipesan, tab tersisa antar pengguna | Diperbaiki |
| R3 | Rendah | `statusBarang` ke status yang sama menambah catatan; log dibaca penuh tiap `getAll`; `setSharing` gagal ditelan diam-diam | Diperbaiki |
| R4 | Rendah | Tag `<script>` CDN tanpa SRI | **Tidak dikerjakan** (alasan di bawah) |
| R5 | Rendah | Foto lama tetap publik setelah diganti | **Tidak dikerjakan** (alasan di bawah) |

## Rincian perbaikan

**K1 — bypass PIN.** `users[pin]` pada objek biasa mengembalikan properti prototype. Sekarang: PIN harus `^\d{6}$`
dan dicari dengan `hasOwnProperty`; percobaan yang tidak cocok dihitung sebagai gagal. Dispatch aksi juga memakai
`hasOwnProperty`. Tes: `auth.test.js` "[K1] …".

**T1 — barang terjual ganda.** `batalkan Penjualan` hanya mengembalikan barang ke Tersedia bila penjualan itu masih
*aktif* (Lunas / Menunggu COD). Penjualan Retur sudah melepas barangnya. Tes: `integritas.test.js` "[T1] …".

**T2 — penulisan tidak atomik (D2).** Urutan tiap aksi: validasi → cek kondisi → simpan file ke Drive → baru tulis sheet.
Tulisan sheet berjalan di bawah transaksi ringan: bila gagal di tengah, **SISTEM** memulihkan — baris baru ditandai
`Batal` (tidak dihapus) dengan `[BATAL OTOMATIS: pesan error]`, baris yang diubah dikembalikan ke nilai lama, dan
Log mencatat "Rollback otomatis". Bila pemulihan sendiri gagal, pesan error menyuruh memeriksa Log. Ini satu-satunya
pengecualian atas "Batal oleh admin + alasan": hanya untuk aksi yang gagal dan tidak pernah dilaporkan berhasil ke pengguna.

**T3 — idempotensi.** Frontend membuat `rid` per formulir. Server menyimpan `rid` di kolom baru `req_id` (akhir sheet Log)
dan cache 6 jam; `rid` yang sama dikirim lagi → hasil lama dikembalikan, tidak ditulis ulang. Jendela deteksi: 300 baris Log
terakhir. Aksi yang ditolak/gagal tidak menghabiskan `rid`.

**T4 — bukti staf (D1, D3).** Staf wajib bukti untuk: transfer, pencairan COD, **semua** kas (keluar, masuk, Pindah),
ongkir saat jual, biaya retur, dan pembelian barang yang dibayar dari Rekening. Pembelian dari Tunai tetap boleh tanpa
bukti (foto barang sudah wajib; keputusan D1). Admin tidak diwajibkan.

**S1 — login (D4).** Login memakai PIN dan menghasilkan token acak (30 hari, maks. 40 sesi). Aksi lain memakai token,
sehingga pengguna yang sudah masuk tidak ikut terkunci. Penghitung salah-PIN disimpan di Script Properties (bukan
CacheService), tidak diperpanjang saat terkunci, dan **tidak direset oleh login sukses** (penyerang yang tahu satu PIN
tak boleh mendapat tebakan tak terbatas). Lockout tercatat di Log sekali. Frontend hanya mengeluarkan pengguna bila sesi
benar-benar berakhir, dan PIN tidak lagi disimpan di perangkat (PIN lama di localStorage dihapus otomatis).

**S2 — validasi.** Rupiah: bilangan bulat tanpa titik/koma (`"50.000"` ditolak, bukan ditebak); frontend memakai input
yang hanya menyimpan digit (tampil "50.000", terkirim 50000). Tanggal: `YYYY-MM-DD` yang nyata, ≥ 2020, ≤ besok.
COD Lunas: diterima > 0. Teks dipangkas (nama 120, catatan 500, dst.); nama tidak boleh dikosongkan saat edit.

**S3 — file.** Hanya JPEG/PNG/WebP, byte awal harus cocok dengan jenisnya, maks. 4 MB, divalidasi *sebelum* ada yang
disimpan. Foto → folder "Tripting - Foto barang" (dibagikan via link). Bukti → folder privat. Gagal membagikan foto kini
menggagalkan aksi dengan pesan jelas, bukan menghasilkan foto "publik" yang tidak bisa dibuka. `setup()` memperingatkan
bila folder bukti tidak privat.

**S4 — data dari Sheets.** `Date` diformat dengan zona waktu *spreadsheet* (bukan skrip) → tanggal tidak bergeser. Semua
kolom teks diformat "teks biasa" lewat `setup()` **dan** untuk setiap baris yang ditulis (format dipasang sebelum nilai;
sheet diperluas bila melewati 1000 baris). Angka berupa teks (`"50.000"`, `"Rp 1.250.000"`) dibaca benar; yang tak
terbaca atau kolom teks yang berisi tanggal dimunculkan sebagai banner "Data di Sheet perlu diperiksa" untuk admin.

**S5/S6.** `getAll` dibaca di bawah lock; pesan server sibuk berbahasa Indonesia; `update_` menulis satu kali per baris;
Log dibaca 40 baris terakhir; kode barang = max(properti urutan, isi sheet) + 1 (tidak pernah kembar, tidak memakai ulang
kode barang yang dibatalkan); ID 12 heksadesimal.

## Sengaja tidak dikerjakan / sisa risiko

- **R4 — SRI untuk CDN.** Hash tidak bisa diverifikasi terhadap cdnjs dari lingkungan pengembangan ini (akses ke cdnjs
  diblokir), dan hash yang salah akan mematikan seluruh aplikasi (browser menolak skrip). Bila ingin: hitung di komputer Anda
  `curl -s <URL> | openssl dgst -sha384 -binary | openssl base64 -A`, lalu tambahkan `integrity="sha384-…" crossorigin="anonymous"`
  pada tiga tag `<script>`, dan uji dengan membuka aplikasi.
- **S1 — sisa risiko.** Apps Script tidak melihat IP penelepon, jadi lockout bersifat global: siapa pun yang tahu URL
  (publik di repo) tetap bisa membuat **login baru** terkunci 15 menit dengan 20 tebakan salah. Dampaknya kini terbatas pada
  perangkat yang belum punya sesi (sesi berlaku 30 hari). Mengurangi ini lebih jauh butuh faktor lain di luar PIN.
- **R5 — foto lama tetap publik setelah diganti.** Menghapus/memindahkan file lama bertentangan dengan semangat "tidak ada
  hapus"; foto itu hanya bisa dibuka oleh orang yang sudah memegang link-nya.
- **Retur untuk penjualan non-COD** (transfer/tunai) belum ada alurnya; koreksinya lewat Batal oleh admin.
- **Kas keluar melebihi saldo** tidak diblokir (bisa menghambat operasi bila saldo awal belum dicatat). Saldo negatif tampil
  merah di Ringkasan.
- **Hal yang bukan aturan tertulis dan dibiarkan:** staf dapat melihat harga beli, laba, dan seluruh kas; staf dapat
  menandai barang Rusak/Tersedia dengan alasan (tercatat di Log); staf dapat mundur-tanggalkan transaksi sampai 2020.
  Bila ingin dibatasi, itu keputusan aturan bisnis.
- **Tanggal bawaan formulir** memakai zona waktu perangkat; server menerima sampai "besok" menurut WIB agar selisih zona
  tidak menolak input yang wajar.
- **Batas mock.** Tes berjalan di model Apps Script, bukan Google asli. Perilaku yang ditiru dari pengalaman (Sheets
  mengubah teks "2-3" jadi tanggal bila sel bukan format teks, `=` jadi formula) dan kebijakan Drive/Workspace hanya
  terverifikasi lewat smoke test manual (README).
