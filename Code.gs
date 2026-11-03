/**
 * TRIPTING — Backend (Google Apps Script, terikat ke Google Sheet)
 * Pasang: Ekstensi > Apps Script > tempel file ini > jalankan setup() sekali.
 * Lihat README.md untuk langkah lengkap.
 */

const TZ = 'Asia/Jakarta';

const SHEETS = {
  Barang: ['id', 'kode', 'tgl_beli', 'nama', 'kategori', 'ukuran', 'kondisi', 'sumber', 'harga_beli', 'harga_target', 'foto', 'status', 'catatan', 'dibuat_oleh', 'dibuat_pada', 'diubah_pada'],
  Penjualan: ['id', 'tgl', 'kode', 'pembeli', 'kontak', 'kanal', 'metode', 'harga_jual', 'ongkir', 'diterima', 'status', 'tgl_lunas', 'bukti', 'catatan', 'dibuat_oleh', 'dibuat_pada'],
  Kas: ['id', 'tgl', 'jenis', 'akun', 'kategori', 'nominal', 'ref', 'keterangan', 'bukti', 'status', 'dibuat_oleh', 'dibuat_pada'],
  Log: ['waktu', 'user', 'aksi', 'detail']
};

const AKUN = ['Tunai', 'Rekening'];
const KATEGORI_KAS = {
  Masuk: ['Setoran Modal', 'Pemasukan Lain'],
  Keluar: ['Operasional', 'Ongkir', 'Upah', 'Setor ke Pemilik', 'Pengeluaran Lain']
};

/* ============ SETUP (jalankan sekali dari editor) ============ */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (name) {
    let s = ss.getSheetByName(name) || ss.insertSheet(name);
    const head = SHEETS[name];
    s.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    s.setFrozenRows(1);
    head.forEach(function (h, i) {
      // kolom teks agar tanggal/kode/no HP tidak diubah otomatis oleh Sheets
      if (/^(id|kode|ref|tgl|kontak)|_pada$|^waktu$/.test(h)) {
        s.getRange(1, i + 1, s.getMaxRows(), 1).setNumberFormat('@');
      }
    });
  });
  ['Sheet1', 'Lembar1', 'Sheet 1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FOLDER_ID')) {
    props.setProperty('FOLDER_ID', DriveApp.createFolder('Tripting - Foto & Bukti').getId());
  }
  if (!props.getProperty('USERS')) {
    const users = {};
    users[pin6_()] = { nama: 'Eri', role: 'admin' };
    let p = pin6_();
    while (users[p]) p = pin6_();
    users[p] = { nama: 'Deni', role: 'staf' };
    props.setProperty('USERS', JSON.stringify(users));
  }
  const users = JSON.parse(props.getProperty('USERS'));
  Object.keys(users).forEach(function (pin) {
    Logger.log(users[pin].nama + ' (' + users[pin].role + ') → PIN: ' + pin);
  });
}

function pin6_() { return String(Math.floor(100000 + Math.random() * 900000)); }

/* ============ API ============ */
function doGet() {
  return ContentService.createTextOutput('Tripting API aktif.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const user = auth_(req.pin);
    const fn = ACTIONS[req.action];
    if (!fn) throw new Error('Aksi tidak dikenal: ' + req.action);
    out = { ok: true, data: fn(req.data || {}, user) };
  } catch (err) {
    out = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function auth_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('FAILS') || 0);
  if (fails >= 20) throw new Error('Terlalu banyak percobaan PIN salah. Coba lagi 15 menit lagi.');
  const users = JSON.parse(PropertiesService.getScriptProperties().getProperty('USERS') || '{}');
  const u = users[String(pin || '')];
  if (!u) {
    cache.put('FAILS', String(fails + 1), 900);
    throw new Error('PIN salah');
  }
  return u;
}

const ACTIONS = {
  login: function (d, u) { return { nama: u.nama, role: u.role }; },
  getAll: function (d, u) {
    return {
      user: { nama: u.nama, role: u.role },
      barang: rows_('Barang'),
      penjualan: rows_('Penjualan'),
      kas: rows_('Kas'),
      log: u.role === 'admin' ? rows_('Log').slice(-40).reverse() : []
    };
  },
  tambahBarang: withLock_(tambahBarang_),
  ubahBarang: withLock_(ubahBarang_),
  statusBarang: withLock_(statusBarang_),
  tambahPenjualan: withLock_(tambahPenjualan_),
  konfirmasiCOD: withLock_(konfirmasiCOD_),
  tambahKas: withLock_(tambahKas_),
  batalkan: withLock_(batalkan_)
};

/* ============ AKSI ============ */
function tambahBarang_(d, u) {
  const nama = wajib_(d.nama, 'Nama barang');
  const harga = angka_(d.harga_beli, 'Harga beli');
  const akun = pilih_(d.akun || 'Tunai', AKUN, 'Akun pembayaran');
  if (u.role !== 'admin' && !d.foto) throw new Error('Foto barang wajib diunggah');
  const kode = nextKode_();
  const b = {
    id: uid_('B'), kode: kode, tgl_beli: d.tgl_beli || today_(), nama: nama,
    kategori: d.kategori || '', ukuran: d.ukuran || '', kondisi: d.kondisi || '', sumber: d.sumber || '',
    harga_beli: harga, harga_target: angka_(d.harga_target || 0, 'Harga target'),
    foto: simpanFile_(d.foto, kode + '.jpg', true), status: 'Tersedia', catatan: d.catatan || '',
    dibuat_oleh: u.nama, dibuat_pada: now_(), diubah_pada: ''
  };
  append_('Barang', b);
  if (harga > 0) {
    kas_(u, {
      tgl: b.tgl_beli, jenis: 'Keluar', akun: akun, kategori: 'Pembelian Barang', nominal: harga, ref: kode,
      keterangan: 'Beli ' + nama + (b.sumber ? ' dari ' + b.sumber : ''),
      bukti: simpanFile_(d.bukti, kode + '-bukti-beli.jpg', false)
    });
  }
  log_(u, 'Tambah barang', kode + ' · ' + nama + ' · Rp' + harga + ' (' + akun + ')');
  return b;
}

function ubahBarang_(d, u) {
  const b = cari_('Barang', 'kode', d.kode);
  if (!b) throw new Error('Barang tidak ditemukan');
  if (b.status === 'Batal') throw new Error('Barang sudah dibatalkan');
  const patch = {};
  ['nama', 'kategori', 'ukuran', 'kondisi', 'sumber', 'harga_target', 'catatan'].forEach(function (k) {
    if (d[k] !== undefined && String(d[k]) !== String(b[k])) {
      patch[k] = k === 'harga_target' ? angka_(d[k], 'Harga target') : d[k];
    }
  });
  if (d.foto) patch.foto = simpanFile_(d.foto, b.kode + '-' + Date.now() + '.jpg', true);
  if (!Object.keys(patch).length) return b;
  const sebelum = {};
  Object.keys(patch).forEach(function (k) { sebelum[k] = b[k]; });
  patch.diubah_pada = now_();
  update_('Barang', b._row, patch);
  log_(u, 'Ubah barang', { kode: b.kode, sebelum: sebelum, sesudah: patch });
  return Object.assign(b, patch);
}

function statusBarang_(d, u) {
  const b = cari_('Barang', 'kode', d.kode);
  if (!b) throw new Error('Barang tidak ditemukan');
  pilih_(d.status, ['Tersedia', 'Rusak'], 'Status');
  if (['Tersedia', 'Rusak'].indexOf(b.status) < 0) throw new Error('Barang berstatus ' + b.status + ', tidak bisa diubah di sini');
  const alasan = wajib_(d.alasan, 'Alasan');
  update_('Barang', b._row, { status: d.status, catatan: (b.catatan ? b.catatan + ' | ' : '') + d.status + ': ' + alasan, diubah_pada: now_() });
  log_(u, 'Status barang', b.kode + ' ' + b.status + ' → ' + d.status + ' (' + alasan + ')');
  return true;
}

function tambahPenjualan_(d, u) {
  const b = cari_('Barang', 'kode', d.kode);
  if (!b) throw new Error('Barang tidak ditemukan');
  if (b.status !== 'Tersedia') throw new Error('Barang ' + b.kode + ' berstatus ' + b.status);
  const metode = pilih_(d.metode, ['Transfer', 'Tunai', 'COD'], 'Metode bayar');
  const harga = angka_(d.harga_jual, 'Harga jual');
  if (harga <= 0) throw new Error('Harga jual harus lebih dari 0');
  const ongkir = angka_(d.ongkir || 0, 'Ongkir');
  const akunOngkir = pilih_(d.akun_ongkir || 'Tunai', AKUN, 'Akun ongkir');
  const id = uid_('PJ');
  const bukti = simpanFile_(d.bukti, b.kode + '-jual.jpg', false);
  if (metode === 'Transfer' && !bukti && u.role !== 'admin') throw new Error('Bukti transfer wajib diunggah');
  const cod = metode === 'COD';
  const tgl = d.tgl || today_();
  const p = {
    id: id, tgl: tgl, kode: b.kode, pembeli: d.pembeli || '', kontak: d.kontak || '', kanal: d.kanal || '',
    metode: metode, harga_jual: harga, ongkir: ongkir, diterima: cod ? '' : harga,
    status: cod ? 'Menunggu COD' : 'Lunas', tgl_lunas: cod ? '' : tgl, bukti: bukti,
    catatan: d.catatan || '', dibuat_oleh: u.nama, dibuat_pada: now_()
  };
  append_('Penjualan', p);
  update_('Barang', b._row, { status: cod ? 'Dipesan' : 'Terjual', diubah_pada: now_() });
  if (!cod) {
    kas_(u, { tgl: tgl, jenis: 'Masuk', akun: metode === 'Transfer' ? 'Rekening' : 'Tunai', kategori: 'Penjualan', nominal: harga, ref: id, keterangan: 'Jual ' + b.kode + ' ' + b.nama, bukti: bukti });
  }
  if (ongkir > 0) {
    kas_(u, { tgl: tgl, jenis: 'Keluar', akun: akunOngkir, kategori: 'Ongkir', nominal: ongkir, ref: id, keterangan: 'Ongkir ' + b.kode });
  }
  log_(u, 'Penjualan', b.kode + ' · ' + metode + ' · Rp' + harga + (cod ? ' (menunggu COD)' : ''));
  return p;
}

function konfirmasiCOD_(d, u) {
  const p = cari_('Penjualan', 'id', d.id);
  if (!p) throw new Error('Penjualan tidak ditemukan');
  if (p.status !== 'Menunggu COD') throw new Error('Status penjualan: ' + p.status);
  const b = cari_('Barang', 'kode', p.kode);
  if (d.hasil === 'Lunas') {
    const diterima = angka_(d.diterima, 'Uang diterima');
    const akun = pilih_(d.akun || 'Rekening', AKUN, 'Akun');
    const bukti = simpanFile_(d.bukti, p.kode + '-cod.jpg', false);
    if (!bukti && u.role !== 'admin') throw new Error('Bukti pencairan COD wajib diunggah');
    update_('Penjualan', p._row, { status: 'Lunas', diterima: diterima, tgl_lunas: today_(), bukti: bukti || p.bukti });
    if (b) update_('Barang', b._row, { status: 'Terjual', diubah_pada: now_() });
    kas_(u, { tgl: today_(), jenis: 'Masuk', akun: akun, kategori: 'Penjualan', nominal: diterima, ref: p.id, keterangan: 'COD cair ' + p.kode, bukti: bukti });
    log_(u, 'COD lunas', p.kode + ' · diterima Rp' + diterima + ' dari harga Rp' + p.harga_jual);
  } else if (d.hasil === 'Retur') {
    const biaya = angka_(d.biaya_retur || 0, 'Biaya retur');
    const alasan = wajib_(d.alasan, 'Alasan retur');
    update_('Penjualan', p._row, { status: 'Retur', diterima: 0, catatan: (p.catatan ? p.catatan + ' | ' : '') + 'Retur: ' + alasan });
    if (b) update_('Barang', b._row, { status: 'Tersedia', diubah_pada: now_() });
    if (biaya > 0) {
      kas_(u, { tgl: today_(), jenis: 'Keluar', akun: pilih_(d.akun || 'Tunai', AKUN, 'Akun'), kategori: 'Ongkir', nominal: biaya, ref: p.id, keterangan: 'Biaya retur ' + p.kode });
    }
    log_(u, 'COD retur', p.kode + ' · ' + alasan + (biaya ? ' · biaya Rp' + biaya : ''));
  } else {
    throw new Error('Hasil harus Lunas atau Retur');
  }
  return true;
}

function tambahKas_(d, u) {
  const nominal = angka_(d.nominal, 'Nominal');
  if (nominal <= 0) throw new Error('Nominal harus lebih dari 0');
  const tgl = d.tgl || today_();
  const ket = wajib_(d.keterangan, 'Keterangan');
  const bukti = simpanFile_(d.bukti, 'kas-' + Date.now() + '.jpg', false);

  if (d.jenis === 'Pindah') {
    const dari = pilih_(d.dari, AKUN, 'Dari akun');
    const ke = pilih_(d.ke, AKUN, 'Ke akun');
    if (dari === ke) throw new Error('Akun asal dan tujuan sama');
    const ref = uid_('PD');
    kas_(u, { tgl: tgl, jenis: 'Keluar', akun: dari, kategori: 'Pindah Saldo', nominal: nominal, ref: ref, keterangan: ket, bukti: bukti });
    kas_(u, { tgl: tgl, jenis: 'Masuk', akun: ke, kategori: 'Pindah Saldo', nominal: nominal, ref: ref, keterangan: ket, bukti: bukti });
    log_(u, 'Pindah saldo', dari + ' → ' + ke + ' Rp' + nominal);
    return true;
  }

  const jenis = pilih_(d.jenis, ['Masuk', 'Keluar'], 'Jenis');
  const akun = pilih_(d.akun, AKUN, 'Akun');
  const daftar = KATEGORI_KAS[jenis].concat(u.role === 'admin' ? ['Penyesuaian'] : []);
  const kategori = pilih_(d.kategori, daftar, 'Kategori');
  if (jenis === 'Keluar' && !bukti && u.role !== 'admin') throw new Error('Bukti pengeluaran wajib diunggah');
  kas_(u, { tgl: tgl, jenis: jenis, akun: akun, kategori: kategori, nominal: nominal, keterangan: ket, bukti: bukti });
  log_(u, 'Kas ' + jenis, kategori + ' · ' + akun + ' · Rp' + nominal + ' · ' + ket);
  return true;
}

/** Hanya admin. Tidak ada hapus baris: semua pembatalan tercatat. */
function batalkan_(d, u) {
  if (u.role !== 'admin') throw new Error('Hanya admin yang bisa membatalkan');
  const alasan = wajib_(d.alasan, 'Alasan');
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
    update_('Penjualan', p._row, { status: 'Batal', catatan: p.catatan + tag });
    const b = cari_('Barang', 'kode', p.kode);
    if (b && (b.status === 'Terjual' || b.status === 'Dipesan')) update_('Barang', b._row, { status: 'Tersedia', diubah_pada: now_() });
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

/* ============ HELPER ============ */
function withLock_(fn) {
  return function (d, u) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { return fn(d, u); } finally { lock.releaseLock(); }
  };
}
function sheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }
function rows_(name) {
  const v = sheet_(name).getDataRange().getValues();
  const h = v.shift();
  const out = [];
  v.forEach(function (r, i) {
    if (r[0] === '' || r[0] === null) return;
    const o = { _row: i + 2 };
    h.forEach(function (k, j) {
      o[k] = r[j] instanceof Date ? Utilities.formatDate(r[j], TZ, 'yyyy-MM-dd HH:mm') : r[j];
    });
    out.push(o);
  });
  return out;
}
function append_(name, obj) {
  sheet_(name).appendRow(SHEETS[name].map(function (k) { return obj[k] === undefined ? '' : obj[k]; }));
}
function update_(name, row, patch) {
  const h = SHEETS[name], s = sheet_(name);
  Object.keys(patch).forEach(function (k) {
    const c = h.indexOf(k);
    if (c >= 0) s.getRange(row, c + 1).setValue(patch[k]);
  });
}
function cari_(name, key, val) {
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
  append_('Log', { waktu: now_(), user: u.nama, aksi: aksi, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
}
function nextKode_() {
  const props = PropertiesService.getScriptProperties();
  const ym = Utilities.formatDate(new Date(), TZ, 'yyMM');
  const n = Number(props.getProperty('SEQ_' + ym) || 0) + 1;
  props.setProperty('SEQ_' + ym, String(n));
  return 'TR' + ym + '-' + String(n).padStart(3, '0');
}
/** Foto barang dibagikan via link (untuk katalog). Bukti transaksi TIDAK dibagikan publik. */
function simpanFile_(dataUrl, nama, publik) {
  if (!dataUrl) return '';
  const m = String(dataUrl).match(/^data:(.+?);base64,(.*)$/);
  if (!m) throw new Error('Format gambar tidak valid');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], nama);
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('FOLDER_ID'));
  const f = folder.createFile(blob);
  if (publik) {
    try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { }
    return 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w800';
  }
  return 'https://drive.google.com/file/d/' + f.getId() + '/view';
}
function wajib_(v, label) {
  if (v === undefined || v === null || String(v).trim() === '') throw new Error(label + ' wajib diisi');
  return String(v).trim();
}
function angka_(v, label) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !isFinite(n) || n < 0) throw new Error(label + ' tidak valid');
  return Math.round(n);
}
function pilih_(v, daftar, label) {
  if (daftar.indexOf(v) < 0) throw new Error(label + ' tidak valid');
  return v;
}
function uid_(p) { return p + '-' + Utilities.getUuid().slice(0, 8).toUpperCase(); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
