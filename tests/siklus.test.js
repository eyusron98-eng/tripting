'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { baru, FOTO, BUKTI } = require('./helpers');

describe('siklus: tambah barang → jual transfer', () => {
  it('mencatat barang, kas keluar pembelian, penjualan lunas, dan kas masuk ke Rekening', () => {
    const a = baru();
    const b = a.tambahBarang({ nama: 'Jaket denim Levis', harga_beli: 50000, harga_target: 120000, akun: 'Tunai', bukti: BUKTI });
    assert.equal(b.kode, 'TR2611-001');
    assert.equal(b.status, 'Tersedia');
    assert.match(b.foto, /^https:\/\/drive\.google\.com\/thumbnail\?id=FILE\d+&sz=w800$/);

    let d = a.semua();
    assert.equal(d.barang.length, 1);
    assert.equal(d.kas.length, 1);
    assert.deepEqual(
      { jenis: d.kas[0].jenis, akun: d.kas[0].akun, kategori: d.kas[0].kategori, nominal: d.kas[0].nominal, ref: d.kas[0].ref, status: d.kas[0].status, oleh: d.kas[0].dibuat_oleh },
      { jenis: 'Keluar', akun: 'Tunai', kategori: 'Pembelian Barang', nominal: 50000, ref: 'TR2611-001', status: 'Aktif', oleh: 'Deni' });
    assert.deepEqual(a.saldo(), { Tunai: -50000, Rekening: 0 });

    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Transfer', harga_jual: 120000, bukti: BUKTI, pembeli: 'Sari', kanal: 'Instagram' }, a.deni);
    assert.equal(p.status, 'Lunas');
    assert.equal(p.diterima, 120000);
    assert.equal(p.tgl_lunas, '2026-11-03');
    assert.equal(a.barang(b.kode).status, 'Terjual');

    const kasJual = a.kasRef(p.id);
    assert.equal(kasJual.length, 1);
    assert.deepEqual(
      { jenis: kasJual[0].jenis, akun: kasJual[0].akun, kategori: kasJual[0].kategori, nominal: kasJual[0].nominal },
      { jenis: 'Masuk', akun: 'Rekening', kategori: 'Penjualan', nominal: 120000 });
    assert.deepEqual(a.saldo(), { Tunai: -50000, Rekening: 120000 });
  });

  it('jual Tunai masuk ke akun Tunai; ongkir toko tercatat sebagai kas keluar terpisah', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 100000, ongkir: 9000, akun_ongkir: 'Rekening', bukti_ongkir: BUKTI }, a.deni);
    assert.equal(p.status, 'Lunas');
    assert.deepEqual(a.saldo(), { Tunai: -50000 + 100000, Rekening: -9000 });
  });

  it('semua aksi tulis tercatat di Log dengan nama pelaku; aksi yang ditolak tidak menambah Log', () => {
    const a = baru();
    const awal = a.logRows().length;
    const b = a.tambahBarang();
    assert.equal(a.logRows().length, awal + 1);
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Transfer', harga_jual: 1 }, a.deni);   // tanpa bukti → ditolak
    assert.equal(a.logRows().length, awal + 1, 'penolakan tidak menulis Log');
    a.ok('ubahBarang', { kode: b.kode, nama: 'Jaket baru' }, a.deni);
    a.ok('statusBarang', { kode: b.kode, status: 'Rusak', alasan: 'sobek' }, a.deni);
    a.ok('statusBarang', { kode: b.kode, status: 'Tersedia', alasan: 'sudah dijahit' }, a.deni);
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 90000 }, a.deni);
    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Retur', alasan: 'ditolak pembeli' }, a.deni);
    a.ok('tambahKas', { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 5000, keterangan: 'plastik', bukti: BUKTI }, a.deni);
    a.ok('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 1000, keterangan: 'setor', bukti: BUKTI }, a.deni);
    const k = a.semua().kas.find(x => x.kategori === 'Operasional');
    a.ok('batalkan', { jenis: 'Kas', id: k.id, alasan: 'salah catat' }, a.eri);
    const log = a.logRows();
    assert.equal(log.length, awal + 9, 'sembilan aksi tulis berhasil → sembilan baris Log');
    assert.deepEqual(log.slice(awal).map(l => l.aksi), [
      'Tambah barang', 'Ubah barang', 'Status barang', 'Status barang', 'Penjualan', 'COD retur', 'Kas Keluar', 'Pindah saldo', 'Batal kas']);
    assert.deepEqual(log.slice(awal).map(l => l.user), ['Deni', 'Deni', 'Deni', 'Deni', 'Deni', 'Deni', 'Deni', 'Deni', 'Eri']);
  });
});

describe('siklus: jual COD → lunas (diterima < harga)', () => {
  it('COD menunggu, barang Dipesan, tanpa kas masuk; lunas memasukkan nominal BERSIH', () => {
    const a = baru();
    const b = a.tambahBarang({ harga_beli: 40000 });
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 150000, ongkir: 10000, akun_ongkir: 'Tunai', bukti_ongkir: BUKTI, pembeli: 'Budi' }, a.deni);
    assert.equal(p.status, 'Menunggu COD');
    assert.equal(p.diterima, '');
    assert.equal(p.tgl_lunas, '');
    assert.equal(a.barang(b.kode).status, 'Dipesan');
    assert.equal(a.semua().kas.filter(k => k.kategori === 'Penjualan').length, 0, 'belum ada uang masuk');
    assert.deepEqual(a.saldo(), { Tunai: -40000 - 10000, Rekening: 0 });

    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Lunas', diterima: 135000, akun: 'Rekening', bukti: BUKTI }, a.deni);
    const sesudah = a.penjualan(p.id);
    assert.equal(sesudah.status, 'Lunas');
    assert.equal(sesudah.diterima, 135000, 'yang dicatat adalah uang bersih, bukan harga jual');
    assert.equal(sesudah.harga_jual, 150000);
    assert.equal(sesudah.tgl_lunas, '2026-11-03');
    assert.equal(a.barang(b.kode).status, 'Terjual');
    const masuk = a.semua().kas.filter(k => k.kategori === 'Penjualan');
    assert.equal(masuk.length, 1);
    assert.deepEqual({ akun: masuk[0].akun, nominal: masuk[0].nominal, jenis: masuk[0].jenis }, { akun: 'Rekening', nominal: 135000, jenis: 'Masuk' });
    assert.deepEqual(a.saldo(), { Tunai: -50000, Rekening: 135000 });
  });

  it('COD yang sudah dikonfirmasi tidak bisa dikonfirmasi dua kali', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 100000 }, a.deni);
    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Lunas', diterima: 90000, bukti: BUKTI }, a.deni);
    a.gagal('konfirmasiCOD', { id: p.id, hasil: 'Lunas', diterima: 90000, bukti: BUKTI }, a.deni, /Status penjualan/);
    assert.equal(a.semua().kas.filter(k => k.kategori === 'Penjualan').length, 1);
  });

  it('[S2] COD lunas dengan uang diterima 0 ditolak (tidak ada uang → itu retur)', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 100000 }, a.deni);
    a.gagal('konfirmasiCOD', { id: p.id, hasil: 'Lunas', diterima: 0, bukti: BUKTI }, a.deni, /lebih dari 0/);
    assert.equal(a.penjualan(p.id).status, 'Menunggu COD');
    assert.equal(a.barang(b.kode).status, 'Dipesan');
  });
});

describe('siklus: jual COD → retur', () => {
  it('retur: penjualan Retur, tanpa uang masuk, barang kembali Tersedia, biaya retur jadi kas keluar', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 150000 }, a.deni);
    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Retur', alasan: 'ukuran tidak cocok', biaya_retur: 8000, akun: 'Tunai', bukti: BUKTI }, a.deni);
    const r = a.penjualan(p.id);
    assert.equal(r.status, 'Retur');
    assert.equal(r.diterima, 0);
    assert.match(r.catatan, /Retur: ukuran tidak cocok/);
    assert.equal(a.barang(b.kode).status, 'Tersedia');
    const kas = a.kasRef(p.id);
    assert.equal(kas.length, 1);
    assert.deepEqual({ jenis: kas[0].jenis, nominal: kas[0].nominal, akun: kas[0].akun }, { jenis: 'Keluar', nominal: 8000, akun: 'Tunai' });
    assert.deepEqual(a.saldo(), { Tunai: -50000 - 8000, Rekening: 0 });
  });

  it('retur wajib alasan; retur tanpa biaya tidak membuat kas', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 150000 }, a.deni);
    a.gagal('konfirmasiCOD', { id: p.id, hasil: 'Retur' }, a.deni, /Alasan retur wajib/);
    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Retur', alasan: 'batal beli' }, a.deni);
    assert.equal(a.kasRef(p.id).length, 0);
  });

  it('barang hasil retur bisa dijual lagi', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p1 = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 150000 }, a.deni);
    a.ok('konfirmasiCOD', { id: p1.id, hasil: 'Retur', alasan: 'x' }, a.deni);
    const p2 = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 130000 }, a.deni);
    assert.equal(p2.status, 'Lunas');
    assert.equal(a.barang(b.kode).status, 'Terjual');
  });

  it('hasil selain Lunas/Retur ditolak', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 150000 }, a.deni);
    a.gagal('konfirmasiCOD', { id: p.id, hasil: 'Entah' }, a.deni, /Lunas atau Retur/);
  });
});

describe('siklus: pindah saldo', () => {
  it('dua baris kas berpasangan (ref sama); saldo total tidak berubah', () => {
    const a = baru();
    a.ok('tambahKas', { jenis: 'Masuk', akun: 'Tunai', kategori: 'Setoran Modal', nominal: 500000, keterangan: 'modal awal', bukti: BUKTI }, a.deni);
    const total0 = a.saldo().Tunai + a.saldo().Rekening;
    a.ok('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 200000, keterangan: 'setor tunai', bukti: BUKTI }, a.deni);
    assert.deepEqual(a.saldo(), { Tunai: 300000, Rekening: 200000 });
    assert.equal(a.saldo().Tunai + a.saldo().Rekening, total0);
    const pasangan = a.semua().kas.filter(k => k.kategori === 'Pindah Saldo');
    assert.equal(pasangan.length, 2);
    assert.equal(pasangan[0].ref, pasangan[1].ref);
    assert.match(pasangan[0].ref, /^PD-/);
    assert.deepEqual(pasangan.map(k => [k.jenis, k.akun]), [['Keluar', 'Tunai'], ['Masuk', 'Rekening']]);
  });

  it('akun asal = tujuan, akun tak dikenal, nominal 0 ditolak', () => {
    const a = baru();
    a.gagal('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Tunai', nominal: 1000, keterangan: 'x', bukti: BUKTI }, a.deni, /sama/);
    a.gagal('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Bank X', nominal: 1000, keterangan: 'x', bukti: BUKTI }, a.deni, /tidak valid/);
    a.gagal('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 0, keterangan: 'x', bukti: BUKTI }, a.deni, /lebih dari 0/);
    assert.equal(a.semua().kas.length, 0);
  });
});

describe('siklus: pembatalan oleh admin', () => {
  it('batal penjualan: kas terhubung (masuk + ongkir) ikut batal, barang Tersedia, saldo kembali', () => {
    const a = baru();
    const b = a.tambahBarang({ harga_beli: 50000 });
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Transfer', harga_jual: 120000, bukti: BUKTI, ongkir: 7000, akun_ongkir: 'Tunai', bukti_ongkir: BUKTI }, a.deni);
    assert.deepEqual(a.saldo(), { Tunai: -57000, Rekening: 120000 });
    a.ok('batalkan', { jenis: 'Penjualan', id: p.id, alasan: 'pembeli salah kirim bukti' }, a.eri);
    assert.equal(a.penjualan(p.id).status, 'Batal');
    assert.match(a.penjualan(p.id).catatan, /\[BATAL: pembeli salah kirim bukti\]/);
    assert.equal(a.barang(b.kode).status, 'Tersedia');
    a.kasRef(p.id).forEach(k => assert.equal(k.status, 'Batal'));
    assert.equal(a.kasRef(p.id).length, 2);
    assert.deepEqual(a.saldo(), { Tunai: -50000, Rekening: 0 }, 'tinggal pembelian');
    a.gagal('batalkan', { jenis: 'Penjualan', id: p.id, alasan: 'lagi' }, a.eri, /sudah batal/);
  });

  it('batal penjualan COD yang masih menunggu: barang kembali Tersedia', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 100000 }, a.deni);
    a.ok('batalkan', { jenis: 'Penjualan', id: p.id, alasan: 'pembeli hilang' }, a.eri);
    assert.equal(a.barang(b.kode).status, 'Tersedia');
  });

  it('batal barang: kas pembelian ikut batal; barang terjual/dipesan harus dibatalkan penjualannya dulu', () => {
    const a = baru();
    const b = a.tambahBarang({ harga_beli: 50000 });
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 100000 }, a.deni);
    a.gagal('batalkan', { jenis: 'Barang', id: b.kode, alasan: 'salah input' }, a.eri, /Batalkan penjualannya dulu/);
    a.ok('batalkan', { jenis: 'Penjualan', id: p.id, alasan: 'salah input' }, a.eri);
    a.ok('batalkan', { jenis: 'Barang', id: b.kode, alasan: 'salah input' }, a.eri);
    assert.equal(a.barang(b.kode).status, 'Batal');
    assert.deepEqual(a.saldo(), { Tunai: 0, Rekening: 0 });
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 1000 }, a.deni, /berstatus Batal/);
    a.gagal('ubahBarang', { kode: b.kode, nama: 'x' }, a.deni, /sudah dibatalkan/);
  });

  it('batal kas mandiri OK; kas yang terhubung ke barang/penjualan ditolak; Pindah membatalkan kedua sisi', () => {
    const a = baru();
    const b = a.tambahBarang({ harga_beli: 50000 });
    a.ok('tambahKas', { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 3000, keterangan: 'lakban', bukti: BUKTI }, a.deni);
    a.ok('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 10000, keterangan: 'setor', bukti: BUKTI }, a.deni);
    const kas = a.semua().kas;
    const beli = kas.find(k => k.kategori === 'Pembelian Barang');
    const ops = kas.find(k => k.kategori === 'Operasional');
    const pindah = kas.find(k => k.kategori === 'Pindah Saldo' && k.jenis === 'Keluar');
    a.gagal('batalkan', { jenis: 'Kas', id: beli.id, alasan: 'x' }, a.eri, /terhubung ke/);
    a.ok('batalkan', { jenis: 'Kas', id: ops.id, alasan: 'salah catat' }, a.eri);
    a.ok('batalkan', { jenis: 'Kas', id: pindah.id, alasan: 'salah akun' }, a.eri);
    const akhir = a.semua().kas;
    assert.equal(akhir.find(k => k.id === ops.id).status, 'Batal');
    assert.deepEqual(akhir.filter(k => k.kategori === 'Pindah Saldo').map(k => k.status), ['Batal', 'Batal']);
    assert.equal(akhir.find(k => k.id === beli.id).status, 'Aktif');
    assert.deepEqual(a.saldo(), { Tunai: -50000, Rekening: 0 });
    assert.match(akhir.find(k => k.id === ops.id).keterangan, /\[BATAL: salah catat\]/);
    assert.ok(b);
  });

  it('alasan pembatalan wajib; jenis tak dikenal ditolak', () => {
    const a = baru();
    const b = a.tambahBarang();
    a.gagal('batalkan', { jenis: 'Barang', id: b.kode }, a.eri, /Alasan wajib/);
    a.gagal('batalkan', { jenis: 'Barang', id: b.kode, alasan: '   ' }, a.eri, /Alasan wajib/);
    a.gagal('batalkan', { jenis: 'Pelanggan', id: '1', alasan: 'x' }, a.eri, /tidak dikenal/);
    assert.equal(a.barang(b.kode).status, 'Tersedia');
  });
});

describe('invarian: tidak ada hapus baris, saldo hanya dari Kas', () => {
  it('jumlah baris tidak pernah berkurang sepanjang siklus penuh (batal = status, bukan hapus)', () => {
    const a = baru();
    let prev = a.jumlahBaris();
    const cek = () => {
      const now = a.jumlahBaris();
      for (const k of Object.keys(now)) assert.ok(now[k] >= prev[k], `baris ${k} berkurang`);
      prev = now;
    };
    const b = a.tambahBarang(); cek();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000, ongkir: 5000, bukti_ongkir: BUKTI }, a.deni); cek();
    a.ok('batalkan', { jenis: 'Penjualan', id: p.id, alasan: 'x' }, a.eri); cek();
    a.ok('batalkan', { jenis: 'Barang', id: b.kode, alasan: 'x' }, a.eri); cek();
    a.gagal('batalkan', { jenis: 'Barang', id: b.kode, alasan: 'x' }, a.eri); cek();
    assert.ok(prev.Barang === 1 && prev.Penjualan === 1 && prev.Kas >= 3);
  });

  it('kode sumber tidak memanggil operasi penghapusan baris/isi', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
    assert.doesNotMatch(src, /\.(deleteRows?|deleteColumns?|clearContent|clear|clearContents)\s*\(/);
  });

  it('tidak ada kolom saldo di sheet mana pun; saldo = jumlah kas aktif', () => {
    const a = baru();
    const b = a.tambahBarang({ harga_beli: 30000 });
    a.ok('tambahPenjualan', { kode: b.kode, metode: 'Transfer', harga_jual: 80000, bukti: BUKTI }, a.deni);
    for (const nama of ['Barang', 'Penjualan', 'Kas', 'Log']) {
      assert.ok(!a.env.sheets[nama].data[0].some(h => /saldo/i.test(h)), `${nama} punya kolom saldo`);
    }
    assert.deepEqual(a.saldo(), { Tunai: -30000, Rekening: 80000 });
  });
});
