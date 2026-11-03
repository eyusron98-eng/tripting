#!/usr/bin/env node
'use strict';
/**
 * Push apps-script/ ke proyek Apps Script, lalu deploy ulang ke deployment YANG SAMA
 * (URL web app tidak berubah, jadi API_URL di index.html tidak perlu diedit).
 *
 *   npm run deploy            # tes → clasp push → clasp deploy -i <deploymentId>
 *   npm run deploy -- --dry-run   # hanya mencetak apa yang akan dijalankan
 *
 * Deployment ID dibaca dari env DEPLOYMENT_ID atau file .deployment-id (tidak di-commit).
 * Dapatkan dengan: npx clasp deployments   (pilih yang BUKAN "@HEAD").
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const akar = path.join(__dirname, '..');
const dry = process.argv.includes('--dry-run');
const ID_VALID = /^[A-Za-z0-9_-]{20,}$/;

function gagal(pesan, kode) { console.error('\n' + pesan + '\n'); process.exit(kode || 1); }

function deploymentId() {
  let id = (process.env.DEPLOYMENT_ID || '').trim();
  if (!id) { try { id = fs.readFileSync(path.join(akar, '.deployment-id'), 'utf8').trim(); } catch (e) { /* belum ada */ } }
  return id;
}

const id = deploymentId();
if (!id) {
  gagal('Deployment ID belum diketahui.\n' +
    'Deploy PERTAMA dilakukan manual (lihat README, bagian "Deploy pertama"). Setelah itu:\n' +
    '  npx clasp deployments            → salin ID deployment (bukan @HEAD)\n' +
    '  echo <ID> > .deployment-id       → simpan, atau set env DEPLOYMENT_ID', 2);
}
if (!ID_VALID.test(id)) gagal('Deployment ID tidak valid (hanya huruf, angka, "-" dan "_"; minimal 20 karakter).', 2);

const clasp = path.join(akar, 'node_modules', '@google', 'clasp', 'build', 'src', 'index.js');
const deskripsi = (() => {
  try { return 'deploy ' + cp.execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: akar, encoding: 'utf8' }).trim() + ' ' + new Date().toISOString().slice(0, 16); }
  catch (e) { return 'deploy ' + new Date().toISOString().slice(0, 16); }
})();

const langkah = [
  { nama: 'tes', cmd: process.execPath, args: ['--test'] },
  { nama: 'push', cmd: process.execPath, args: [clasp, 'push', '--force'] },
  { nama: 'deploy', cmd: process.execPath, args: [clasp, 'deploy', '--deploymentId', id, '--description', deskripsi] }
];

if (dry) {
  console.log('[dry-run] tidak ada yang dijalankan. Urutan langkah:');
  console.log('  1. node --test');
  console.log('  2. clasp push --force');
  console.log('  3. clasp deploy --deploymentId ' + id + ' --description "' + deskripsi + '"');
  console.log('URL web app (tidak berubah): https://script.google.com/macros/s/' + id + '/exec');
  process.exit(0);
}

let proyek;
try { proyek = JSON.parse(fs.readFileSync(path.join(akar, '.clasp.json'), 'utf8')); } catch (e) { /* ditangani di bawah */ }
if (!proyek || !proyek.scriptId || /^ISI_/.test(proyek.scriptId)) {
  gagal('.clasp.json belum diisi. Salin .clasp.json.example menjadi .clasp.json dan isi scriptId\n(Apps Script → Setelan proyek → ID Skrip).', 2);
}

for (const l of langkah) {
  console.log('\n▶ ' + l.nama);
  const r = cp.spawnSync(l.cmd, l.args, { cwd: akar, stdio: 'inherit' });
  if (r.status !== 0) gagal('Langkah "' + l.nama + '" gagal (kode ' + r.status + '). Deploy dihentikan; deployment lama tidak berubah.');
}
console.log('\n✔ Selesai. URL web app (tidak berubah): https://script.google.com/macros/s/' + id + '/exec');
console.log('  Bila ini deploy pertama setelah menambah izin baru, buka URL sekali / jalankan setup() ulang untuk otorisasi.');
