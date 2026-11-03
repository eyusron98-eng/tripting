#!/usr/bin/env node
'use strict';
/**
 * Mengaktifkan GitHub Pages dari branch main (root) memakai gh CLI.
 *   npm run pages:enable            # perlu: gh auth login (akun pemilik repo)
 *   npm run pages:enable -- --dry-run
 * Bila gh tidak ada/belum login: Settings → Pages → Build and deployment →
 * Source "Deploy from a branch" → Branch main, folder / (root) → Save.
 */
const cp = require('node:child_process');
const dry = process.argv.includes('--dry-run');
const REPO = 'repos/{owner}/{repo}/pages';   // gh mengisi {owner}/{repo} dari git remote
const buat = ['api', '-X', 'POST', REPO, '-f', 'source[branch]=main', '-f', 'source[path]=/'];
const ubah = ['api', '-X', 'PUT', REPO, '-f', 'source[branch]=main', '-f', 'source[path]=/'];
const cek = ['api', REPO];

if (dry) {
  console.log('[dry-run] perintah yang akan dijalankan:');
  [cek, buat, ubah].forEach(a => console.log('  gh ' + a.join(' ')));
  process.exit(0);
}

const gh = args => cp.spawnSync('gh', args, { encoding: 'utf8' });
const v = gh(['--version']);
if (v.error || v.status !== 0) {
  console.error('gh CLI tidak ditemukan. Aktifkan manual: Settings → Pages → Deploy from a branch → main / (root).');
  process.exit(2);
}
const ada = gh(cek);
const r = ada.status === 0 ? gh(ubah) : gh(buat);   // sudah ada → pastikan sumbernya main:/ ; belum → buat
if (r.status !== 0 && !/already|409|422/.test((r.stderr || '') + (r.stdout || ''))) {
  console.error((r.stderr || r.stdout || 'gh gagal').trim());
  console.error('\nJika ini masalah izin/login: jalankan `gh auth login`, atau aktifkan manual di Settings → Pages.');
  process.exit(1);
}
const info = gh(cek);
try { console.log('Pages aktif: ' + JSON.parse(info.stdout).html_url); } catch (e) { console.log('Pages diaktifkan. Cek: gh api ' + REPO); }
console.log('Build pertama butuh ±1–2 menit.');
