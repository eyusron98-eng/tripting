'use strict';
/**
 * Mock layanan Google Apps Script untuk menjalankan apps-script/Code.gs di Node.
 * Tanpa dependensi. Mencakup: SpreadsheetApp, DriveApp, PropertiesService,
 * LockService, CacheService, Utilities, ContentService, Logger.
 *
 * Catatan kejujuran: ini model, bukan Google Sheets asli. Perilaku "Sheets mengubah
 * teks jadi tanggal/formula bila sel tidak berformat teks" ditiru dari pengalaman,
 * bukan dari spesifikasi resmi; lihat checklist smoke test di README.
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KODE_DEFAULT = path.join(__dirname, '..', '..', 'apps-script', 'Code.gs');

function formatDate(d, tz, pattern) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
  const peta = { yyyy: p.year, yy: p.year.slice(2), MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second };
  return pattern.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, t => peta[t]);
}

class Sheet {
  constructor(env, name) {
    this.env = env; this.name = name;
    this.data = [];            // array baris (1-based di API, 0-based di sini)
    this.formats = new Map();  // "r:c" -> pola format
    this.maxRows = 1000; this.frozen = 0;
  }
  getMaxRows() { return this.maxRows; }
  setFrozenRows(n) { this.frozen = n; }
  insertRowsAfter(pos, n) { this.maxRows += n; }
  getLastRow() {
    for (let i = this.data.length; i > 0; i--) {
      if (this.data[i - 1].some(v => v !== '' && v !== null && v !== undefined)) return i;
    }
    return 0;
  }
  formatAt(r, c) { return this.formats.get(r + ':' + c) || 'General'; }
  _hook() { if (this.env.hooks.beforeWrite) this.env.hooks.beforeWrite(this.name); }
  _tulis(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    // Tiruan perilaku Sheets (USER_ENTERED) pada sel yang BUKAN teks biasa:
    if (typeof v === 'string' && this.formatAt(r, c) !== '@') {
      if (/^=/.test(v)) v = '#FORMULA!';
      else if (/^\d{1,2}[-/]\d{1,2}$/.test(v)) v = new this.env.ctx.Date(Date.UTC(2026, Number(v.split(/[-/]/)[0]) - 1, Number(v.split(/[-/]/)[1])));
      else if (/^\d+$/.test(v)) v = Number(v);
    }
    row[c - 1] = v;
  }
  appendRow(arr) {
    this._hook();
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.maxRows = r;      // appendRow memperluas sheet otomatis
    arr.forEach((v, j) => this._tulis(r, j + 1, v));
  }
  getDataRange() {
    return {
      getValues: () => {
        this.env.reads++;
        const last = this.getLastRow();
        const w = Math.max(0, ...this.data.slice(0, last).map(r => r.length));
        return this.data.slice(0, last).map(r => { const x = r.slice(); while (x.length < w) x.push(''); return x; });
      }
    };
  }
  getRange(r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || r + nr - 1 > this.maxRows) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    const self = this;
    const rg = {
      getValues() {
        self.env.reads++;
        return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
          const v = (self.data[r - 1 + i] || [])[c - 1 + j];
          return v === undefined || v === null ? '' : v;
        }));
      },
      getValue() { return rg.getValues()[0][0]; },
      setValues(vals) { self._hook(); vals.forEach((row, i) => row.forEach((v, j) => self._tulis(r + i, c + j, v))); return rg; },
      setValue(v) { self._hook(); self._tulis(r, c, v); return rg; },
      setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) self.formats.set((r + i) + ':' + (c + j), f); return rg; },
      setNumberFormats(fs2) { fs2.forEach((row, i) => row.forEach((f, j) => self.formats.set((r + i) + ':' + (c + j), f))); return rg; },
      setFontWeight() { return rg; }
    };
    return rg;
  }
}

function buatEnv(opsi = {}) {
  const kodePath = process.env.GAS_CODE || opsi.kode || KODE_DEFAULT;
  const env = {
    sheets: {}, props: {}, cache: {}, logs: [], hooks: {}, reads: 0,   // reads = berapa kali sheet dibaca (untuk menguji cache)
    clock: { now: Date.parse(opsi.waktu || '2026-11-03T03:00:00Z') },   // 10:00 WIB
    sheetTz: opsi.sheetTz || 'Asia/Jakarta',
    lock: { held: false, busy: false, kali: 0 },
    drive: { folders: {}, files: [], failNext: 0, failSharing: false, n: 0 }
  };

  // --- jam terkendali: Date di dalam konteks skrip ---
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(env.clock.now); else super(...a); }
    static now() { return env.clock.now; }
  }
  env.advance = ms => { env.clock.now += ms; };
  env.setTime = iso => { env.clock.now = Date.parse(iso); };

  const ss = {
    getSheetByName: n => env.sheets[n] || null,
    insertSheet: n => (env.sheets[n] = new Sheet(env, n)),
    getSheets: () => Object.values(env.sheets),
    deleteSheet: s => { delete env.sheets[s.name]; },
    getSpreadsheetTimeZone: () => env.sheetTz
  };

  const ttl = (k) => { const e = env.cache[k]; if (!e) return null; if (e.exp <= env.clock.now) { delete env.cache[k]; return null; } return e.v; };

  const ctx = {
    console, Date: FakeDate,
    Logger: { log: m => env.logs.push(String(m)) },
    SpreadsheetApp: { getActive: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (Object.prototype.hasOwnProperty.call(env.props, k) ? env.props[k] : null),
        setProperty: (k, v) => { env.props[k] = String(v); },
        deleteProperty: k => { delete env.props[k]; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => ttl(k),
        put: (k, v, detik = 600) => { env.cache[k] = { v: String(v), exp: env.clock.now + detik * 1000 }; },
        remove: k => { delete env.cache[k]; }
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          if (env.lock.busy) throw new Error('Lock timeout: another process was holding the lock for too long.');
          if (env.lock.held) throw new Error('MOCK: lock diambil bersarang (akan deadlock di Apps Script asli)');
          env.lock.held = true; env.lock.kali++;
        },
        releaseLock: () => { env.lock.held = false; }
      })
    },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      // Apps Script mengembalikan byte BERTANDA (-128..127)
      base64Decode: s => Array.from(new Int8Array(Buffer.from(s, 'base64'))),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name })
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { VIEW: 'VIEW', NONE: 'NONE' },
      createFolder: nama => {
        const id = 'FOLDER' + (++env.drive.n);
        env.drive.folders[id] = { id, nama, akses: 'PRIVATE' };
        return folderApi(id);
      },
      getFolderById: id => { if (!env.drive.folders[id]) throw new Error('Folder tidak ditemukan: ' + id); return folderApi(id); }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: t => ({ t, setMimeType() { return this; }, getContent() { return this.t; } })
    }
  };

  function folderApi(id) {
    return {
      getId: () => id,
      getSharingAccess: () => env.drive.folders[id].akses,
      createFile: blob => {
        if (env.drive.failNext > 0) { env.drive.failNext--; throw new Error('Drive: layanan tidak tersedia'); }
        const f = { id: 'FILE' + (++env.drive.n), nama: blob.name, mime: blob.mime, ukuran: blob.bytes.length, folder: id, sharing: null };
        env.drive.files.push(f);
        return {
          getId: () => f.id,
          setSharing: (akses, izin) => { if (env.drive.failSharing) throw new Error('Kebijakan domain melarang berbagi'); f.sharing = akses; }
        };
      }
    };
  }

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(kodePath, 'utf8'), ctx, { filename: 'Code.gs' });
  env.ctx = ctx;

  /** Kirim request seperti frontend. sess = {pin, token} atau string PIN. */
  env.call = (action, data, sess) => {
    const s = typeof sess === 'string' ? { pin: sess } : (sess || {});
    const body = { action, pin: s.pin, token: s.token, data };
    return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  };
  env.callRaw = isi => JSON.parse(ctx.doPost({ postData: { contents: isi } }).getContent());

  /** Gagal-kan N penulisan pertama ke sheet tertentu (setelah melewati `lewati` penulisan). */
  env.gagalTulis = (sheet, { kali = 1, lewati = 0 } = {}) => {
    let skip = lewati, sisa = kali;
    env.hooks.beforeWrite = nama => {
      if (nama !== sheet) return;
      if (skip > 0) { skip--; return; }
      if (sisa > 0) { sisa--; throw new Error('Service Spreadsheets timed out (simulasi)'); }
    };
  };
  env.normal = () => { env.hooks.beforeWrite = null; };

  /** Baris mentah sheet sebagai objek (memakai header baris 1). */
  env.mentah = nama => {
    const s = env.sheets[nama]; const head = s.data[0];
    return s.data.slice(1).filter(r => r.some(v => v !== '')).map(r => Object.fromEntries(head.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
  };
  return env;
}

module.exports = { buatEnv, formatDate };
