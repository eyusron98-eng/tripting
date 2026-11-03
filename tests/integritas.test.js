'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { baru, FOTO, BUKTI } = require('./helpers');

describe('[T1] barang tidak boleh terjual dua kali', () => {
  it('jual berurutan: barang Terjual / Dipesan ditolak', () => {
    const a = baru();
    const b = a.tambahBarang();
    a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 100000 }, a.deni);
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 100000 }, a.eri, /berstatus Terjual/);
    const c = a.tambahBarang({ nama: 'Kemeja' });
    a.ok('tambahPenjualan', { kode: c.kode, metode: 'COD', harga_jual: 100000 }, a.deni);
    a.gagal('tambahPenjualan', { kode: c.kode, metode: 'Transfer', harga_jual: 100000, bukti: BUKTI }, a.eri, /berstatus Dipesan/);
    assert.equal(a.semua().penjualan.length, 2);
    assert.equal(a.semua().kas.filter(k => k.kategori === 'Penjualan').length, 1);
  });

  it('batalkan penjualan Retur LAMA setelah barang dijual ulang: barang tetap Terjual dan tidak bisa dijual ke-3 kali', () => {
    const a = baru();
    const b = a.tambahBarang();
    const pA = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 100000 }, a.deni);
    a.ok('konfirmasiCOD', { id: pA.id, hasil: 'Retur', alasan: 'ditolak', biaya_retur: 6000, akun: 'Tunai', bukti: BUKTI }, a.deni);
    const pB = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000 }, a.deni);
    assert.equal(a.barang(b.kode).status, 'Terjual');

    a.ok('batalkan', { jenis: 'Penjualan', id: pA.id, alasan: 'bersih-bersih data' }, a.eri);

    assert.equal(a.barang(b.kode).status, 'Terjual', 'penjualan B masih aktif → barang harus tetap Terjual');
    assert.equal(a.penjualan(pB.id).status, 'Lunas');
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 80000 }, a.deni, /berstatus Terjual/);
    // kas biaya retur milik penjualan A ikut batal; kas penjualan B utuh
    a.kasRef(pA.id).forEach(k => assert.equal(k.status, 'Batal'));
    a.kasRef(pB.id).forEach(k => assert.equal(k.status, 'Aktif'));
  });

  it('batalkan penjualan Lunas yang aktif tetap mengembalikan barang ke Tersedia', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000 }, a.deni);
    a.ok('batalkan', { jenis: 'Penjualan', id: p.id, alasan: 'x' }, a.eri);
    assert.equal(a.barang(b.kode).status, 'Tersedia');
  });
});

describe('[T2/D2] tulis tidak atomik → rollback otomatis oleh SISTEM', () => {
  it('kas gagal ditulis saat jual: penjualan ditandai Batal, status barang dipulihkan, saldo utuh; retry dengan rid yang sama berhasil', () => {
    const a = baru();
    const b = a.tambahBarang({ harga_beli: 50000 });
    a.env.gagalTulis('Kas');
    const r = a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000, rid: 'rid-jual-0001' }, a.deni, /dibatalkan otomatis/);
    assert.match(r.error, /Service Spreadsheets/);
    a.env.normal();

    assert.equal(a.barang(b.kode).status, 'Tersedia');
    const pj = a.semua().penjualan;
    assert.equal(pj.length, 1);
    assert.equal(pj[0].status, 'Batal');
    assert.match(pj[0].catatan, /\[BATAL OTOMATIS: /);
    assert.deepEqual(a.saldo(), { Tunai: -50000, Rekening: 0 });
    const log = a.logRows();
    const rb = log.find(l => l.aksi === 'Rollback otomatis');
    assert.ok(rb, 'rollback harus tercatat di Log');
    assert.equal(rb.user, 'SISTEM');
    assert.match(rb.detail, /Deni/);
    assert.equal(log.filter(l => l.req_id === 'rid-jual-0001').length, 0, 'rid yang gagal tidak boleh dianggap selesai');

    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000, rid: 'rid-jual-0001' }, a.deni);
    assert.equal(p.status, 'Lunas');
    assert.equal(a.barang(b.kode).status, 'Terjual');
    assert.deepEqual(a.saldo(), { Tunai: -50000 + 90000, Rekening: 0 });
  });

  it('kas pembelian gagal ditulis saat tambah barang: barang ditandai Batal (bukan dibiarkan tanpa kas); kode tidak dipakai ulang', () => {
    const a = baru();
    a.env.gagalTulis('Kas');
    a.gagal('tambahBarang', { nama: 'Kaos', harga_beli: 30000, foto: FOTO }, a.deni, /dibatalkan otomatis/);
    a.env.normal();
    const brg = a.semua().barang;
    assert.equal(brg.length, 1);
    assert.equal(brg[0].status, 'Batal');
    assert.equal(a.semua().kas.filter(k => k.status !== 'Batal').length, 0);
    assert.deepEqual(a.saldo(), { Tunai: 0, Rekening: 0 });
    assert.equal(a.tambahBarang().kode, 'TR2611-002');
  });

  it('Pindah Saldo: sisi kedua gagal → sisi pertama dibatalkan, tidak ada uang "hilang"', () => {
    const a = baru();
    a.env.gagalTulis('Kas', { lewati: 1 });
    a.gagal('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 100000, keterangan: 'setor', bukti: BUKTI }, a.deni, /dibatalkan otomatis/);
    a.env.normal();
    assert.deepEqual(a.saldo(), { Tunai: 0, Rekening: 0 });
    assert.deepEqual(a.semua().kas.map(k => k.status), ['Batal']);
  });

  it('konfirmasi COD lunas gagal di tengah: penjualan kembali Menunggu COD, barang kembali Dipesan', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'COD', harga_jual: 100000 }, a.deni);
    a.env.gagalTulis('Kas');
    a.gagal('konfirmasiCOD', { id: p.id, hasil: 'Lunas', diterima: 90000, akun: 'Rekening', bukti: BUKTI }, a.deni, /dibatalkan otomatis/);
    a.env.normal();
    const sesudah = a.penjualan(p.id);
    assert.equal(sesudah.status, 'Menunggu COD');
    assert.equal(sesudah.diterima, '');
    assert.equal(sesudah.tgl_lunas, '');
    assert.equal(a.barang(b.kode).status, 'Dipesan');
    a.ok('konfirmasiCOD', { id: p.id, hasil: 'Lunas', diterima: 90000, akun: 'Rekening', bukti: BUKTI }, a.deni);
    assert.equal(a.penjualan(p.id).status, 'Lunas');
  });

  it('batalkan penjualan gagal di tengah: semuanya kembali seperti semula', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000 }, a.deni);
    const sebelum = JSON.stringify(a.semua().kas) + JSON.stringify(a.semua().penjualan) + JSON.stringify(a.semua().barang);
    a.env.gagalTulis('Kas');
    a.gagal('batalkan', { jenis: 'Penjualan', id: p.id, alasan: 'x' }, a.eri, /dibatalkan otomatis/);
    a.env.normal();
    assert.equal(JSON.stringify(a.semua().kas) + JSON.stringify(a.semua().penjualan) + JSON.stringify(a.semua().barang), sebelum);
  });

  it('Log gagal ditulis (langkah terakhir): seluruh aksi dibatalkan, bukan setengah tercatat', () => {
    const a = baru();
    a.env.gagalTulis('Log');
    a.gagal('tambahBarang', { nama: 'Kaos', harga_beli: 30000, foto: FOTO }, a.deni, /dibatalkan otomatis/);
    a.env.normal();
    assert.equal(a.semua().barang[0].status, 'Batal');
    assert.equal(a.semua().kas[0].status, 'Batal');
    assert.deepEqual(a.saldo(), { Tunai: 0, Rekening: 0 });
  });

  it('rollback sendiri gagal → pesan jujur menyuruh periksa Log, dan kegagalan tercatat', () => {
    const a = baru();
    a.env.gagalTulis('Kas', { kali: 99, lewati: 1 });
    const r = a.gagal('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 1000, keterangan: 'x', bukti: BUKTI }, a.deni);
    a.env.normal();
    assert.match(r.error, /periksa|Hubungi admin/i);
    assert.match(a.logRows().find(l => l.aksi === 'Rollback otomatis').detail, /gagal dipulihkan/i);
  });

  it('validasi gagal sebelum menulis apa pun: tidak ada baris, tidak ada Log, tidak ada rollback', () => {
    const a = baru();
    const sebelum = a.jumlahBaris();
    a.gagal('tambahBarang', { nama: 'Kaos', harga_beli: 'abc', foto: FOTO }, a.deni);
    a.gagal('tambahPenjualan', { kode: 'TR0000-000', metode: 'Tunai', harga_jual: 1 }, a.deni);
    assert.deepEqual(a.jumlahBaris(), sebelum);
  });

  it('Drive gagal menyimpan file: tidak ada satu pun baris yang tertulis dan kode tidak terpakai', () => {
    const a = baru();
    const sebelum = a.jumlahBaris();
    a.env.drive.failNext = 1;
    a.gagal('tambahBarang', { nama: 'Kaos', harga_beli: 30000, foto: FOTO }, a.deni, /Drive/);
    assert.deepEqual(a.jumlahBaris(), sebelum);
    assert.equal(a.tambahBarang().kode, 'TR2611-001');
  });

  it('bukti tidak valid: ditolak sebelum menyimpan file apa pun (tidak ada file yatim di Drive) dan sebelum menulis sheet', () => {
    const a = baru();
    const sebelum = a.jumlahBaris();
    const berkas = a.env.drive.files.length;
    a.gagal('tambahBarang', { nama: 'Kaos', harga_beli: 30000, foto: FOTO, bukti: 'bukan-data-url' }, a.deni, /Format gambar tidak valid/);
    assert.deepEqual(a.jumlahBaris(), sebelum);
    assert.equal(a.env.drive.files.length, berkas);
  });
});

describe('[T3] idempotensi: kirim ulang tidak menggandakan data', () => {
  it('tambahBarang dengan rid sama dua kali → satu barang, satu kas; respons kedua = respons pertama', () => {
    const a = baru();
    const p = { nama: 'Celana', harga_beli: 40000, foto: FOTO, rid: 'rid-barang-01' };
    const r1 = a.ok('tambahBarang', p, a.deni);
    const r2 = a.ok('tambahBarang', p, a.deni);
    assert.equal(a.semua().barang.length, 1);
    assert.equal(a.semua().kas.length, 1);
    assert.deepEqual(r2, r1);
    assert.equal(a.logRows().length, 1);
  });

  it('tetap aman walau cache terhapus (Log dijadikan sumber kebenaran) — respons menandai duplikat', () => {
    const a = baru();
    const p = { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 25000, keterangan: 'plastik', bukti: BUKTI, rid: 'rid-kas-0001' };
    a.ok('tambahKas', p, a.deni);
    a.env.cache = {};
    const r2 = a.ok('tambahKas', p, a.deni);
    assert.deepEqual(r2, { duplikat: true });
    assert.equal(a.semua().kas.length, 1);
    assert.deepEqual(a.saldo(), { Tunai: -25000, Rekening: 0 });
  });

  it('Pindah Saldo dikirim ulang → tetap hanya sepasang baris', () => {
    const a = baru();
    const p = { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 5000, keterangan: 'setor', bukti: BUKTI, rid: 'rid-pindah-01' };
    a.ok('tambahKas', p, a.deni); a.ok('tambahKas', p, a.deni); a.ok('tambahKas', p, a.deni);
    assert.equal(a.semua().kas.length, 2);
  });

  it('rid berbeda = transaksi berbeda (dua pengeluaran yang memang sama tetap bisa dicatat)', () => {
    const a = baru();
    const p = { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 5000, keterangan: 'lakban', bukti: BUKTI };
    a.ok('tambahKas', { ...p, rid: 'rid-aaaa-0001' }, a.deni);
    a.ok('tambahKas', { ...p, rid: 'rid-aaaa-0002' }, a.deni);
    assert.equal(a.semua().kas.length, 2);
  });

  it('percobaan yang DITOLAK tidak menghabiskan rid: setelah form diperbaiki, rid yang sama berhasil', () => {
    const a = baru();
    const p = { nama: 'Celana', harga_beli: 40000, rid: 'rid-barang-02' };
    a.gagal('tambahBarang', p, a.deni, /Foto barang wajib/);
    a.ok('tambahBarang', { ...p, foto: FOTO }, a.deni);
    assert.equal(a.semua().barang.length, 1);
  });

  it('rid tidak valid (terlalu pendek/aneh) diabaikan, bukan menyebabkan error', () => {
    const a = baru();
    const p = { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 5000, keterangan: 'x', bukti: BUKTI };
    a.ok('tambahKas', { ...p, rid: 'x' }, a.deni);
    a.ok('tambahKas', { ...p, rid: '<script>' }, a.deni);
    assert.equal(a.semua().kas.length, 2);
  });

  it('batalkan dikirim ulang dengan rid sama → sukses idempoten, bukan error "sudah batal"', () => {
    const a = baru();
    const b = a.tambahBarang();
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 90000 }, a.deni);
    const req = { jenis: 'Penjualan', id: p.id, alasan: 'salah', rid: 'rid-batal-001' };
    a.ok('batalkan', req, a.eri);
    a.ok('batalkan', req, a.eri);
    assert.equal(a.logRows().filter(l => l.aksi === 'Batal penjualan').length, 1);
  });
});

describe('[S2] validasi input', () => {
  const tanggalBuruk = ['abc', '2026-13-45', '2026-02-30', '03/11/2026', '2026-1-5', '2026-11-05', '2019-12-31', 20261103, ' '];

  it('tanggal: format YYYY-MM-DD yang nyata, tidak di masa depan (toleransi 1 hari), tidak sebelum 2020', () => {
    const a = baru();
    for (const t of tanggalBuruk.filter(x => x !== ' ')) {
      a.gagal('tambahBarang', { nama: 'X', harga_beli: 1, akun: 'Tunai', foto: FOTO, tgl_beli: t }, a.deni, /Tanggal beli/);
      a.gagal('tambahKas', { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 1, keterangan: 'x', bukti: BUKTI, tgl: t }, a.deni, /Tanggal/);
    }
    const b = a.tambahBarang({ tgl_beli: '2026-11-04' });                     // besok (selisih zona waktu) boleh
    assert.equal(a.barang(b.kode).tgl_beli, '2026-11-04');
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 1000, tgl: 'abc' }, a.deni, /Tanggal/);
    assert.equal(a.tambahBarang({ tgl_beli: '' }).tgl_beli, '2026-11-03', 'kosong → hari ini (WIB)');
    assert.equal(a.semua().penjualan.length, 0);
  });

  it('angka rupiah: hanya bilangan bulat tanpa titik/koma; "50.000" ditolak (bukan jadi Rp50)', () => {
    const a = baru();
    const buruk = ['50.000', '50,5', 50.5, -1, '-5', 'abc', '', ' ', null, undefined, '1e3', 1e12, '12345678901234', {}, [5], true, NaN, Infinity];
    for (const v of buruk) {
      a.gagal('tambahKas', { jenis: 'Masuk', akun: 'Tunai', kategori: 'Pemasukan Lain', nominal: v, keterangan: 'x', bukti: BUKTI }, a.deni);
    }
    assert.equal(a.semua().kas.length, 0);
    a.ok('tambahKas', { jenis: 'Masuk', akun: 'Tunai', kategori: 'Pemasukan Lain', nominal: 50000, keterangan: 'angka', bukti: BUKTI }, a.deni);
    a.ok('tambahKas', { jenis: 'Masuk', akun: 'Tunai', kategori: 'Pemasukan Lain', nominal: '50000', keterangan: 'teks digit', bukti: BUKTI }, a.deni);
    assert.deepEqual(a.semua().kas.map(k => k.nominal), [50000, 50000]);
    a.gagal('tambahBarang', { nama: 'X', harga_beli: '50.000', foto: FOTO }, a.deni, /Harga beli/);
    a.gagal('tambahBarang', { nama: 'X', harga_beli: 1000, harga_target: '120.000', foto: FOTO }, a.deni, /Harga target/);
    a.gagal('tambahBarang', { nama: 'X', harga_beli: '', foto: FOTO }, a.deni, /Harga beli/);
  });

  it('harga jual harus > 0; ongkir tak valid ditolak', () => {
    const a = baru();
    const b = a.tambahBarang();
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 0 }, a.deni, /lebih dari 0/);
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 1000, ongkir: '5.000' }, a.deni, /Ongkir/);
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Kredit', harga_jual: 1000 }, a.deni, /Metode bayar/);
    assert.equal(a.barang(b.kode).status, 'Tersedia');
  });

  it('ubahBarang: nama tidak boleh dikosongkan; teks panjang dipangkas; harga target divalidasi', () => {
    const a = baru();
    const b = a.tambahBarang({ nama: 'Jaket' });
    a.gagal('ubahBarang', { kode: b.kode, nama: '' }, a.deni, /Nama barang wajib/);
    a.gagal('ubahBarang', { kode: b.kode, nama: '   ' }, a.deni, /Nama barang wajib/);
    a.gagal('ubahBarang', { kode: b.kode, harga_target: '1.000' }, a.deni, /Harga target/);
    assert.equal(a.barang(b.kode).nama, 'Jaket');
    a.ok('ubahBarang', { kode: b.kode, nama: 'N'.repeat(500) }, a.deni);
    assert.equal(a.barang(b.kode).nama.length, 120);
  });

  it('ubahBarang tanpa perubahan tidak menulis apa pun (tidak ada Log)', () => {
    const a = baru();
    const b = a.tambahBarang({ nama: 'Jaket', harga_target: 120000 });
    const sebelum = a.jumlahBaris();
    a.ok('ubahBarang', { kode: b.kode, nama: 'Jaket', harga_target: '120000' }, a.deni);
    assert.deepEqual(a.jumlahBaris(), sebelum);
  });

  it('statusBarang: alasan wajib, status sama ditolak, hanya Tersedia/Rusak, barang terjual tak bisa diubah', () => {
    const a = baru();
    const b = a.tambahBarang();
    a.gagal('statusBarang', { kode: b.kode, status: 'Rusak' }, a.deni, /Alasan wajib/);
    a.gagal('statusBarang', { kode: b.kode, status: 'Tersedia', alasan: 'x' }, a.deni, /sudah berstatus/);
    a.gagal('statusBarang', { kode: b.kode, status: 'Terjual', alasan: 'x' }, a.deni, /Status tidak valid/);
    a.ok('statusBarang', { kode: b.kode, status: 'Rusak', alasan: 'sobek' }, a.deni);
    a.gagal('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 1000 }, a.deni, /berstatus Rusak/);
    a.ok('statusBarang', { kode: b.kode, status: 'Tersedia', alasan: 'dijahit' }, a.deni);
    a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 1000 }, a.deni);
    a.gagal('statusBarang', { kode: b.kode, status: 'Rusak', alasan: 'x' }, a.deni, /tidak bisa diubah/);
  });

  it('barang yang tidak ada / kode kosong → pesan jelas', () => {
    const a = baru();
    a.gagal('tambahPenjualan', { metode: 'Tunai', harga_jual: 1000 }, a.deni, /Barang tidak ditemukan/);
    a.gagal('ubahBarang', { kode: 'TR9999-999', nama: 'x' }, a.deni, /Barang tidak ditemukan/);
    a.gagal('konfirmasiCOD', { id: 'PJ-NOPE', hasil: 'Lunas' }, a.deni, /Penjualan tidak ditemukan/);
  });
});

describe('[S3] file gambar', () => {
  const jpeg = n => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(n)]).toString('base64');

  it('hanya jpeg/png/webp dengan byte awal yang cocok; HTML/SVG/PDF/lainnya ditolak dan tidak disimpan', () => {
    const a = baru();
    const html = Buffer.from('<h1>hi</h1><script>1</script>').toString('base64');
    const buruk = [
      'data:text/html;base64,' + html,
      'data:image/jpeg;base64,' + html,                       // label jpeg, isi HTML
      'data:image/svg+xml;base64,' + html,
      'data:application/pdf;base64,JVBERi0=',
      'data:image/png;base64,/9j/AAAA',                       // label png, isi jpeg
      'data:image/jpeg;base64,@@@@',
      'data:image/jpeg,/9j/AAAA',
      'http://evil.example/x.jpg',
      12345
    ];
    for (const foto of buruk) {
      a.gagal('tambahBarang', { nama: 'X', harga_beli: 0, foto }, a.deni, /Format gambar tidak valid|Gambar/);
    }
    assert.equal(a.env.drive.files.length, 0, 'tidak ada file yang boleh tersimpan');
    assert.equal(a.semua().barang.length, 0);
  });

  it('ukuran maksimum 4 MB', () => {
    const a = baru();
    a.gagal('tambahBarang', { nama: 'X', harga_beli: 0, foto: jpeg(4.3 * 1024 * 1024) }, a.deni, /terlalu besar/);
    a.ok('tambahBarang', { nama: 'X', harga_beli: 0, foto: jpeg(1024 * 1024) }, a.deni);
    assert.equal(a.env.drive.files.length, 1);
  });

  it('png dan webp yang valid diterima', () => {
    const a = baru();
    const webp = 'data:image/webp;base64,' + Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).toString('base64');
    a.ok('tambahBarang', { nama: 'X', harga_beli: 0, foto: BUKTI }, a.deni);
    a.ok('tambahBarang', { nama: 'Y', harga_beli: 0, foto: webp }, a.deni);
  });

  it('kegagalan membagikan foto (kebijakan Drive) → aksi gagal jelas, bukan foto "publik" yang tak terbuka', () => {
    const a = baru();
    a.env.drive.failSharing = true;
    a.gagal('tambahBarang', { nama: 'X', harga_beli: 0, foto: FOTO }, a.deni, /tidak bisa dibagikan/);
    assert.equal(a.semua().barang.length, 0);
  });
});

describe('[S4] data dari Sheets: tanggal, angka, teks', () => {
  it('Date dari Sheets diformat dengan zona waktu SPREADSHEET (bukan skrip) → tanggal tidak bergeser', () => {
    const a = baru({ sheetTz: 'Asia/Tokyo' });
    const b = a.ok('tambahBarang', { nama: 'Rok', harga_beli: 0, foto: FOTO }, a.deni);
    const kolom = a.env.sheets.Barang.data[0].indexOf('tgl_beli');
    a.env.sheets.Barang.data[1][kolom] = new a.env.ctx.Date('2026-11-02T15:00:00Z');   // 3 Nov 00:00 JST
    assert.equal(a.barang(b.kode).tgl_beli, '2026-11-03');
    const kPada = a.env.sheets.Barang.data[0].indexOf('dibuat_pada');
    a.env.sheets.Barang.data[1][kPada] = new a.env.ctx.Date('2026-11-02T15:30:00Z');
    assert.equal(a.barang(b.kode).dibuat_pada, '2026-11-03 00:30');
  });

  it('angka tersimpan sebagai teks ("50.000", "Rp 1.250.000") dibaca benar; yang tak terbaca dilaporkan ke admin', () => {
    const a = baru();
    const b = a.ok('tambahBarang', { nama: 'Rok', harga_beli: 10000, harga_target: 20000, foto: FOTO }, a.deni);
    const head = a.env.sheets.Barang.data[0];
    a.env.sheets.Barang.data[1][head.indexOf('harga_beli')] = '50.000';
    a.env.sheets.Barang.data[1][head.indexOf('harga_target')] = 'Rp 1.250.000';
    const x = a.barang(b.kode);
    assert.equal(x.harga_beli, 50000);
    assert.equal(x.harga_target, 1250000);
    assert.deepEqual(a.semua().peringatan, []);

    a.env.sheets.Barang.data[1][head.indexOf('harga_beli')] = 'lima puluh ribu';
    const w = a.semua().peringatan;
    assert.equal(w.length, 1);
    assert.match(w[0], /Barang.*harga_beli.*lima puluh ribu/);
    assert.deepEqual(a.semua(a.deni).peringatan, [], 'staf tidak diberi peringatan');
  });

  it('kolom teks yang berisi Date (Sheets mengubah teks jadi tanggal) dilaporkan sebagai peringatan', () => {
    const a = baru();
    a.ok('tambahBarang', { nama: 'Rok', harga_beli: 0, ukuran: 'M', foto: FOTO }, a.deni);
    a.env.sheets.Barang.data[1][a.env.sheets.Barang.data[0].indexOf('ukuran')] = new a.env.ctx.Date('2026-02-03T00:00:00Z');
    assert.match(a.semua().peringatan.join('\n'), /ukuran.*tanggal/i);
  });

  it('teks "mirip tanggal/formula/angka" tetap berupa teks (sel diformat teks sebelum ditulis)', () => {
    const a = baru();
    const b = a.ok('tambahBarang', { nama: '=1+1', ukuran: '2-3', kondisi: '3/4', sumber: '007', catatan: '+62812', harga_beli: 1000, foto: FOTO }, a.deni);
    const mentah = a.env.mentah('Barang')[0];
    assert.equal(mentah.nama, '=1+1');
    assert.equal(mentah.ukuran, '2-3');
    assert.equal(mentah.kondisi, '3/4');
    assert.equal(mentah.sumber, '007');
    assert.equal(mentah.catatan, '+62812');
    a.ok('ubahBarang', { kode: b.kode, ukuran: '10-12', catatan: '=HYPERLINK("x")' }, a.deni);
    assert.equal(a.env.mentah('Barang')[0].ukuran, '10-12');
    assert.equal(a.env.mentah('Barang')[0].catatan, '=HYPERLINK("x")');
    a.ok('tambahKas', { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 1000, keterangan: '3-4', bukti: BUKTI }, a.deni);
    assert.equal(a.env.mentah('Kas').find(k => k.kategori === 'Operasional').keterangan, '3-4');
  });

  it('baris di atas batas 1000 baris tetap benar: sheet diperluas dan format teks tetap dipasang', () => {
    const a = baru();
    const kas = a.env.sheets.Kas;
    for (let i = 0; i < 998; i++) { const r = new Array(12).fill(''); r[0] = 'K-ISI' + i; r[9] = 'Batal'; kas.data.push(r); }
    for (let i = 0; i < 6; i++) {
      a.ok('tambahKas', { jenis: 'Keluar', akun: 'Tunai', kategori: 'Operasional', nominal: 1000, keterangan: '3-4', bukti: BUKTI }, a.deni);
    }
    assert.ok(kas.getMaxRows() > 1000, 'sheet harus diperluas');
    const baris = a.env.mentah('Kas').filter(k => k.kategori === 'Operasional');
    assert.equal(baris.length, 6);
    baris.forEach(k => assert.equal(k.keterangan, '3-4', 'tetap teks di baris > 1000'));
    assert.equal(a.semua().kas.filter(k => k.status === 'Aktif').length, 6);
  });

  it('setup(): semua kolom teks berformat teks, kolom rupiah berformat angka; Log punya kolom req_id', () => {
    const a = baru();
    const cek = (sheet, kolom, harap) => {
      const s = a.env.sheets[sheet]; const c = s.data[0].indexOf(kolom) + 1;
      assert.ok(c > 0, `${sheet}.${kolom} tidak ada`);
      assert.equal(s.formatAt(2, c), harap, `${sheet}.${kolom}`);
      assert.equal(s.formatAt(900, c), harap, `${sheet}.${kolom} baris 900`);
    };
    ['id', 'kode', 'tgl_beli', 'nama', 'ukuran', 'catatan', 'status'].forEach(k => cek('Barang', k, '@'));
    ['harga_beli', 'harga_target'].forEach(k => cek('Barang', k, '#,##0'));
    ['kontak', 'pembeli', 'tgl'].forEach(k => cek('Penjualan', k, '@'));
    ['harga_jual', 'ongkir', 'diterima'].forEach(k => cek('Penjualan', k, '#,##0'));
    cek('Kas', 'keterangan', '@'); cek('Kas', 'nominal', '#,##0');
    assert.deepEqual(a.env.sheets.Log.data[0], ['waktu', 'user', 'aksi', 'detail', 'req_id']);
  });

  it('setup() dijalankan ulang: PIN, folder, dan data lama tidak berubah', () => {
    const a = baru();
    a.tambahBarang();
    const pin = a.env.props.USERS, folder = a.env.props.FOLDER_ID, foto = a.env.props.FOLDER_FOTO_ID;
    const barang = JSON.stringify(a.env.mentah('Barang'));
    a.env.ctx.setup(); a.env.ctx.setup();
    assert.equal(a.env.props.USERS, pin);
    assert.equal(a.env.props.FOLDER_ID, folder);
    assert.equal(a.env.props.FOLDER_FOTO_ID, foto);
    assert.equal(JSON.stringify(a.env.mentah('Barang')), barang);
    assert.equal(a.env.call('getAll', {}, a.eri).ok, true, 'sesi tetap berlaku bila PIN tidak diganti');
  });

  it('upgrade dari versi lama: sheet Log tanpa kolom req_id & tanpa FOLDER_FOTO_ID tetap jalan setelah setup()', () => {
    const a = baru();
    delete a.env.props.FOLDER_FOTO_ID;
    a.env.sheets.Log.data[0] = ['waktu', 'user', 'aksi', 'detail'];
    a.env.ctx.setup();
    assert.equal(a.env.sheets.Log.data[0][4], 'req_id');
    a.tambahBarang();
    assert.ok(a.env.props.FOLDER_FOTO_ID);
  });

  it('foto tetap berfungsi bila FOLDER_FOTO_ID belum ada (dibuat otomatis)', () => {
    const a = baru();
    delete a.env.props.FOLDER_FOTO_ID;
    const b = a.tambahBarang();
    assert.match(b.foto, /thumbnail/);
    assert.ok(a.env.props.FOLDER_FOTO_ID);
  });
});

describe('[S5] konsistensi & efisiensi', () => {
  it('getAll dibaca di bawah lock (snapshot konsisten): saat server sibuk → SIBUK', () => {
    const a = baru();
    a.env.lock.busy = true;
    assert.equal(a.env.call('getAll', {}, a.eri).code, 'SIBUK');
  });

  it('ubah barang menulis SATU kali ke sheet Barang (bukan satu kali per kolom)', () => {
    const a = baru();
    const b = a.tambahBarang();
    let tulisBarang = 0;
    a.env.hooks.beforeWrite = nama => { if (nama === 'Barang') tulisBarang++; };
    a.ok('ubahBarang', { kode: b.kode, nama: 'Baru', kategori: 'Jaket', ukuran: 'L', catatan: 'x' }, a.deni);
    assert.equal(tulisBarang, 1);
  });
});

describe('[S6] kode & ID', () => {
  it('kode berurutan per bulan dan reset di bulan baru', () => {
    const a = baru();
    assert.deepEqual([a.tambahBarang().kode, a.tambahBarang().kode], ['TR2611-001', 'TR2611-002']);
    a.env.setTime('2026-12-01T05:00:00Z');
    assert.equal(a.tambahBarang().kode, 'TR2612-001');
    a.env.setTime('2026-11-30T20:00:00Z');         // 1 Des 03:00 WIB → sudah Desember menurut WIB
    assert.equal(a.tambahBarang().kode, 'TR2612-002');
  });

  it('kode tidak pernah dipakai ulang walau properti urutan hilang', () => {
    const a = baru();
    a.tambahBarang(); a.tambahBarang();
    Object.keys(a.env.props).filter(k => k.startsWith('SEQ_')).forEach(k => delete a.env.props[k]);
    assert.equal(a.tambahBarang().kode, 'TR2611-003');
  });

  it('kode barang yang dibatalkan tidak dipakai ulang', () => {
    const a = baru();
    const b = a.tambahBarang();
    a.ok('batalkan', { jenis: 'Barang', id: b.kode, alasan: 'salah' }, a.eri);
    assert.equal(a.tambahBarang().kode, 'TR2611-002');
  });

  it('ID memakai 12 heksadesimal', () => {
    const a = baru();
    const b = a.tambahBarang();
    assert.match(b.id, /^B-[0-9A-F]{12}$/);
    const p = a.ok('tambahPenjualan', { kode: b.kode, metode: 'Tunai', harga_jual: 1000 }, a.deni);
    assert.match(p.id, /^PJ-[0-9A-F]{12}$/);
  });
});

describe('ringkasan nilai yang dihitung dari Kas', () => {
  it('skenario campuran: saldo akhir sesuai hitungan manual', () => {
    const a = baru();
    a.ok('tambahKas', { jenis: 'Masuk', akun: 'Rekening', kategori: 'Setoran Modal', nominal: 1000000, keterangan: 'modal', bukti: BUKTI }, a.deni);
    const b1 = a.tambahBarang({ harga_beli: 100000, akun: 'Rekening', bukti: BUKTI });
    const b2 = a.tambahBarang({ harga_beli: 60000, akun: 'Tunai' });
    a.ok('tambahPenjualan', { kode: b1.kode, metode: 'Transfer', harga_jual: 250000, bukti: BUKTI, ongkir: 12000, akun_ongkir: 'Tunai', bukti_ongkir: BUKTI }, a.deni);
    const p2 = a.ok('tambahPenjualan', { kode: b2.kode, metode: 'COD', harga_jual: 150000 }, a.deni);
    a.ok('konfirmasiCOD', { id: p2.id, hasil: 'Lunas', diterima: 138000, akun: 'Tunai', bukti: BUKTI }, a.deni);
    a.ok('tambahKas', { jenis: 'Pindah', dari: 'Tunai', ke: 'Rekening', nominal: 50000, keterangan: 'setor', bukti: BUKTI }, a.deni);
    // Tunai: -60000 -12000 +138000 -50000 = 16000 ; Rekening: +1000000 -100000 +250000 +50000 = 1200000
    assert.deepEqual(a.saldo(), { Tunai: 16000, Rekening: 1200000 });
  });
});
