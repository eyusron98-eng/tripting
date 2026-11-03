/**
 * TRIPTING — Backend (Google Apps Script, terikat ke Google Sheet)
 *
 * Pasang: lihat README.md (clasp atau tempel manual) lalu jalankan setup() sekali.
 * Daftar temuan review & alasan perbaikannya: docs/TEMUAN.md.
 *
 * Aturan yang dijaga di sini:
 *  - Saldo tidak pernah disimpan; frontend menghitungnya dari sheet Kas.
 *  - Tidak ada hapus baris. Koreksi = "Batal" oleh admin + alasan; kas terhubung (ref) ikut batal.
 *  - Staf: foto barang wajib; bukti wajib untuk transfer, pencairan COD, dan SEMUA kas keluar/masuk
 *    (termasuk ongkir, biaya retur, Pindah Saldo, dan pembelian dari Rekening). Staf tidak bisa membatalkan.
 *  - Setiap aksi tulis tercatat di sheet Log. Aksi yang gagal di tengah dipulihkan otomatis (oleh "SISTEM").
 *  - Satu-satunya aksi tanpa PIN adalah `katalog` (untuk calon pembeli): hanya kolom aman, lihat katalog_().
 */

const TZ = 'Asia/Jakarta';

const SHEETS = {
  Barang: ['id', 'kode', 'tgl_beli', 'nama', 'kategori', 'ukuran', 'kondisi', 'sumber', 'harga_beli', 'harga_target', 'foto', 'status', 'catatan', 'dibuat_oleh', 'dibuat_pada', 'diubah_pada'],
  Penjualan: ['id', 'tgl', 'kode', 'pembeli', 'kontak', 'kanal', 'metode', 'harga_jual', 'ongkir', 'diterima', 'status', 'tgl_lunas', 'bukti', 'catatan', 'dibuat_oleh', 'dibuat_pada'],
  Kas: ['id', 'tgl', 'jenis', 'akun', 'kategori', 'nominal', 'ref', 'keterangan', 'bukti', 'status', 'dibuat_oleh', 'dibuat_pada'],
  Log: ['waktu', 'user', 'aksi', 'detail', 'req_id']   // req_id = kolom baru (idempotensi), di akhir
};
const KOLOM_ANGKA = { harga_beli: 1, harga_target: 1, harga_jual: 1, ongkir: 1, diterima: 1, nominal: 1 };
const KOLOM_TANGGAL = { tgl_beli: 1, tgl: 1, tgl_lunas: 1 };       // sisanya yang bertipe waktu → 'yyyy-MM-dd HH:mm'
const FORMAT_ANGKA = '#,##0';

const AKUN = ['Tunai', 'Rekening'];
const KATEGORI_KAS = {
  Masuk: ['Setoran Modal', 'Pemasukan Lain'],
  Keluar: ['Operasional', 'Ongkir', 'Upah', 'Setor ke Pemilik', 'Pengeluaran Lain']
};

const MAKS_GAGAL = 20;                       // percobaan PIN salah sebelum dikunci
const JENDELA_MS = 15 * 60 * 1000;           // lamanya kunci / jendela hitung
const SESI_MS = 30 * 24 * 60 * 60 * 1000;    // masa berlaku token sesi
const MAKS_SESI = 40;                        // jumlah sesi tersimpan (batas ukuran properti 9 KB)
const MAKS_FILE = 4 * 1024 * 1024;           // byte, per gambar
const MAKS_RP = 10000000000;                 // batas kewajaran nominal (Rp10 miliar)
const MAKS_KATALOG = 200;                    // jumlah barang maksimum di katalog publik
const TTL_KATALOG = 120;                     // detik; cache katalog publik (dihapus juga setiap ada aksi tulis)

let CTX_ = null;   // konteks aksi tulis yang sedang berjalan: { rid, ops } (direset di setiap eksekusi)

/* ============ SETUP (jalankan sekali dari editor; aman diulang) ============ */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (name) {
    const s = ss.getSheetByName(name) || ss.insertSheet(name);
    const head = SHEETS[name];
    s.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    s.setFrozenRows(1);
    // Semua kolom teks diformat "teks biasa" agar Sheets tidak mengubah "2-3", "3/4", "=..." menjadi tanggal/formula;
    // kolom rupiah diformat angka.
    head.forEach(function (h, i) {
      s.getRange(1, i + 1, s.getMaxRows(), 1).setNumberFormat(KOLOM_ANGKA[h] ? FORMAT_ANGKA : '@');
    });
  });
  ['Sheet1', 'Lembar1', 'Sheet 1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FOLDER_ID')) {
    props.setProperty('FOLDER_ID', DriveApp.createFolder('Tripting - Bukti (PRIVAT, jangan dibagikan)').getId());
  }
  if (!props.getProperty('FOLDER_FOTO_ID')) {
    props.setProperty('FOLDER_FOTO_ID', DriveApp.createFolder('Tripting - Foto barang').getId());
  }
  if (DriveApp.getFolderById(props.getProperty('FOLDER_ID')).getSharingAccess() !== DriveApp.Access.PRIVATE) {
    Logger.log('PERINGATAN: folder bukti tidak privat. Bukti transaksi tidak boleh dibagikan; atur ke "Dibatasi" di Google Drive.');
  }
  if (!props.getProperty('USERS')) {
    const users = {};
    users[pin6_(users)] = { nama: 'Eri', role: 'admin' };
    users[pin6_(users)] = { nama: 'Deni', role: 'staf' };
    props.setProperty('USERS', JSON.stringify(users));
    // PIN baru → semua sesi lama tidak berlaku lagi, penghitung salah-PIN direset
    props.deleteProperty('SESSIONS');
    props.deleteProperty('AUTH_FAIL');
  }
  const users = JSON.parse(props.getProperty('USERS'));
  Object.keys(users).forEach(function (pin) {
    Logger.log(users[pin].nama + ' (' + users[pin].role + ') → PIN: ' + pin);
  });
}

/** PIN 6 digit dari UUID (acak kriptografis di Apps Script), tidak sama dengan yang sudah ada. */
function pin6_(sudah) {
  let p;
  do {
    p = String(100000 + (parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 900000));
  } while (hasOwn_(sudah, p));
  return p;
}

/* ============ API ============ */
function doGet() {
  return ContentService.createTextOutput('Tripting API aktif.');
}

function doPost(e) {
  let out;
  try {
    let req;
    try { req = JSON.parse(e.postData.contents); } catch (x) { throw galat_('Permintaan tidak valid', 'REQ'); }
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw galat_('Permintaan tidak valid', 'REQ');
    const aksi = String(req.action === undefined ? '' : req.action);
    if (!hasOwn_(ACTIONS, aksi)) throw galat_('Aksi tidak dikenal: ' + aksi, 'AKSI');
    const data = req.data && typeof req.data === 'object' && !Array.isArray(req.data) ? req.data : {};
    let hasil;
    if (aksi === 'login') hasil = ACTIONS.login({ pin: req.pin }, null);        // satu-satunya aksi yang memakai PIN
    else if (hasOwn_(PUBLIK, aksi)) hasil = ACTIONS[aksi]({}, null);            // tanpa token: hanya data yang memang untuk umum
    else hasil = ACTIONS[aksi](data, authToken_(req.token));
    out = { ok: true, data: hasil };
  } catch (err) {
    out = { ok: false, error: err.message, code: err.code || '' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Aksi tanpa PIN/token. Tiap tambahan di sini membuka data ke SEMUA orang yang tahu URL: kembalikan hanya kolom yang aman. */
const PUBLIK = { katalog: 1 };

const ACTIONS = {
  katalog: katalog_,        // publik, TANPA lock (agar kunjungan pembeli tak membuat input staf "sibuk")
  login: kunci_(login_),
  keluar: kunci_(keluar_),
  getAll: kunci_(getAll_),
  tambahBarang: withLock_(tambahBarang_),
  ubahBarang: withLock_(ubahBarang_),
  statusBarang: withLock_(statusBarang_),
  tambahPenjualan: withLock_(tambahPenjualan_),
  konfirmasiCOD: withLock_(konfirmasiCOD_),
  tambahKas: withLock_(tambahKas_),
  batalkan: withLock_(batalkan_)
};

/* ============ AUTENTIKASI ============ */
/**
 * Login memakai PIN (dibatasi 20 kali salah / 15 menit, global karena Apps Script tidak tahu IP penelepon).
 * Berhasil → token sesi acak. Aksi lain memakai token, sehingga pengguna yang sudah masuk
 * tidak ikut terkunci bila seseorang menebak PIN ke URL publik.
 * Login yang berhasil sengaja TIDAK mereset penghitung (penyerang yang tahu satu PIN tak boleh dapat tebakan tak terbatas).
 */
function login_(d) {
  const sekarang = Date.now();
  const st = bacaProp_('AUTH_FAIL', { n: 0, t: 0 });
  if (st.n >= MAKS_GAGAL && sekarang - st.t < JENDELA_MS) {
    const menit = Math.max(1, Math.ceil((JENDELA_MS - (sekarang - st.t)) / 60000));
    throw galat_('Terlalu banyak percobaan PIN salah. Coba lagi ' + menit + ' menit lagi.', 'TERKUNCI');
  }
  if (sekarang - st.t >= JENDELA_MS) st.n = 0;       // jendela habis → hitung dari awal

  const users = bacaProp_('USERS', {});
  const pin = typeof d.pin === 'string' || typeof d.pin === 'number' ? String(d.pin).trim() : '';
  const u = /^\d{6}$/.test(pin) && hasOwn_(users, pin) ? users[pin] : null;   // hasOwn_: "constructor" dsb. bukan PIN
  if (!u) {
    st.n += 1; st.t = sekarang;
    tulisProp_('AUTH_FAIL', st);
    if (st.n === MAKS_GAGAL) logSistem_('Login terkunci', MAKS_GAGAL + ' percobaan PIN salah berturut-turut; login baru dikunci 15 menit');
    throw galat_('PIN salah', 'PIN_SALAH');
  }

  const sesi = bacaProp_('SESSIONS', {});
  Object.keys(sesi).forEach(function (t) { if (!(sesi[t].exp > sekarang)) delete sesi[t]; });
  const urut = Object.keys(sesi).sort(function (a, b) { return sesi[a].exp - sesi[b].exp; });
  while (urut.length >= MAKS_SESI) delete sesi[urut.shift()];
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  sesi[token] = { nama: u.nama, exp: sekarang + SESI_MS };
  tulisProp_('SESSIONS', sesi);
  return { nama: u.nama, role: u.role, token: token };
}

function keluar_(d, u) {
  const sesi = bacaProp_('SESSIONS', {});
  delete sesi[u._token];
  tulisProp_('SESSIONS', sesi);
  return true;
}

function authToken_(token) {
  const t = typeof token === 'string' ? token : '';
  const sesi = bacaProp_('SESSIONS', {});
  if (!/^[0-9a-f]{64}$/i.test(t) || !hasOwn_(sesi, t) || !(sesi[t].exp > Date.now())) {
    throw galat_('Sesi berakhir. Masuk lagi dengan PIN.', 'SESI');
  }
  // peran dibaca dari USERS setiap request (bukan dari token), jadi perubahan peran langsung berlaku
  const users = bacaProp_('USERS', {});
  const pin = Object.keys(users).filter(function (p) { return users[p].nama === sesi[t].nama; })[0];
  if (!pin) throw galat_('Sesi berakhir. Masuk lagi dengan PIN.', 'SESI');
  return { nama: users[pin].nama, role: users[pin].role, _token: t };
}

/* ============ BACA ============ */
function getAll_(d, u) {
  const admin = u.role === 'admin';
  const peringatan = [];
  const bersih = function (arr) { return arr.map(function (o) { const c = Object.assign({}, o); delete c._row; return c; }); };
  return {
    user: { nama: u.nama, role: u.role },
    barang: bersih(rows_('Barang', peringatan)),
    penjualan: bersih(rows_('Penjualan', peringatan)),
    kas: bersih(rows_('Kas', peringatan)),
    log: admin ? bersih(logTerakhir_(40)) : [],
    peringatan: admin ? peringatan : []
  };
}

/**
 * Katalog untuk calon pembeli (PUBLIK, tanpa PIN). Hanya barang Tersedia / Dipesan dan hanya kolom aman:
 * kode, nama, kategori, ukuran, kondisi, harga (= target harga jual), foto, status.
 * TIDAK PERNAH: harga_beli, sumber (penjual), catatan, dibuat_oleh, id, tanggal, kas, penjualan.
 * Di-cache TTL_KATALOG detik; dihapus setiap aksi tulis (lihat withLock_).
 */
function katalog_() {
  const cache = CacheService.getScriptCache();
  const c = cache.get('KATALOG');
  if (c) { try { return JSON.parse(c); } catch (e) { /* cache rusak → bangun ulang */ } }
  let baris;
  try { baris = rows_('Barang'); } catch (e) { throw galat_('Katalog sedang tidak tersedia. Coba lagi nanti.', 'KATALOG'); }
  const FOTO_OK = /^https:\/\/drive\.google\.com\/thumbnail\?id=[A-Za-z0-9_-]+&sz=w\d{2,4}$/;
  const item = function (b) {
    const h = Number(b.harga_target);
    return {
      kode: String(b.kode), nama: String(b.nama), kategori: String(b.kategori), ukuran: String(b.ukuran), kondisi: String(b.kondisi),
      harga: isFinite(h) && h > 0 ? Math.floor(h) : 0,
      foto: FOTO_OK.test(String(b.foto)) ? String(b.foto) : '',   // hanya URL thumbnail Drive kita
      status: b.status
    };
  };
  const baru = baris.slice().reverse();                            // terbaru dulu
  const tersedia = baru.filter(function (b) { return b.status === 'Tersedia'; });
  const dipesan = baru.filter(function (b) { return b.status === 'Dipesan'; });
  const hasil = { barang: tersedia.concat(dipesan).slice(0, MAKS_KATALOG).map(item), diperbarui: now_() };
  try { cache.put('KATALOG', JSON.stringify(hasil), TTL_KATALOG); } catch (e) { /* terlalu besar → tanpa cache */ }
  return hasil;
}
function hapusCacheKatalog_() {
  try { CacheService.getScriptCache().remove('KATALOG'); } catch (e) { /* hanya akselerasi */ }
}

function logTerakhir_(n) {
  const last = sheet_('Log').getLastRow();
  return rows_('Log', null, Math.max(2, last - n + 1)).reverse();
}

/* ============ AKSI TULIS ============ */
// Pola tiap aksi: (1) validasi semua input, (2) cek kondisi, (3) simpan file ke Drive, (4) baru tulis sheet.
// Langkah (4) berjalan di bawah transaksi: bila gagal di tengah, tulisan sebelumnya dipulihkan (lihat pulihkan_).

function tambahBarang_(d, u) {
  const staf = u.role !== 'admin';
  const nama = wajib_(d.nama, 'Nama barang', 120);
  const harga = angka_(d.harga_beli, 'Harga beli');
  const target = angka_(kosong_(d.harga_target) ? 0 : d.harga_target, 'Harga target');
  const akun = pilih_(d.akun || 'Tunai', AKUN, 'Akun pembayaran');
  const tgl = tanggal_(d.tgl_beli, 'Tanggal beli');
  const foto = gambar_(d.foto, 'Foto barang');
  const bukti = harga > 0 ? gambar_(d.bukti, 'Bukti pembayaran') : null;
  if (staf && !foto) throw new Error('Foto barang wajib diunggah');
  if (staf && harga > 0 && akun === 'Rekening' && !bukti) throw new Error('Bukti pembayaran wajib diunggah untuk pembelian dari Rekening');

  const k = kodeBerikut_();
  const urlFoto = simpanGambar_(foto, k.kode + '.jpg', true);
  const urlBukti = simpanGambar_(bukti, k.kode + '-bukti-beli.jpg', false);
  const b = {
    id: uid_('B'), kode: k.kode, tgl_beli: tgl, nama: nama,
    kategori: teks_(d.kategori, 60), ukuran: teks_(d.ukuran, 30), kondisi: teks_(d.kondisi, 30), sumber: teks_(d.sumber, 120),
    harga_beli: harga, harga_target: target, foto: urlFoto, status: 'Tersedia', catatan: teks_(d.catatan, 500),
    dibuat_oleh: u.nama, dibuat_pada: now_(), diubah_pada: ''
  };
  append_('Barang', b);
  if (harga > 0) {
    kas_(u, {
      tgl: tgl, jenis: 'Keluar', akun: akun, kategori: 'Pembelian Barang', nominal: harga, ref: k.kode,
      keterangan: 'Beli ' + nama + (b.sumber ? ' dari ' + b.sumber : ''), bukti: urlBukti
    });
  }
  PropertiesService.getScriptProperties().setProperty('SEQ_' + k.ym, String(k.n));
  log_(u, 'Tambah barang', k.kode + ' · ' + nama + ' · Rp' + harga + ' (' + akun + ')');
  return b;
}

function ubahBarang_(d, u) {
  const b = cari_('Barang', 'kode', d.kode);
  if (!b) throw new Error('Barang tidak ditemukan');
  if (b.status === 'Batal') throw new Error('Barang sudah dibatalkan');
  if (d.harga_beli !== undefined && !kosong_(d.harga_beli) && String(d.harga_beli).trim() !== String(b.harga_beli)) {
    throw new Error('Harga beli tidak bisa diubah. Batalkan barangnya (admin), lalu input ulang.');
  }
  const patch = {};
  const batas = { nama: 120, kategori: 60, ukuran: 30, kondisi: 30, sumber: 120, catatan: 500 };
  Object.keys(batas).forEach(function (k) {
    if (d[k] === undefined) return;
    const v = teks_(d[k], batas[k]);
    if (k === 'nama' && !v) throw new Error('Nama barang wajib diisi');
    if (v !== String(b[k])) patch[k] = v;
  });
  if (!kosong_(d.harga_target)) {
    const h = angka_(d.harga_target, 'Harga target');
    if (h !== Number(b.harga_target)) patch.harga_target = h;
  }
  const foto = gambar_(d.foto, 'Foto barang');
  if (foto) patch.foto = simpanGambar_(foto, b.kode + '-' + Date.now() + '.jpg', true);
  if (!Object.keys(patch).length) return b;
  const sebelum = {};
  Object.keys(patch).forEach(function (k) { sebelum[k] = b[k]; });
  patch.diubah_pada = now_();
  update_('Barang', b._row, patch);
  log_(u, 'Ubah barang', { kode: b.kode, sebelum: sebelum, sesudah: patch });
  return Object.assign({}, b, patch);
}

function statusBarang_(d, u) {
  const b = cari_('Barang', 'kode', d.kode);
  if (!b) throw new Error('Barang tidak ditemukan');
  pilih_(d.status, ['Tersedia', 'Rusak'], 'Status');
  if (['Tersedia', 'Rusak'].indexOf(b.status) < 0) throw new Error('Barang berstatus ' + b.status + ', tidak bisa diubah di sini');
  if (b.status === d.status) throw new Error('Barang sudah berstatus ' + d.status);
  const alasan = wajib_(d.alasan, 'Alasan', 200);
  update_('Barang', b._row, { status: d.status, catatan: (b.catatan ? b.catatan + ' | ' : '') + d.status + ': ' + alasan, diubah_pada: now_() });
  log_(u, 'Status barang', b.kode + ' ' + b.status + ' → ' + d.status + ' (' + alasan + ')');
  return true;
}

function tambahPenjualan_(d, u) {
  const staf = u.role !== 'admin';
  const b = cari_('Barang', 'kode', d.kode);
  if (!b) throw new Error('Barang tidak ditemukan');
  if (b.status !== 'Tersedia') throw new Error('Barang ' + b.kode + ' berstatus ' + b.status);
  const metode = pilih_(d.metode, ['Transfer', 'Tunai', 'COD'], 'Metode bayar');
  const harga = angka_(d.harga_jual, 'Harga jual');
  if (harga <= 0) throw new Error('Harga jual harus lebih dari 0');
  const ongkir = angka_(kosong_(d.ongkir) ? 0 : d.ongkir, 'Ongkir');
  const akunOngkir = pilih_(d.akun_ongkir || 'Tunai', AKUN, 'Akun ongkir');
  const tgl = tanggal_(d.tgl, 'Tanggal');
  const bukti = gambar_(d.bukti, 'Bukti');
  const buktiOngkir = ongkir > 0 ? gambar_(d.bukti_ongkir, 'Bukti ongkir') : null;
  if (metode === 'Transfer' && !bukti && staf) throw new Error('Bukti transfer wajib diunggah');
  if (ongkir > 0 && !buktiOngkir && staf) throw new Error('Bukti ongkir wajib diunggah');

  const cod = metode === 'COD';
  const id = uid_('PJ');
  const urlBukti = simpanGambar_(bukti, b.kode + '-jual.jpg', false);
  const urlOngkir = simpanGambar_(buktiOngkir, b.kode + '-ongkir.jpg', false);
  const p = {
    id: id, tgl: tgl, kode: b.kode, pembeli: teks_(d.pembeli, 120), kontak: teks_(d.kontak, 60), kanal: teks_(d.kanal, 40),
    metode: metode, harga_jual: harga, ongkir: ongkir, diterima: cod ? '' : harga,
    status: cod ? 'Menunggu COD' : 'Lunas', tgl_lunas: cod ? '' : tgl, bukti: urlBukti,
    catatan: teks_(d.catatan, 500), dibuat_oleh: u.nama, dibuat_pada: now_()
  };
  append_('Penjualan', p);
  update_('Barang', b._row, { status: cod ? 'Dipesan' : 'Terjual', diubah_pada: now_() });
  if (!cod) {
    kas_(u, { tgl: tgl, jenis: 'Masuk', akun: metode === 'Transfer' ? 'Rekening' : 'Tunai', kategori: 'Penjualan', nominal: harga, ref: id, keterangan: 'Jual ' + b.kode + ' ' + b.nama, bukti: urlBukti });
  }
  if (ongkir > 0) {
    kas_(u, { tgl: tgl, jenis: 'Keluar', akun: akunOngkir, kategori: 'Ongkir', nominal: ongkir, ref: id, keterangan: 'Ongkir ' + b.kode, bukti: urlOngkir });
  }
  log_(u, 'Penjualan', b.kode + ' · ' + metode + ' · Rp' + harga + (cod ? ' (menunggu COD)' : ''));
  return p;
}

function konfirmasiCOD_(d, u) {
  const staf = u.role !== 'admin';
  const p = cari_('Penjualan', 'id', d.id);
  if (!p) throw new Error('Penjualan tidak ditemukan');
  if (p.status !== 'Menunggu COD') throw new Error('Status penjualan: ' + p.status);
  const b = cari_('Barang', 'kode', p.kode);
  const hari = today_();

  if (d.hasil === 'Lunas') {
    const diterima = angka_(d.diterima, 'Uang diterima');
    if (diterima <= 0) throw new Error('Uang diterima harus lebih dari 0. Bila tidak ada uang masuk, pilih Retur.');
    const akun = pilih_(d.akun || 'Rekening', AKUN, 'Akun');
    const bukti = gambar_(d.bukti, 'Bukti pencairan COD');
    if (!bukti && staf) throw new Error('Bukti pencairan COD wajib diunggah');
    const url = simpanGambar_(bukti, p.kode + '-cod.jpg', false);
    update_('Penjualan', p._row, { status: 'Lunas', diterima: diterima, tgl_lunas: hari, bukti: url || p.bukti });
    if (b) update_('Barang', b._row, { status: 'Terjual', diubah_pada: now_() });
    kas_(u, { tgl: hari, jenis: 'Masuk', akun: akun, kategori: 'Penjualan', nominal: diterima, ref: p.id, keterangan: 'COD cair ' + p.kode, bukti: url || p.bukti });
    log_(u, 'COD lunas', p.kode + ' · diterima Rp' + diterima + ' dari harga Rp' + p.harga_jual);
  } else if (d.hasil === 'Retur') {
    const biaya = angka_(kosong_(d.biaya_retur) ? 0 : d.biaya_retur, 'Biaya retur');
    const alasan = wajib_(d.alasan, 'Alasan retur', 200);
    const akun = pilih_(d.akun || 'Tunai', AKUN, 'Akun');
    const bukti = biaya > 0 ? gambar_(d.bukti, 'Bukti biaya retur') : null;
    if (biaya > 0 && !bukti && staf) throw new Error('Bukti biaya retur wajib diunggah');
    const url = simpanGambar_(bukti, p.kode + '-retur.jpg', false);
    update_('Penjualan', p._row, { status: 'Retur', diterima: 0, catatan: (p.catatan ? p.catatan + ' | ' : '') + 'Retur: ' + alasan });
    if (b) update_('Barang', b._row, { status: 'Tersedia', diubah_pada: now_() });
    if (biaya > 0) {
      kas_(u, { tgl: hari, jenis: 'Keluar', akun: akun, kategori: 'Ongkir', nominal: biaya, ref: p.id, keterangan: 'Biaya retur ' + p.kode, bukti: url });
    }
    log_(u, 'COD retur', p.kode + ' · ' + alasan + (biaya ? ' · biaya Rp' + biaya : ''));
  } else {
    throw new Error('Hasil harus Lunas atau Retur');
  }
  return true;
}

function tambahKas_(d, u) {
  const staf = u.role !== 'admin';
  const nominal = angka_(d.nominal, 'Nominal');
  if (nominal <= 0) throw new Error('Nominal harus lebih dari 0');
  const tgl = tanggal_(d.tgl, 'Tanggal');
  const ket = wajib_(d.keterangan, 'Keterangan', 200);

  let rencana;   // divalidasi dulu SEBELUM file disimpan
  if (d.jenis === 'Pindah') {
    const dari = pilih_(d.dari, AKUN, 'Dari akun');
    const ke = pilih_(d.ke, AKUN, 'Ke akun');
    if (dari === ke) throw new Error('Akun asal dan tujuan sama');
    rencana = { pindah: true, dari: dari, ke: ke, label: 'pemindahan saldo' };
  } else {
    const jenis = pilih_(d.jenis, ['Masuk', 'Keluar'], 'Jenis');
    const akun = pilih_(d.akun, AKUN, 'Akun');
    const kategori = pilih_(d.kategori, KATEGORI_KAS[jenis].concat(staf ? [] : ['Penyesuaian']), 'Kategori');
    rencana = { jenis: jenis, akun: akun, kategori: kategori, label: jenis === 'Keluar' ? 'pengeluaran' : 'pemasukan' };
  }
  const bukti = gambar_(d.bukti, 'Bukti');
  if (!bukti && staf) throw new Error('Bukti ' + rencana.label + ' wajib diunggah');
  const url = simpanGambar_(bukti, 'kas-' + Date.now() + '.jpg', false);

  if (rencana.pindah) {
    const ref = uid_('PD');
    kas_(u, { tgl: tgl, jenis: 'Keluar', akun: rencana.dari, kategori: 'Pindah Saldo', nominal: nominal, ref: ref, keterangan: ket, bukti: url });
    kas_(u, { tgl: tgl, jenis: 'Masuk', akun: rencana.ke, kategori: 'Pindah Saldo', nominal: nominal, ref: ref, keterangan: ket, bukti: url });
    log_(u, 'Pindah saldo', rencana.dari + ' → ' + rencana.ke + ' Rp' + nominal);
    return true;
  }
  kas_(u, { tgl: tgl, jenis: rencana.jenis, akun: rencana.akun, kategori: rencana.kategori, nominal: nominal, keterangan: ket, bukti: url });
  log_(u, 'Kas ' + rencana.jenis, rencana.kategori + ' · ' + rencana.akun + ' · Rp' + nominal + ' · ' + ket);
  return true;
}

/** Hanya admin. Tidak ada hapus baris: semua pembatalan tercatat. */
function batalkan_(d, u) {
  if (u.role !== 'admin') throw new Error('Hanya admin yang bisa membatalkan');
  const alasan = wajib_(d.alasan, 'Alasan', 200);
  const tag = ' [BATAL: ' + alasan + ']';

  if (d.jenis === 'Kas') {
    const k = cari_('Kas', 'id', d.id);
    if (!k || k.status === 'Batal') throw new Error('Transaksi tidak ditemukan / sudah batal');
    if (k.ref && k.kategori !== 'Pindah Saldo') throw new Error('Transaksi ini terhubung ke ' + k.ref + '. Batalkan dari barang/penjualannya.');
    if (k.kategori === 'Pindah Saldo') batalKasRef_(k.ref, tag);
    else update_('Kas', k._row, { status: 'Batal', keterangan: k.keterangan + tag });
    log_(u, 'Batal kas', k.id + ' · ' + alasan);
  } else if (d.jenis === 'Penjualan') {
    const p = cari_('Penjualan', 'id', d.id);
    if (!p || p.status === 'Batal') throw new Error('Penjualan tidak ditemukan / sudah batal');
    // Hanya penjualan yang MASIH AKTIF (Lunas / Menunggu COD) yang memegang status barang. Penjualan Retur sudah
    // melepas barangnya; membatalkannya tidak boleh menyentuh barang yang mungkin sudah dijual ulang.
    const aktif = p.status === 'Lunas' || p.status === 'Menunggu COD';
    update_('Penjualan', p._row, { status: 'Batal', catatan: p.catatan + tag });
    if (aktif) {
      const b = cari_('Barang', 'kode', p.kode);
      if (b && (b.status === 'Terjual' || b.status === 'Dipesan')) update_('Barang', b._row, { status: 'Tersedia', diubah_pada: now_() });
    }
    batalKasRef_(p.id, tag);
    log_(u, 'Batal penjualan', p.id + ' (' + p.kode + ') · ' + alasan);
  } else if (d.jenis === 'Barang') {
    const b = cari_('Barang', 'kode', d.id);
    if (!b || b.status === 'Batal') throw new Error('Barang tidak ditemukan / sudah batal');
    if (b.status === 'Terjual' || b.status === 'Dipesan') throw new Error('Batalkan penjualannya dulu');
    update_('Barang', b._row, { status: 'Batal', catatan: b.catatan + tag, diubah_pada: now_() });
    batalKasRef_(b.kode, tag);
    log_(u, 'Batal barang', b.kode + ' · ' + alasan);
  } else {
    throw new Error('Jenis pembatalan tidak dikenal');
  }
  return true;
}

/* ============ KUNCI, IDEMPOTENSI, TRANSAKSI ============ */
function kunci_(fn) {
  return function (d, u) {
    const lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (e) { throw galat_('Server sedang sibuk. Coba lagi sebentar lagi.', 'SIBUK'); }
    try { return fn(d, u); } finally { lock.releaseLock(); }
  };
}

/**
 * Bungkus aksi tulis: lock + idempotensi (rid) + transaksi.
 * - rid sama dikirim lagi (mis. retry setelah timeout) → hasil lama dikembalikan, tidak ditulis ulang.
 * - Gagal di tengah → tulisan sebelumnya dipulihkan otomatis oleh SISTEM dan dicatat di Log.
 */
function withLock_(fn) {
  return kunci_(function (d, u) {
    const rid = ridDari_(d);
    if (rid) {
      const ada = ridSudah_(rid);
      if (ada) return ada.data;
    }
    CTX_ = { rid: rid, ops: [] };
    let hasil;
    try {
      hasil = fn(d, u);
      hapusCacheKatalog_();
    } catch (err) {
      const ops = CTX_.ops;
      CTX_ = null;
      pulihkan_(ops, err, u);
      hapusCacheKatalog_();
      throw err;
    } finally {
      CTX_ = null;
    }
    if (rid) simpanRid_(rid, hasil);
    return hasil;
  });
}

function ridDari_(d) {
  return typeof d.rid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(d.rid) ? d.rid : '';
}
function ridSudah_(rid) {
  const c = CacheService.getScriptCache().get('RID_' + rid);
  if (c) { try { return { data: JSON.parse(c).v }; } catch (e) { /* cache rusak → cek Log */ } }
  const s = sheet_('Log'), kol = SHEETS.Log.indexOf('req_id') + 1;
  const last = s.getLastRow();
  if (last < 2) return null;
  const mulai = Math.max(2, last - 299);
  const v = s.getRange(mulai, kol, last - mulai + 1, 1).getValues();
  for (let i = 0; i < v.length; i++) if (String(v[i][0]) === rid) return { data: { duplikat: true } };
  return null;
}
function simpanRid_(rid, hasil) {
  try { CacheService.getScriptCache().put('RID_' + rid, JSON.stringify({ v: hasil }), 21600); } catch (e) { /* hanya akselerasi */ }
}

/** Urungkan tulisan sebuah aksi yang gagal. Baris baru → Batal (tidak dihapus); baris yang diubah → nilai lama dikembalikan. */
function pulihkan_(ops, err, u) {
  if (!ops.length) return;
  let ok = 0, gagal = 0;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    try {
      if (op.t === 'ubah') {
        update_(op.name, op.row, op.prev);
      } else if (op.name !== 'Log') {
        const kolomTeks = op.name === 'Kas' ? 'keterangan' : 'catatan';
        const sekarang = String(sheet_(op.name).getRange(op.row, SHEETS[op.name].indexOf(kolomTeks) + 1).getValue());
        const patch = { status: 'Batal' };
        patch[kolomTeks] = sekarang + ' [BATAL OTOMATIS: ' + err.message + ']';
        update_(op.name, op.row, patch);
      }
      ok++;
    } catch (e) { gagal++; }
  }
  try {
    logSistem_('Rollback otomatis', 'aksi ' + u.nama + ' gagal: ' + err.message + ' · ' + ok + ' langkah dipulihkan' + (gagal ? ', ' + gagal + ' gagal dipulihkan (PERIKSA DATA)' : ''));
  } catch (e) { /* tidak ada yang bisa dilakukan lagi */ }
  err.message += gagal
    ? ' (Sebagian perubahan GAGAL dipulihkan. Hubungi admin untuk memeriksa sheet Log.)'
    : ' (perubahan yang sempat tertulis telah dibatalkan otomatis)';
}

/* ============ HELPER SHEET ============ */
function sheet_(name) {
  const s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw new Error('Sheet "' + name + '" tidak ada. Jalankan setup() dulu.');
  return s;
}

function rows_(name, peringatan, dariBaris) {
  const s = sheet_(name), head = SHEETS[name];
  const last = s.getLastRow(), mulai = Math.max(2, dariBaris || 2);
  if (last < mulai) return [];
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone() || TZ;
  const v = s.getRange(mulai, 1, last - mulai + 1, head.length).getValues();
  const out = [];
  v.forEach(function (r, i) {
    if (r[0] === '' || r[0] === null || r[0] === undefined) return;
    const o = { _row: mulai + i };
    head.forEach(function (k, j) { o[k] = nilai_(r[j], k, tz, peringatan, name + ' ' + r[0]); });
    out.push(o);
  });
  return out;
}

function nilai_(v, kolom, tz, peringatan, ket) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) {
    // Date dari Sheets mewakili jam dinding di zona waktu SPREADSHEET, bukan zona waktu skrip.
    if (peringatan && !KOLOM_TANGGAL[kolom] && !/_pada$|^waktu$/.test(kolom)) {
      peringatan.push(ket + ': kolom ' + kolom + ' berisi tanggal (kemungkinan diubah otomatis oleh Sheets); periksa isinya.');
    }
    return Utilities.formatDate(v, tz, KOLOM_TANGGAL[kolom] ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm');
  }
  if (KOLOM_ANGKA[kolom] && typeof v !== 'number' && v !== '') {
    const n = parseAngka_(v);
    if (n === null) {
      if (peringatan) peringatan.push(ket + ': kolom ' + kolom + ' tidak terbaca ("' + String(v).slice(0, 30) + '"); perbaiki langsung di Sheet atau batalkan.');
      return v;
    }
    return n;
  }
  return v;
}

/** Angka yang tersimpan sebagai teks: "50000", "50.000", "Rp 1.250.000", "50,000". null bila tak terbaca. */
function parseAngka_(v) {
  const s = String(v).trim().replace(/^rp\.?\s*/i, '').replace(/\s/g, '');
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  if (/^-?\d+[.,]\d+$/.test(s)) return Number(s.replace(',', '.'));
  return null;
}

function formatBaris_(name) {
  return SHEETS[name].map(function (k) { return KOLOM_ANGKA[k] ? FORMAT_ANGKA : '@'; });
}

function append_(name, obj) {
  const s = sheet_(name), head = SHEETS[name];
  const row = s.getLastRow() + 1;
  if (row > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), Math.max(200, row - s.getMaxRows()));
  const rg = s.getRange(row, 1, 1, head.length);
  rg.setNumberFormats([formatBaris_(name)]);     // format DULU, baru nilai: teks "2-3" / "=..." tetap teks
  rg.setValues([head.map(function (k) { return obj[k] === undefined ? '' : obj[k]; })]);
  if (CTX_) CTX_.ops.push({ t: 'tambah', name: name, row: row });
  return row;
}

function update_(name, row, patch) {
  const s = sheet_(name), head = SHEETS[name];
  const rg = s.getRange(row, 1, 1, head.length);
  const cur = rg.getValues()[0];
  const prev = {};
  Object.keys(patch).forEach(function (k) {
    const c = head.indexOf(k);
    if (c < 0) return;
    prev[k] = cur[c];
    cur[c] = patch[k];
  });
  rg.setNumberFormats([formatBaris_(name)]);
  rg.setValues([cur]);                            // satu penulisan per baris
  if (CTX_) CTX_.ops.push({ t: 'ubah', name: name, row: row, prev: prev });
}

function cari_(name, key, val) {
  if (val === undefined || val === null || String(val) === '') return undefined;
  return rows_(name).filter(function (r) { return String(r[key]) === String(val); })[0];
}

function kas_(u, k) {
  const row = Object.assign({ id: uid_('K'), ref: '', bukti: '', status: 'Aktif', dibuat_oleh: u.nama, dibuat_pada: now_() }, k);
  append_('Kas', row);
  return row;
}

function batalKasRef_(ref, tag) {
  rows_('Kas').forEach(function (k) {
    if (String(k.ref) === String(ref) && k.status !== 'Batal') update_('Kas', k._row, { status: 'Batal', keterangan: k.keterangan + tag });
  });
}

function log_(u, aksi, detail) {
  append_('Log', {
    waktu: now_(), user: u.nama, aksi: aksi,
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    req_id: CTX_ && CTX_.rid ? CTX_.rid : ''
  });
}
function logSistem_(aksi, detail) {
  append_('Log', { waktu: now_(), user: 'SISTEM', aksi: aksi, detail: detail, req_id: '' });
}

/** Kode berikutnya TR<yyMM>-<nnn>. Diturunkan dari properti urutan DAN isi sheet, jadi tidak pernah kembar. */
function kodeBerikut_() {
  const ym = Utilities.formatDate(new Date(), TZ, 'yyMM');
  let n = Number(PropertiesService.getScriptProperties().getProperty('SEQ_' + ym) || 0);
  const re = /^TR(\d{4})-(\d+)$/;
  rows_('Barang').forEach(function (b) {
    const m = re.exec(String(b.kode));
    if (m && m[1] === ym && Number(m[2]) > n) n = Number(m[2]);
  });
  n += 1;
  return { kode: 'TR' + ym + '-' + String(n).padStart(3, '0'), ym: ym, n: n };
}

/* ============ FILE (Drive) ============ */
/** Validasi data-URL gambar. Mengembalikan {mime, bytes} atau null bila kosong; melempar error bila tidak valid. */
function gambar_(dataUrl, label) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+\/]+={0,2})$/.exec(String(dataUrl).replace(/\s/g, ''));
  if (!m) throw new Error('Format gambar tidak valid (' + (label || 'gambar') + '). Gunakan JPEG, PNG, atau WebP.');
  if (m[2].length > Math.ceil(MAKS_FILE * 4 / 3) + 8) throw new Error('Ukuran gambar terlalu besar (maks 4 MB)');
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > MAKS_FILE) throw new Error('Ukuran gambar terlalu besar (maks 4 MB)');
  if (jenisGambar_(bytes) !== m[1]) throw new Error('Format gambar tidak valid (' + (label || 'gambar') + '): isi file tidak cocok dengan jenisnya.');
  return { mime: m[1], bytes: bytes };
}
function jenisGambar_(b) {
  const x = function (i) { return (b[i] || 0) & 0xFF; };   // byte Apps Script bertanda (-128..127)
  if (x(0) === 0xFF && x(1) === 0xD8 && x(2) === 0xFF) return 'image/jpeg';
  if (x(0) === 0x89 && x(1) === 0x50 && x(2) === 0x4E && x(3) === 0x47) return 'image/png';
  if (x(0) === 0x52 && x(1) === 0x49 && x(2) === 0x46 && x(3) === 0x46 && x(8) === 0x57 && x(9) === 0x45 && x(10) === 0x42 && x(11) === 0x50) return 'image/webp';
  return null;
}

/** Foto barang → folder foto, dibagikan via link (untuk katalog). Bukti transaksi → folder bukti, TIDAK dibagikan. */
function simpanGambar_(g, nama, publik) {
  if (!g) return '';
  const folder = publik ? folderFoto_() : folderBukti_();
  const f = folder.createFile(Utilities.newBlob(g.bytes, g.mime, nama));
  if (publik) {
    try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
    catch (e) { throw new Error('Foto tidak bisa dibagikan via link (kebijakan Google Drive/Workspace?): ' + e.message); }
    return 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w800';
  }
  return 'https://drive.google.com/file/d/' + f.getId() + '/view';
}
function folderBukti_() {
  const id = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!id) throw new Error('Folder bukti belum dibuat. Jalankan setup() dari editor Apps Script.');
  return DriveApp.getFolderById(id);
}
function folderFoto_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('FOLDER_FOTO_ID');
  if (!id) { id = DriveApp.createFolder('Tripting - Foto barang').getId(); props.setProperty('FOLDER_FOTO_ID', id); }
  return DriveApp.getFolderById(id);
}

/* ============ VALIDASI & UTIL ============ */
function hasOwn_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function galat_(pesan, kode) { const e = new Error(pesan); e.code = kode || ''; return e; }
function bacaProp_(k, def) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) return def;
  try { return JSON.parse(v); } catch (e) { return def; }
}
function tulisProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, JSON.stringify(v)); }

function kosong_(v) { return v === undefined || v === null || String(v).trim() === ''; }
function teks_(v, maks) { return (v === undefined || v === null ? '' : String(v)).trim().slice(0, maks || 200); }
function wajib_(v, label, maks) {
  if (kosong_(v)) throw new Error(label + ' wajib diisi');
  return teks_(v, maks || 200);
}
/** Rupiah: bilangan bulat saja. "50.000" / "50,5" / 50.5 ditolak (bukan ditebak) agar tidak jadi Rp50 atau Rp51. */
function angka_(v, label) {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\d{1,12}$/.test(v.trim())) n = Number(v.trim());
  if (!isFinite(n) || n < 0 || Math.floor(n) !== n) throw new Error(label + ' harus berupa angka bulat tanpa titik/koma (contoh: 50000)');
  if (n > MAKS_RP) throw new Error(label + ' terlalu besar');
  return n;
}
function pilih_(v, daftar, label) {
  if (daftar.indexOf(v) < 0) throw new Error(label + ' tidak valid');
  return v;
}
/** Tanggal 'YYYY-MM-DD' yang nyata; kosong → hari ini (WIB). Tidak boleh sebelum 2020 atau lebih dari besok. */
function tanggal_(v, label) {
  if (kosong_(v)) return today_();
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const salah = new Error(label + ' tidak valid (format YYYY-MM-DD, tidak di masa depan)');
  if (!m) throw salah;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (dt.getUTCFullYear() !== Number(m[1]) || dt.getUTCMonth() !== Number(m[2]) - 1 || dt.getUTCDate() !== Number(m[3])) throw salah;
  if (s < '2020-01-01' || s > Utilities.formatDate(new Date(Date.now() + 86400000), TZ, 'yyyy-MM-dd')) throw salah;
  return s;
}
function uid_(p) { return p + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase(); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
