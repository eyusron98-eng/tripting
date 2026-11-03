'use strict';
const assert = require('node:assert/strict');
const { buatEnv } = require('./mock/gas');

// Byte awal sungguhan (JPEG: FF D8 FF, PNG: 89 50 4E 47 ...) supaya lolos validasi tipe file.
const FOTO = 'data:image/jpeg;base64,/9j/AAAA';
const BUKTI = 'data:image/png;base64,iVBORw0KGgo=';

/** Lingkungan baru: setup() sudah dijalankan, Eri (admin) & Deni (staf) sudah login. */
function baru(opsi) {
  const env = buatEnv(opsi);
  env.ctx.setup();
  const users = JSON.parse(env.props.USERS);
  const pin = {};
  Object.keys(users).forEach(p => { pin[users[p].nama] = p; });
  const app = { env, pin };

  app.login = nama => {
    const r = env.call('login', {}, { pin: pin[nama] });
    assert.ok(r.ok, 'login ' + nama + ' gagal: ' + r.error);
    return { nama, pin: pin[nama], token: r.data.token };
  };
  app.eri = app.login('Eri');
  app.deni = app.login('Deni');

  app.panggil = (aksi, data, sess) => env.call(aksi, data, sess);
  app.ok = (aksi, data, sess) => {
    const r = env.call(aksi, data, sess);
    assert.ok(r.ok, `${aksi} seharusnya berhasil, tetapi: ${r.error}`);
    return r.data;
  };
  app.gagal = (aksi, data, sess, pola) => {
    const r = env.call(aksi, data, sess);
    assert.equal(r.ok, false, `${aksi} seharusnya ditolak`);
    if (pola) assert.match(r.error, pola);
    return r;
  };
  app.semua = (sess = app.eri) => app.ok('getAll', {}, sess);
  app.saldo = () => {
    const s = { Tunai: 0, Rekening: 0 };
    app.semua().kas.filter(k => k.status !== 'Batal').forEach(k => { s[k.akun] += (k.jenis === 'Masuk' ? 1 : -1) * Number(k.nominal); });
    return s;
  };
  app.barang = kode => app.semua().barang.find(b => b.kode === kode);
  app.penjualan = id => app.semua().penjualan.find(p => p.id === id);
  app.kasRef = ref => app.semua().kas.filter(k => k.ref === ref);
  app.logRows = () => env.mentah('Log');
  app.jumlahBaris = () => ({ Barang: env.mentah('Barang').length, Penjualan: env.mentah('Penjualan').length, Kas: env.mentah('Kas').length, Log: env.mentah('Log').length });

  /** Tambah barang sebagai staf (Deni) dengan data lengkap. */
  app.tambahBarang = (over = {}, sess = app.deni) => app.ok('tambahBarang',
    Object.assign({ nama: 'Jaket denim', harga_beli: 50000, harga_target: 120000, akun: 'Tunai', foto: FOTO }, over), sess);
  return app;
}

module.exports = { baru, FOTO, BUKTI };
