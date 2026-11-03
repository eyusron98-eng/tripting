'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const akar = path.join(__dirname, '..');
const halaman = fs.readFileSync(path.join(akar, 'katalog.html'), 'utf8');
const indeks = fs.readFileSync(path.join(akar, 'index.html'), 'utf8');

// Ambil bagian "LOGIKA MURNI" dari katalog.html dan jalankan tanpa DOM.
const blok = /\/\* ==== LOGIKA MURNI[^\n]*\n([\s\S]*?)\/\* ==== AKHIR LOGIKA MURNI ==== \*\//.exec(halaman);
const L = vm.runInNewContext(blok[1] + '\n({ rupiah, hargaTeks, pesanWA, linkWA, saring, kategoriUnik, fotoUkuran, kodeDariHash, tanggalPendek })', { encodeURIComponent });
const NOMOR = /const WA_NOMOR = '(\d+)'/.exec(halaman)[1];

describe('katalog.html: logika murni', () => {
  it('rupiah & harga: titik ribuan, 0/tak valid → "Tanya harga"', () => {
    assert.equal(L.rupiah(120000), 'Rp120.000');
    assert.equal(L.rupiah(1234567), 'Rp1.234.567');
    assert.equal(L.rupiah(0), 'Rp0');
    assert.equal(L.rupiah('abc'), 'Rp0');
    assert.equal(L.hargaTeks(45000), 'Rp45.000');
    for (const h of [0, '', null, undefined, NaN, -5]) assert.equal(L.hargaTeks(h), 'Tanya harga');
  });

  it('pesan WhatsApp memuat nama, kode, dan harga; beda untuk pesan / tanya / umum', () => {
    const b = { nama: 'Jaket denim', kode: 'TR2611-001', harga: 120000 };
    assert.equal(L.pesanWA(b, 'pesan', 'Tripting'), 'Halo Kak, saya mau pesan Jaket denim (kode TR2611-001, Rp120.000). Apakah masih tersedia?');
    assert.equal(L.pesanWA(b, 'tanya', 'Tripting'), 'Halo Kak, saya mau tanya soal Jaket denim (kode TR2611-001, Rp120.000).');
    assert.match(L.pesanWA(null, '', 'Tripting'), /katalog Tripting/);
    assert.match(L.pesanWA({ ...b, harga: 0 }, 'pesan', 'Tripting'), /Tanya harga/);
  });

  it('link WhatsApp: nomor benar dan teks terkodekan utuh, juga untuk karakter berbahaya (& # ? " baris baru emoji)', () => {
    const teks = 'Nama & Co #1? "kutip"\nbaris 2 😀 100% <b>';
    const u = new URL(L.linkWA(NOMOR, teks));
    assert.equal(u.origin, 'https://wa.me');
    assert.equal(u.pathname, '/' + NOMOR);
    assert.equal(u.searchParams.get('text'), teks);
    assert.equal([...u.searchParams.keys()].join(), 'text', 'tidak ada parameter siluman dari teks barang');
    assert.equal(u.hash, '');
  });

  it('pencarian: tiap kata harus cocok (AND), tak peka huruf, mencari di nama/kategori/ukuran/kondisi/kode; filter kategori', () => {
    const d = [
      { kode: 'TR2611-001', nama: 'Jaket denim', kategori: 'Jaket', ukuran: 'M', kondisi: 'Baik' },
      { kode: 'TR2611-002', nama: 'Kaos band', kategori: 'Kaos', ukuran: 'L', kondisi: 'Seperti baru' },
      { kode: 'TR2611-003', nama: 'Kaos polos', kategori: 'Kaos', ukuran: 'M', kondisi: 'Ada minus' }];
    assert.equal(L.saring(d, '', '').length, 3);
    assert.deepEqual(L.saring(d, 'KAOS m', '').map(b => b.kode), ['TR2611-003']);
    assert.deepEqual(L.saring(d, 'seperti baru', '').map(b => b.kode), ['TR2611-002']);
    assert.deepEqual(L.saring(d, '2611-001', '').map(b => b.kode), ['TR2611-001']);
    assert.deepEqual(L.saring(d, '', 'Kaos').map(b => b.kode), ['TR2611-002', 'TR2611-003']);
    assert.deepEqual(L.saring(d, 'band', 'Jaket'), []);
    assert.deepEqual(L.saring(d, '   ', '').length, 3);
  });

  it('kategori: unik, tanpa kosong, urut jumlah terbanyak lalu abjad', () => {
    const d = [{ kategori: 'Kaos' }, { kategori: 'Jaket' }, { kategori: 'Kaos' }, { kategori: '' }, { kategori: 'Celana' }];
    assert.deepEqual([...L.kategoriUnik(d)], ['Kaos', 'Celana', 'Jaket']);   // salin: array dari vm berbeda realm
  });

  it('ukuran foto diganti; kosong tetap kosong', () => {
    assert.equal(L.fotoUkuran('https://drive.google.com/thumbnail?id=ABC&sz=w800', 400), 'https://drive.google.com/thumbnail?id=ABC&sz=w400');
    assert.equal(L.fotoUkuran('', 400), '');
  });

  it('hash tautan barang: hanya kode yang valid', () => {
    assert.equal(L.kodeDariHash('#TR2611-001'), 'TR2611-001');
    assert.equal(L.kodeDariHash('#TR2611-1234'), 'TR2611-1234');
    for (const x of ['', '#', '#TR2611-1', '#<script>alert(1)</script>', '#../x', '#tr2611-001', '#TR2611-001<', undefined, null]) assert.equal(L.kodeDariHash(x), '', String(x));
  });

  it('tanggal pembaruan: dd/MM/yyyy HH:mm WIB', () => {
    assert.equal(L.tanggalPendek('2026-11-03 10:05'), '03/11/2026 10:05 WIB');
    assert.equal(L.tanggalPendek('rusak'), '');
  });
});

describe('katalog.html: aturan statis', () => {
  it('nomor WhatsApp berformat ponsel Indonesia (628…), persis nomor Deni', () => {
    assert.match(NOMOR, /^628\d{8,12}$/, 'nomor ponsel Indonesia diawali 628');
    assert.equal(NOMOR, '6283846834142');
  });

  it('API_URL sama persis dengan index.html (satu backend, tidak boleh berbeda)', () => {
    const a = /^const API_URL = '([^']+)';$/m.exec(halaman)[1];
    const b = /^const API_URL = '([^']+)';$/m.exec(indeks)[1];
    assert.equal(a, b);
    assert.match(a, /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/);
  });

  it('tidak ada cara menyisipkan HTML/skrip dari data: tanpa innerHTML, eval, document.write', () => {
    assert.doesNotMatch(halaman, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|srcdoc/);
  });

  it('tidak memuat apa pun dari pihak ketiga: tanpa <script src>, stylesheet/gambar/font luar, @import; fetch hanya ke API_URL', () => {
    assert.doesNotMatch(halaman, /<script[^>]+src=/i);
    assert.doesNotMatch(halaman, /<link[^>]+href=/i);
    assert.doesNotMatch(halaman, /@import|url\(\s*['"]?https?:/i);
    assert.doesNotMatch(halaman, /<img[^>]+src="https?:/i);
    const fetches = halaman.match(/\bfetch\(/g) || [];
    assert.equal(fetches.length, 1);
    assert.match(halaman, /fetch\(API_URL,/);
  });

  it('halaman tidak pernah menyentuh kolom privat, token, atau sesi admin', () => {
    for (const x of ['harga_beli', 'sumber', 'catatan', 'dibuat_oleh', 'dibuat_pada', 'tgl_beli', 'tr_token', 'tr_pin', 'token', 'getAll', 'USERS']) {
      assert.ok(!halaman.includes(x), `katalog.html menyebut "${x}"`);
    }
    assert.doesNotMatch(halaman, /index\.html/, 'tidak mengiklankan halaman admin');
  });

  it('semua properti barang yang dipakai halaman ada di 8 kolom yang dikirim backend', () => {
    const boleh = new Set(['kode', 'nama', 'kategori', 'ukuran', 'kondisi', 'harga', 'foto', 'status']);
    const dipakai = new Set([...halaman.matchAll(/\b[bx]\.([a-z_]+)/g)].map(m => m[1]));
    assert.ok(dipakai.size >= 7);
    for (const p of dipakai) assert.ok(boleh.has(p), `halaman memakai properti "${p}" yang tidak dikirim backend`);
  });

  it('semua tautan target=_blank memakai rel="noopener noreferrer"', () => {
    const target = (halaman.match(/target(=|:\s*)['"]_blank['"]/g) || []).length;
    const rel = (halaman.match(/rel(=|:\s*)['"]noopener noreferrer['"]/g) || []).length;
    assert.ok(target >= 5);
    assert.equal(rel, target);
  });

  it('mobile-first, bahasa Indonesia, ringan (< 40 KB, tanpa Babel/React)', () => {
    assert.match(halaman, /<html lang="id">/);
    assert.match(halaman, /<meta name="viewport" content="width=device-width, initial-scale=1/);
    assert.ok(Buffer.byteLength(halaman) < 40 * 1024);
    assert.doesNotMatch(halaman, /babel|react/i);
  });

  it('aplikasi admin (index.html) tidak mengarah ke katalog dan tidak berubah perilakunya: masih satu file dengan API_URL satu baris', () => {
    assert.equal(indeks.split('\n').filter(l => /^\s*const API_URL\s*=/.test(l)).length, 1);
  });
});
