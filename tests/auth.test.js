'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { baru } = require('./helpers');

const MENIT = 60 * 1000;

describe('login & sesi', () => {
  it('PIN benar → token, nama, dan role', () => {
    const a = baru();
    const r = a.env.call('login', {}, { pin: a.pin.Eri });
    assert.equal(r.ok, true);
    assert.equal(r.data.nama, 'Eri');
    assert.equal(r.data.role, 'admin');
    assert.match(r.data.token, /^[0-9a-f]{64}$/);
    assert.equal(a.env.call('login', {}, { pin: a.pin.Deni }).data.role, 'staf');
  });

  it('PIN salah ditolak dengan kode PIN_SALAH', () => {
    const a = baru();
    const r = a.env.call('login', {}, { pin: '000000' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PIN salah');
    assert.equal(r.code, 'PIN_SALAH');
  });

  it('[K1] PIN berupa nama properti prototype tidak lolos dan dihitung sebagai gagal', () => {
    const a = baru();
    for (const pin of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      const r = a.env.call('login', {}, { pin });
      assert.equal(r.ok, false, `PIN "${pin}" tidak boleh lolos`);
      assert.equal(r.code, 'PIN_SALAH');
      const g = a.env.call('getAll', {}, { pin });
      assert.equal(g.ok, false, `getAll dengan PIN "${pin}" tidak boleh lolos`);
    }
    assert.equal(JSON.parse(a.env.props.AUTH_FAIL).n, 6, 'setiap percobaan harus tercatat sebagai gagal');
  });

  it('[K1] PIN bukan 6 digit (spasi, huruf, angka dikali) ditolak', () => {
    const a = baru();
    for (const pin of ['', ' ', '12345', '1234567', 'abcdef', null, undefined, 123456.5, {}, [a.pin.Eri]]) {
      assert.equal(a.env.call('login', {}, { pin }).ok, false);
    }
  });

  it('aksi selain login wajib memakai token — PIN mentah ditolak', () => {
    const a = baru();
    const r = a.env.call('getAll', {}, { pin: a.pin.Eri });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SESI');
  });

  it('token acak/palsu/tipe salah ditolak', () => {
    const a = baru();
    for (const token of ['', 'abc', 'f'.repeat(64), null, 12345, { a: 1 }, 'constructor', '__proto__']) {
      const r = a.env.call('getAll', {}, { token });
      assert.equal(r.ok, false, `token ${JSON.stringify(token)} tidak boleh lolos`);
      assert.equal(r.code, 'SESI');
    }
  });

  it('token kedaluwarsa setelah 30 hari', () => {
    const a = baru();
    a.env.advance(29 * 24 * 60 * MENIT);
    assert.equal(a.env.call('getAll', {}, a.eri).ok, true);
    a.env.advance(2 * 24 * 60 * MENIT);
    const r = a.env.call('getAll', {}, a.eri);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SESI');
  });

  it('keluar mencabut token', () => {
    const a = baru();
    a.ok('keluar', {}, a.deni);
    assert.equal(a.env.call('getAll', {}, a.deni).code, 'SESI');
    assert.equal(a.env.call('getAll', {}, a.eri).ok, true, 'sesi lain tidak terpengaruh');
  });

  it('mengganti USERS (PIN baru) mencabut semua sesi lama', () => {
    const a = baru();
    delete a.env.props.USERS;
    a.env.ctx.setup();
    assert.equal(a.env.call('getAll', {}, a.eri).code, 'SESI');
    assert.equal(a.env.call('getAll', {}, a.deni).code, 'SESI');
  });

  it('jumlah sesi dibatasi (sesi terlama tergusur) dan sesi kedaluwarsa dibersihkan', () => {
    const a = baru();
    for (let i = 0; i < 60; i++) a.login('Deni');
    assert.ok(Object.keys(JSON.parse(a.env.props.SESSIONS)).length <= 40);
    a.env.advance(31 * 24 * 60 * MENIT);
    a.login('Eri');
    assert.equal(Object.keys(JSON.parse(a.env.props.SESSIONS)).length, 1);
  });

  it('role dibaca dari USERS tiap request (bukan dari token)', () => {
    const a = baru();
    const users = JSON.parse(a.env.props.USERS);
    users[a.pin.Deni].role = 'admin';
    a.env.props.USERS = JSON.stringify(users);
    assert.equal(a.ok('getAll', {}, a.deni).user.role, 'admin');
  });
});

describe('lockout PIN', () => {
  const salah = (a, n) => { for (let i = 0; i < n; i++) a.env.call('login', {}, { pin: '000000' }); };

  it('20 kali salah → bahkan PIN benar ditolak (TERKUNCI)', () => {
    const a = baru();
    salah(a, 20);
    const r = a.env.call('login', {}, { pin: a.pin.Eri });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TERKUNCI');
    assert.match(r.error, /Terlalu banyak percobaan/);
  });

  it('19 kali salah belum mengunci', () => {
    const a = baru();
    salah(a, 19);
    assert.equal(a.env.call('login', {}, { pin: a.pin.Eri }).ok, true);
  });

  it('terbuka lagi 15 menit setelah kegagalan terakhir, dan tidak diperpanjang oleh percobaan saat terkunci', () => {
    const a = baru();
    salah(a, 20);                       // terkunci pada t0
    a.env.advance(14 * MENIT);
    salah(a, 5);                        // percobaan saat terkunci TIDAK memperpanjang
    assert.equal(a.env.call('login', {}, { pin: a.pin.Eri }).code, 'TERKUNCI');
    a.env.advance(1 * MENIT + 1000);    // total > 15 menit sejak t0
    assert.equal(a.env.call('login', {}, { pin: a.pin.Eri }).ok, true);
  });

  it('login yang berhasil TIDAK mereset penghitung (penyerang yang tahu PIN staf tak boleh dapat tebakan tak terbatas)', () => {
    const a = baru();
    salah(a, 19);
    assert.equal(a.env.call('login', {}, { pin: a.pin.Deni }).ok, true);   // sukses di tengah serangan
    salah(a, 1);                                                          // kegagalan ke-20
    assert.equal(a.env.call('login', {}, { pin: a.pin.Eri }).code, 'TERKUNCI');
  });

  it('[S1] pengguna yang sudah punya sesi tidak ikut terkunci (serangan terhadap URL publik tak melumpuhkan toko)', () => {
    const a = baru();
    salah(a, 50);
    assert.equal(a.env.call('getAll', {}, a.eri).ok, true);
    assert.equal(a.env.call('getAll', {}, a.deni).ok, true);
    assert.equal(a.env.call('login', {}, { pin: a.pin.Eri }).code, 'TERKUNCI', 'login baru tetap terkunci');
  });

  it('[S1] kejadian terkunci dicatat di Log tepat satu kali', () => {
    const a = baru();
    salah(a, 40);
    const baris = a.logRows().filter(l => l.aksi === 'Login terkunci');
    assert.equal(baris.length, 1);
    assert.equal(baris[0].user, 'SISTEM');
  });

  it('penghitung kegagalan disimpan permanen (bukan CacheService yang bisa terhapus)', () => {
    const a = baru();
    salah(a, 20);
    a.env.cache = {};                   // cache dikosongkan
    assert.equal(a.env.call('login', {}, { pin: a.pin.Eri }).code, 'TERKUNCI');
  });
});

describe('dispatch aksi & lock', () => {
  it('[R1] nama aksi berupa properti prototype ditolak dengan pesan yang jelas', () => {
    const a = baru();
    for (const aksi of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const r = a.env.call(aksi, { a: 1 }, a.eri);
      assert.equal(r.ok, false, aksi);
      assert.match(r.error, /Aksi tidak dikenal/);
    }
  });

  it('body bukan JSON / bukan objek → ditolak rapi', () => {
    const a = baru();
    for (const isi of ['bukan json', 'null', '"teks"', '123']) {
      const r = a.env.callRaw(isi);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'REQ');
    }
  });

  it('lock selalu dilepas, juga saat aksi gagal', () => {
    const a = baru();
    a.gagal('tambahBarang', { nama: '', harga_beli: 1 }, a.deni);
    assert.equal(a.env.lock.held, false);
    a.ok('getAll', {}, a.eri);
    assert.equal(a.env.lock.held, false);
  });

  it('[S5] server sibuk → pesan Indonesia yang ramah, bukan error Lock timeout', () => {
    const a = baru();
    a.env.lock.busy = true;
    const r = a.env.call('tambahBarang', { nama: 'X', harga_beli: 1, foto: 'x' }, a.deni);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SIBUK');
    assert.match(r.error, /sibuk/i);
    assert.doesNotMatch(r.error, /Lock timeout/);
  });
});
