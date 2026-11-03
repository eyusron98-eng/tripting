'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { baru, FOTO, BUKTI } = require('./helpers');

describe('aturan staf: foto & bukti wajib', () => {
  it('foto barang wajib untuk staf, opsional untuk admin', () => {
    const a = baru();
    a.gagal('tambahBarang', { nama: 'Kaos', harga_beli: 10000 }, a.deni, /Foto barang wajib/);
    assert.equal(a.semua().barang.length, 0);
    assert.equal(a.ok('tambahBarang', { nama: 'Kaos', harga_beli: 10000 }, a.eri).status, 'Tersedia');
  });

  it('bukti wajib untuk penjualan Transfer (staf); admin boleh tanpa', () => {
    const a = baru();
    const b1 = a.tambahBarang();
    a.gagal('tambahPenjualan', { kode: b1.kode, metode: 'Transfer', harga_jual: 100000 }, a.deni, /Bukti transfer wajib/);
    assert.equal(a.barang(b1.kode).status, 'Tersedia');
    assert.equal(a.semua().penjualan.length, 0);
    assert.equal(a.ok('tambahPenjualan', { kode: b1.kode, metode: 'Transfer', harga_jual: 100000 }, a.eri).status, 'Lunas');
  });

  it('bukti wajib untuk pencairan COD (staf)', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 100000 }, a.deni);
    a.gagal('konfirmasiCOD', { id: p.id, hasil: 'Lunas', diterima: 90000 }, a.deni, /Bukti pencairan COD wajib/);
    assert.equal(a.penjualan(p.id).status, 'Menunggu COD');
    assert.equal(a.semua().kas.filter(k => k.kategori === 'Penjualan').length, 0);
    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Lunas', diterima: 90000 }, a.eri);   // admin tanpa bukti OK
  });

  it('[T4/D1] bukti wajib untuk SEMUA kas keluar staf: kas manual, ongkir, biaya retur, Pindah', () => {
    const a = baru();
    const b = a.tambahBarang();
    a.gagal('tambahKas', { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 5000, keterangan: 'plastik' }, a.deni, /Bukti .* wajib/);
    a.gagal('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 5000, keterangan: 'setor' }, a.deni, /Bukti .* wajib/);
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000, ongkir: 7000 }, a.deni, /Bukti ongkir wajib/);
    assert.equal(a.barang(b.kode).status, 'Tersedia', 'penolakan tidak boleh meninggalkan efek samping');
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 90000 }, a.deni);
    a.gagal('konfirmasiCOD', { id: p.id, hasil: 'Retur', alasan: 'x', biaya_retur: 8000, akun: 'Tunai' }, a.deni, /Bukti biaya retur wajib/);
    assert.equal(a.penjualan(p.id).status, 'Menunggu COD');
    // jalur yang sama diterima bila bukti ada
    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Retur', alasan: 'x', biaya_retur: 8000, akun: 'Tunai', bukti: BUKTI }, a.deni);
    // tidak ada kas keluar aktif tanpa bukti yang dibuat staf, selain pembelian Tunai (aturan D1)
    const tanpaBukti = a.semua().kas.filter(k => k.jenis === 'Keluar' && !k.bukti && k.dibuat_oleh === 'Deni');
    assert.deepEqual(tanpaBukti.map(k => k.kategori), ['Pembelian Barang']);
  });

  it('[D1] pembelian barang: staf wajib bukti bila dibayar dari Rekening; dari Tunai opsional (foto sudah wajib)', () => {
    const a = baru();
    a.gagal('tambahBarang', { nama: 'Tas', harga_beli: 70000, akun: 'Rekening', foto: FOTO }, a.deni, /Bukti pembayaran wajib/);
    assert.equal(a.semua().barang.length, 0);
    assert.equal(a.semua().kas.length, 0);
    a.ok('tambahBarang', { nama: 'Tas', harga_beli: 70000, akun: 'Tunai', foto: FOTO }, a.deni);
    a.ok('tambahBarang', { nama: 'Tas 2', harga_beli: 70000, akun: 'Rekening', foto: FOTO, bukti: BUKTI }, a.deni);
    a.ok('tambahBarang', { nama: 'Tas 3', harga_beli: 70000, akun: 'Rekening', foto: FOTO }, a.eri);   // admin bebas
    a.ok('tambahBarang', { nama: 'Hadiah', harga_beli: 0, akun: 'Rekening', foto: FOTO }, a.deni);    // tanpa uang keluar → tanpa bukti
  });

  it('[D3] staf wajib bukti untuk kas MASUK juga (Setoran Modal / Pemasukan Lain); admin tidak', () => {
    const a = baru();
    a.gagal('tambahKas', { jenis: 'Masuk', akun: 'Tunai', kategori: 'Pemasukan Lain', nominal: 50000, keterangan: 'titip' }, a.deni, /Bukti .* wajib/);
    a.gagal('tambahKas', { jenis: 'Masuk', akun: 'Rekening', kategori: 'Setoran Modal', nominal: 50000, keterangan: 'modal' }, a.deni, /Bukti .* wajib/);
    assert.equal(a.semua().kas.length, 0);
    a.ok('tambahKas', { jenis: 'Masuk', akun: 'Tunai', kategori: 'Pemasukan Lain', nominal: 50000, keterangan: 'titip', bukti: BUKTI }, a.deni);
    a.ok('tambahKas', { jenis: 'Masuk', akun: 'Tunai', kategori: 'Setoran Modal', nominal: 50000, keterangan: 'modal' }, a.eri);
    assert.equal(a.semua().kas.length, 2);
  });

  it('kategori Penyesuaian hanya untuk admin; kategori internal (Penjualan, Pembelian Barang) tidak bisa diinput manual', () => {
    const a = baru();
    const p = { jenis: 'Keluar', akun: 'Tunai', nominal: 1000, keterangan: 'selisih', bukti: BUKTI };
    a.gagal('tambahKas', { ...p, kategori: 'Penyesuaian' }, a.deni, /Kategori tidak valid/);
    a.ok('tambahKas', { ...p, kategori: 'Penyesuaian' }, a.eri);
    a.gagal('tambahKas', { ...p, kategori: 'Penjualan', jenis: 'Masuk' }, a.eri, /Kategori tidak valid/);
    a.gagal('tambahKas', { ...p, kategori: 'Pembelian Barang' }, a.eri, /Kategori tidak valid/);
  });
});

describe('aturan staf: hak akses', () => {
  it('staf ditolak membatalkan apa pun (Kas, Penjualan, Barang) dan tidak ada yang berubah', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000 }, a.deni);
    const k = a.semua().kas[0];
    const sebelum = JSON.stringify(a.semua());
    for (const [jenis, id] of [['Kas', k.id], ['Penjualan', p.id], ['Barang', b.kode]]) {
      a.gagal('batalkan', { jenis, id, alasan: 'iseng' }, a.deni, /Hanya admin/);
    }
    assert.equal(JSON.stringify(a.semua()), sebelum);
  });

  it('staf tidak bisa mengubah harga beli (ubahBarang menolak, harga tetap)', () => {
    const a = baru();
    const b = a.tambahBarang({ harga_beli: 50000 });
    a.gagal('ubahBarang', { kode: b.kode, harga_beli: 1000 }, a.deni, /Harga beli tidak bisa diubah/);
    a.gagal('ubahBarang', { kode: b.kode, harga_beli: 1000 }, a.eri, /Harga beli tidak bisa diubah/);
    assert.equal(a.barang(b.kode).harga_beli, 50000);
    // mengirim ulang harga beli yang SAMA (seperti form edit) tidak jadi masalah
    a.ok('ubahBarang', { kode: b.kode, harga_beli: 50000, nama: 'Nama baru' }, a.deni);
    assert.equal(a.barang(b.kode).nama, 'Nama baru');
    assert.equal(a.barang(b.kode).harga_beli, 50000);
  });

  it('log hanya dikirim ke admin', () => {
    const a = baru();
    a.tambahBarang();
    assert.ok(a.semua(a.eri).log.length >= 1);
    assert.deepEqual(a.semua(a.deni).log, []);
    assert.deepEqual(a.semua(a.deni).peringatan, []);
  });

  it('log admin: 40 baris terakhir, terbaru di atas', () => {
    const a = baru();
    const b = a.tambahBarang();
    for (let i = 0; i < 45; i++) a.ok('ubahBarang', { kode: b.kode, catatan: 'rev ' + i }, a.deni);
    const log = a.semua().log;
    assert.equal(log.length, 40);
    assert.match(log[0].detail, /rev 44/);
  });
});

describe('aturan: foto publik, bukti privat', () => {
  it('foto dibagikan via link; bukti tidak pernah dibagikan; keduanya di folder berbeda', () => {
    const a = baru();
    const b = a.tambahBarang({ bukti: BUKTI });
    a.ok('tambahPenjualan', { kode: b.kode, metode: 'Transfer', harga_jual: 90000, bukti: BUKTI }, a.deni);
    const files = a.env.drive.files;
    const foto = files.filter(f => f.nama.endsWith('.jpg') && !/bukti|jual/.test(f.nama));
    const bukti = files.filter(f => /bukti|jual/.test(f.nama));
    assert.ok(foto.length >= 1 && bukti.length >= 2);
    foto.forEach(f => assert.equal(f.sharing, 'ANYONE_WITH_LINK'));
    bukti.forEach(f => assert.equal(f.sharing, null, `bukti ${f.nama} tidak boleh dibagikan`));
    const folderFoto = new Set(foto.map(f => f.folder));
    const folderBukti = new Set(bukti.map(f => f.folder));
    assert.equal(folderFoto.size, 1);
    assert.equal(folderBukti.size, 1);
    assert.notEqual([...folderFoto][0], [...folderBukti][0], 'folder foto & bukti harus terpisah');
    assert.equal(a.env.drive.folders[[...folderBukti][0]].akses, 'PRIVATE');
  });

  it('link bukti berupa halaman file Drive (bukan thumbnail publik)', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Transfer', harga_jual: 90000, bukti: BUKTI }, a.deni);
    assert.match(p.bukti, /^https:\/\/drive\.google\.com\/file\/d\/FILE\d+\/view$/);
  });
});
