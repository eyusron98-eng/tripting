'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const akar = path.join(__dirname, '..');
const baca = (...p) => fs.readFileSync(path.join(akar, ...p), 'utf8');
const ada = (...p) => fs.existsSync(path.join(akar, ...p));
const jalankan = (skrip, args, env) => cp.spawnSync(process.execPath, [path.join(akar, 'scripts', skrip), ...args], {
  encoding: 'utf8', cwd: akar, env: { ...process.env, DEPLOYMENT_ID: '', ...env }
});

describe('clasp: apps-script/', () => {
  const m = JSON.parse(baca('apps-script', 'appsscript.json'));

  it('appsscript.json: zona waktu Jakarta, runtime V8, web app dijalankan sebagai pemilik & dapat diakses anonim', () => {
    assert.equal(m.timeZone, 'Asia/Jakarta');
    assert.equal(m.runtimeVersion, 'V8');
    assert.equal(m.webapp.executeAs, 'USER_DEPLOYING');
    assert.equal(m.webapp.access, 'ANYONE_ANONYMOUS');
  });

  it('Code.gs hanya ada satu (di apps-script/), tidak ada salinan di root', () => {
    assert.ok(ada('apps-script', 'Code.gs'));
    assert.ok(!ada('Code.gs'));
  });

  it('.clasp.json.example menunjuk rootDir apps-script; .clasp.json & kredensial tidak ikut git', () => {
    assert.equal(JSON.parse(baca('.clasp.json.example')).rootDir, 'apps-script');
    const gi = baca('.gitignore').split('\n').map(s => s.trim());
    for (const x of ['.clasp.json', '.clasprc.json', '.deployment-id', 'node_modules/']) assert.ok(gi.includes(x), x + ' harus di .gitignore');
    assert.ok(!ada('.clasp.json'), '.clasp.json (berisi ID proyek pribadi) tidak boleh ada di repo');
    assert.ok(!ada('.clasprc.json'));
  });

  it('skrip npm: test, push, deploy; clasp sebagai devDependency (gratis), tanpa langkah build', () => {
    const p = JSON.parse(baca('package.json'));
    for (const s of ['test', 'push', 'deploy']) assert.ok(p.scripts[s], 'skrip ' + s);
    assert.ok(p.devDependencies['@google/clasp']);
    assert.ok(!Object.keys(p.scripts).some(k => /^(build|prebuild|postbuild)$/.test(k)));
    assert.deepEqual(Object.keys(p.dependencies || {}), [], 'tidak ada dependensi runtime');
  });
});

describe('deploy ulang ke deployment ID yang sama (URL tidak berubah)', () => {
  const ID = 'AKfycbyExampleDeploymentId1234567890abcdef';

  it('dry-run: tes → push → deploy --deploymentId <ID yang sama>; tidak pernah membuat deployment baru', () => {
    const r = jalankan('deploy.js', ['--dry-run'], { DEPLOYMENT_ID: ID });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /node --test/);
    assert.match(r.stdout, /clasp push --force/);
    assert.match(r.stdout, new RegExp('clasp deploy --deploymentId ' + ID));
    assert.ok(r.stdout.indexOf('node --test') < r.stdout.indexOf('clasp push') && r.stdout.indexOf('clasp push') < r.stdout.indexOf('clasp deploy'));
    assert.match(r.stdout, new RegExp('https://script\\.google\\.com/macros/s/' + ID + '/exec'));
    assert.doesNotMatch(r.stdout, /create-deployment/);
  });

  it('tanpa deployment ID → berhenti dengan petunjuk, bukan deploy baru', () => {
    const r = jalankan('deploy.js', ['--dry-run'], {});
    if (ada('.deployment-id')) return;    // mesin pengembang yang sudah punya .deployment-id
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Deployment ID belum diketahui/);
    assert.match(r.stderr, /clasp deployments/);
  });

  it('deployment ID yang aneh (injeksi perintah, terlalu pendek) ditolak', () => {
    for (const bad of ['AKfycby; rm -rf /', 'AKfycby$(whoami)xxxxxxxxxxxxxx', 'pendek', 'a b c d e f g h i j k l m n o p']) {
      const r = jalankan('deploy.js', ['--dry-run'], { DEPLOYMENT_ID: bad });
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /tidak valid/);
    }
  });

  it('skrip deploy memakai --deploymentId pada perintah deploy (tidak ada deploy tanpa ID)', () => {
    const src = baca('scripts', 'deploy.js');
    assert.match(src, /'deploy', '--deploymentId', id/);
    assert.doesNotMatch(src, /create-deployment/);
  });
});

describe('GitHub Pages dari branch main', () => {
  it('.nojekyll ada (berkas statis disajikan apa adanya)', () => assert.ok(ada('.nojekyll')));

  it('pages:enable (dry-run) menarget branch main, folder /', () => {
    const r = jalankan('pages-enable.js', ['--dry-run'], {});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /source\[branch\]=main/);
    assert.match(r.stdout, /source\[path\]=\//);
  });
});

describe('index.html: satu file, tanpa build, library hanya dari cdnjs', () => {
  const html = baca('index.html');

  it('API_URL tepat satu baris konstanta (placeholder atau URL /exec)', () => {
    const baris = html.split('\n').filter(l => /^\s*const API_URL\s*=/.test(l));
    assert.equal(baris.length, 1);
    assert.match(baris[0], /^const API_URL = '(TEMPEL_URL_WEB_APP_DI_SINI|https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec)';$/);
  });

  it('semua <script src> dan stylesheet eksternal berasal dari cdnjs.cloudflare.com', () => {
    const src = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(src.length >= 3);
    src.forEach(u => assert.match(u, /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\//, u));
    assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"[^>]+href="https?:/);
    assert.doesNotMatch(html, /\b(unpkg|jsdelivr|googleapis|vercel)\b/i);
  });

  it('mobile-first & bahasa Indonesia: viewport, lang="id"', () => {
    assert.match(html, /<html lang="id">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/);
  });

  it('frontend memakai token sesi (bukan PIN tersimpan) dan mengirim rid untuk tiap formulir', () => {
    assert.doesNotMatch(html, /store\.set\('tr_pin'/);
    assert.match(html, /store\.set\('tr_token'/);
    assert.match(html, /rid: newRid\(\)/);
  });

  it('kode frontend tidak menyentuh kolom saldo (saldo dihitung dari Kas)', () => {
    assert.match(html, /kas\.filter\(k => k\.status !== 'Batal'\)/);
    assert.doesNotMatch(html, /\.saldo\s*=\s*N\(/);
  });
});
