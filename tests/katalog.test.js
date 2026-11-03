'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { baru, FOTO, BUKTI } = require('./helpers');

// Penanda unik: bila salah satunya muncul di respons publik, ada kebocoran.
const RAHASIA = { sumber: 'PENJUAL-PRIBADI-RAHASIA', catatan: 'CATATAN-INTERNAL-RAHASIA', hargaBeli: 123457, oleh: 'Deni' };

function toko() {
  const a = baru();
  const jaket = a.tambahBarang({ nama: 'Jaket denim', kategori: 'Jaket', ukuran: 'M', kondisi: 'Baik', harga_beli: RAHASIA.hargaBeli, harga_target: 120000, sumber: RAHASIA.sumber, catatan: RAHASIA.catatan });
  const kaos = a.tambahBarang({ nama: 'Kaos band', kategori: 'Kaos', ukuran: 'L', kondisi: 'Seperti baru', harga_beli: 20000, harga_target: 45000 });
  return { a, jaket, kaos };
}
const publik = (a, data) => a.env.call('katalog', data);        // tanpa PIN, tanpa token
const mentah = (a, data) => a.env.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'katalog', data }) } }).getContent();

describe('katalog publik: tanpa login', () => {
  it('bisa diakses tanpa PIN/token dan mengembalikan barang tersedia', () => {
    const { a, jaket, kaos } = toko();
    const r = publik(a);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.barang.map(b => b.kode), [kaos.kode, jaket.kode], 'terbaru dulu');
    assert.match(r.data.diperbarui, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('token/PIN palsu pada permintaan katalog diabaikan (tidak menghitung sebagai PIN salah)', () => {
    const { a } = toko();
    for (let i = 0; i < 30; i++) a.env.call('katalog', {}, { pin: '000000', token: 'x'.repeat(64) });
    assert.equal(a.env.call('login', {}, { pin: a.pin.Eri }).ok, true, 'login tidak terkunci oleh lalu lintas katalog');
  });

  it('aksi lain tetap wajib token (katalog tidak membuka pintu belakang)', () => {
    const { a } = toko();
    for (const aksi of ['getAll', 'tambahBarang', 'tambahKas', 'batalkan', 'keluar']) {
      assert.equal(a.env.call(aksi, {}, {}).code, 'SESI', aksi);
    }
  });

  it('tidak mengambil lock: tetap jalan walau server "sibuk" untuk staf, dan tidak menahan lock', () => {
    const { a } = toko();
    a.env.lock.busy = true;
    const kali = a.env.lock.kali;
    assert.equal(publik(a).ok, true);
    assert.equal(a.env.lock.kali, kali);
    assert.equal(a.env.lock.held, false);
  });
});

describe('katalog publik: tidak ada data internal yang bocor', () => {
  it('hanya 8 kolom aman per barang', () => {
    const { a } = toko();
    for (const b of publik(a).data.barang) {
      assert.deepEqual(Object.keys(b).sort(), ['foto', 'harga', 'kategori', 'kode', 'kondisi', 'nama', 'status', 'ukuran']);
    }
  });

  it('harga beli, nama penjual, catatan internal, pembuat, id, dan nilai kas tidak muncul di respons mentah', () => {
    const { a, jaket } = toko();
    a.ok('tambahPenjualan', { kode: a.tambahBarang({ nama: 'Sepatu', harga_target: 99000 }).kode, metode: 'Tunai', harga_jual: 90000, pembeli: 'PEMBELI-RAHASIA', kontak: '0812-KONTAK-RAHASIA' }, a.deni);
    a.ok('statusBarang', { kode: jaket.kode, status: 'Rusak', alasan: 'ALASAN-RAHASIA' }, a.deni);
    a.ok('statusBarang', { kode: jaket.kode, status: 'Tersedia', alasan: 'ALASAN-RAHASIA-2' }, a.deni);
    const teks = mentah(a);
    for (const r of [RAHASIA.sumber, RAHASIA.catatan, String(RAHASIA.hargaBeli), 'PEMBELI-RAHASIA', 'KONTAK-RAHASIA', 'ALASAN-RAHASIA', 'Deni', 'Eri', 'dibuat_', 'harga_beli', 'sumber', 'catatan', 'tgl', 'token', 'pin', 'USERS', 'SESSIONS']) {
      assert.ok(!teks.includes(r), `respons publik memuat "${r}"`);
    }
    assert.doesNotMatch(teks, /"id":|B-[0-9A-F]{12}|PJ-[0-9A-F]{12}|K-[0-9A-F]{12}/);
  });

  it('barang berstatus Terjual, Rusak, dan Batal tidak tampil; Dipesan tampil paling akhir', () => {
    const { a, jaket, kaos } = toko();
    const rusak = a.tambahBarang({ nama: 'Rusak' }); a.ok('statusBarang', { kode: rusak.kode, status: 'Rusak', alasan: 'sobek' }, a.deni);
    const batal = a.tambahBarang({ nama: 'Batal' }); a.ok('batalkan', { jenis: 'Barang', id: batal.kode, alasan: 'x' }, a.eri);
    const terjual = a.tambahBarang({ nama: 'Terjual' }); a.ok('tambahPenjualan', { kode: terjual.kode, metode: 'Tunai', harga_jual: 1000 }, a.deni);
    const pesan = a.tambahBarang({ nama: 'Dipesan', harga_target: 70000 }); a.ok('tambahPenjualan', { kode: pesan.kode, metode: 'COD', harga_jual: 70000 }, a.deni);
    const r = publik(a).data.barang;
    assert.deepEqual(r.map(b => b.nama), ['Kaos band', 'Jaket denim', 'Dipesan']);
    assert.deepEqual(r.map(b => b.status), ['Tersedia', 'Tersedia', 'Dipesan']);
    assert.ok(jaket && kaos);
  });

  it('URL foto hanya boleh thumbnail Drive kita; nilai lain (mis. javascript:) dikosongkan', () => {
    const { a, jaket } = toko();
    const baris = a.env.sheets.Barang.data;
    const kol = baris[0].indexOf('foto');
    assert.match(publik(a).data.barang.find(b => b.kode === jaket.kode).foto, /^https:\/\/drive\.google\.com\/thumbnail\?id=FILE\d+&sz=w800$/);
    for (const buruk of ['javascript:alert(1)', 'https://evil.example/x.jpg', 'data:text/html,hi', 'https://drive.google.com/thumbnail?id=1&sz=w800"onerror="x', '']) {
      baris[1][kol] = buruk;
      a.env.cache = {};
      assert.equal(publik(a).data.barang.find(b => b.kode === jaket.kode).foto, '', buruk);
    }
  });

  it('harga memakai target harga jual; target kosong/rusak → 0 (frontend menampilkan "Tanya harga")', () => {
    const a = baru();
    const k1 = a.tambahBarang({ nama: 'Tanpa target', harga_target: undefined });
    const k2 = a.tambahBarang({ nama: 'Target teks', harga_target: 30000 });
    a.env.sheets.Barang.data[2][a.env.sheets.Barang.data[0].indexOf('harga_target')] = 'abc';
    const r = publik(a).data.barang;
    assert.equal(r.find(b => b.kode === k1.kode).harga, 0);
    assert.equal(r.find(b => b.kode === k2.kode).harga, 0, 'nilai tak terbaca → 0, bukan NaN');
    a.env.sheets.Barang.data[2][a.env.sheets.Barang.data[0].indexOf('harga_target')] = '45.000';
    a.env.cache = {};
    assert.equal(publik(a).data.barang.find(b => b.kode === k2.kode).harga, 45000);
  });

  it('maksimum 200 barang; teks asing tetap berupa string biasa', () => {
    const a = baru();
    const s = a.env.sheets.Barang;
    const head = s.data[0];
    for (let i = 0; i < 230; i++) {
      const r = new Array(head.length).fill('');
      r[head.indexOf('id')] = 'B-' + i; r[head.indexOf('kode')] = 'TR2611-' + String(i + 1).padStart(3, '0');
      r[head.indexOf('nama')] = i === 229 ? '<img src=x onerror=alert(1)>' : 'Barang ' + i; r[head.indexOf('status')] = 'Tersedia';
      s.data.push(r);
    }
    const r = publik(a).data.barang;
    assert.equal(r.length, 200);
    assert.equal(r[0].nama, '<img src=x onerror=alert(1)>', 'dikirim apa adanya sebagai data; frontend memakai textContent');
    assert.equal(r[199].nama, 'Barang 30', 'yang dipotong adalah barang TERLAMA');
  });
});

describe('katalog publik: cache dan kesegaran data', () => {
  it('permintaan kedua dilayani dari cache (tanpa membaca sheet); kedaluwarsa setelah 2 menit', () => {
    const { a } = toko();
    publik(a);
    const baca = a.env.reads;
    publik(a); publik(a);
    assert.equal(a.env.reads, baca, 'tidak boleh membaca sheet lagi');
    a.env.advance(121 * 1000);
    publik(a);
    assert.ok(a.env.reads > baca, 'setelah TTL, sheet dibaca ulang');
  });

  it('setiap aksi tulis menghapus cache: barang baru/terjual/dipesan langsung tercermin', () => {
    const { a, jaket } = toko();
    assert.equal(publik(a).data.barang.length, 2);
    const baruB = a.tambahBarang({ nama: 'Topi' });
    assert.equal(publik(a).data.barang.length, 3, 'barang baru langsung tampil');
    const p = a.ok('tambahPenjualan', { kode: jaket.kode, metode: 'COD', harga_jual: 120000 }, a.deni);
    assert.equal(publik(a).data.barang.find(b => b.kode === jaket.kode).status, 'Dipesan');
    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Retur', alasan: 'batal' }, a.deni);
    assert.equal(publik(a).data.barang.find(b => b.kode === jaket.kode).status, 'Tersedia');
    a.ok('ubahBarang', { kode: baruB.kode, harga_target: 25000, nama: 'Topi baru' }, a.deni);
    assert.equal(publik(a).data.barang.find(b => b.kode === baruB.kode).harga, 25000);
    a.ok('batalkan', { jenis: 'Barang', id: baruB.kode, alasan: 'x' }, a.eri);
    assert.equal(publik(a).data.barang.find(b => b.kode === baruB.kode), undefined);
    a.ok('tambahPenjualan', { kode: jaket.kode, metode: 'Tunai', harga_jual: 1000 }, a.deni);
    assert.equal(publik(a).data.barang.find(b => b.kode === jaket.kode), undefined, 'terjual → hilang dari katalog');
  });

  it('aksi tulis yang gagal + rollback juga tidak meninggalkan cache basi', () => {
    const { a, jaket } = toko();
    publik(a);
    a.env.gagalTulis('Kas');
    a.gagal('tambahPenjualan', { kode: jaket.kode, metode: 'Tunai', harga_jual: 90000 }, a.deni, /dibatalkan otomatis/);
    a.env.normal();
    assert.equal(publik(a).data.barang.find(b => b.kode === jaket.kode).status, 'Tersedia');
  });

  it('pembeli membuka katalog DI TENGAH aksi yang lalu gagal: keadaan sementara tidak boleh tertinggal di cache', () => {
    const { a, jaket } = toko();
    let sudah = false;
    a.env.hooks.beforeWrite = nama => {
      if (nama !== 'Kas' || sudah) return;
      sudah = true;
      // katalog tidak memakai lock, jadi bisa terbaca saat penjualan setengah tertulis (barang sementara "Terjual")
      assert.equal(publik(a).data.barang.find(b => b.kode === jaket.kode), undefined, 'keadaan sementara: tak tampil');
      throw new Error('Service Spreadsheets timed out (simulasi)');
    };
    a.gagal('tambahPenjualan', { kode: jaket.kode, metode: 'Tunai', harga_jual: 90000 }, a.deni, /dibatalkan otomatis/);
    a.env.normal();
    assert.equal(publik(a).data.barang.find(b => b.kode === jaket.kode).status, 'Tersedia', 'setelah rollback barang harus tampil lagi');
  });

  it('cache rusak (bukan JSON) tidak merusak respons', () => {
    const { a } = toko();
    a.env.cache.KATALOG = { v: '{bukan json', exp: a.env.clock.now + 60000 };
    assert.equal(publik(a).ok, true);
  });

  it('sheet Barang tidak ada → pesan ramah, bukan detail internal', () => {
    const a = baru();
    delete a.env.sheets.Barang;
    const r = publik(a);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'KATALOG');
    assert.doesNotMatch(r.error, /setup|Sheet/);
  });
});
