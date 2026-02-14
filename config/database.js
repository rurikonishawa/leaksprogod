/**
 * sql.js wrapper — exposes the same API as better-sqlite3 so every
 * other file (Video.js, routes, websocket) works without changes.
 * Pure-JS, zero native deps — runs on Windows, Linux, macOS, Render, etc.
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'leakspro.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/*  Compatibility wrapper that mimics better-sqlite3 on top of sql.js */
/* ------------------------------------------------------------------ */
class SqliteCompat {
  constructor(sqlDb) {
    this._db = sqlDb;
    this._saveTimer = null;
  }

  /* ---- persist to disk (debounced so rapid writes don't thrash) ---- */
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const data = this._db.export();
        fs.writeFileSync(DB_PATH, Buffer.from(data));
      } catch (e) {
        console.error('[DB] save error:', e.message);
      }
    }, 100);
  }

  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const data = this._db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  /* ---- helpers to convert sql.js rows → objects ---- */
  _rowsToObjects(stmt) {
    const cols = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      const vals = stmt.get();
      const obj = {};
      cols.forEach((c, i) => { obj[c] = vals[i]; });
      rows.push(obj);
    }
    stmt.free();
    return rows;
  }

  /* ---- mimic better-sqlite3's db.prepare() ---- */
  prepare(sql) {
    const self = this;
    return {
      all(...params) {
        const flat = params.flat();
        const stmt = self._db.prepare(sql);
        if (flat.length) stmt.bind(flat);
        const rows = self._rowsToObjects(stmt);
        return rows;
      },
      get(...params) {
        const flat = params.flat();
        const stmt = self._db.prepare(sql);
        if (flat.length) stmt.bind(flat);
        const cols = stmt.getColumnNames();
        let obj;
        if (stmt.step()) {
          const vals = stmt.get();
          obj = {};
          cols.forEach((c, i) => { obj[c] = vals[i]; });
        }
        stmt.free();
        return obj; // undefined when no row found (same as better-sqlite3)
      },
      run(...params) {
        const flat = params.flat();
        self._db.run(sql, flat);
        self._scheduleSave();
        return {
          changes: self._db.getRowsModified(),
          lastInsertRowid: self._lastInsertRowid(),
        };
      },
    };
  }

  _lastInsertRowid() {
    const stmt = this._db.prepare('SELECT last_insert_rowid() as id');
    stmt.step();
    const id = stmt.get()[0];
    stmt.free();
    return id;
  }

  /* ---- mimic db.exec() ---- */
  exec(sql) {
    this._db.exec(sql);
    this._scheduleSave();
  }

  /* ---- mimic db.pragma() ---- */
  pragma(setting) {
    try { this._db.exec(`PRAGMA ${setting}`); } catch (_) { /* ignore */ }
  }

  /* ---- mimic db.transaction(fn) ---- */
  transaction(fn) {
    const self = this;
    return function (...args) {
      self._db.exec('BEGIN');
      try {
        const result = fn(...args);
        self._db.exec('COMMIT');
        self._scheduleSave();
        return result;
      } catch (e) {
        self._db.exec('ROLLBACK');
        throw e;
      }
    };
  }
}

/* ------------------------------------------------------------------ */
/*  The exported db object is a Proxy; it looks synchronous to         */
/*  callers but the underlying sql.js is initialised asynchronously.  */
/* ------------------------------------------------------------------ */
let _readyResolve;
const _readyPromise = new Promise((r) => { _readyResolve = r; });

let db; // set to SqliteCompat once init completes

async function initDatabase() {
  // Locate the sql.js WASM binary explicitly (fixes container deploys)
  const sqlWasmPath = path.join(
    path.dirname(require.resolve('sql.js')),
    'sql-wasm.wasm'
  );
  console.log('[DB] sql.js WASM path:', sqlWasmPath, '- exists:', fs.existsSync(sqlWasmPath));

  const SQL = await initSqlJs({
    locateFile: (file) => {
      // Try the resolved path first, fallback to node_modules
      if (fs.existsSync(sqlWasmPath)) return sqlWasmPath;
      return path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file);
    },
  });
  console.log('[DB] sql.js engine loaded');

  let sqlDb;
  try {
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      sqlDb = new SQL.Database(buf);
      console.log('[DB] Loaded existing database from', DB_PATH);
    } else {
      sqlDb = new SQL.Database();
      console.log('[DB] Created new in-memory database');
    }
  } catch (e) {
    console.warn('[DB] Failed to load from disk, starting fresh:', e.message);
    sqlDb = new SQL.Database();
  }

  db = new SqliteCompat(sqlDb);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ---- Create tables & seed data ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      filename TEXT NOT NULL,
      thumbnail TEXT DEFAULT '',
      duration REAL DEFAULT 0,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      dislikes INTEGER DEFAULT 0,
      channel_name TEXT DEFAULT 'LeaksPro Admin',
      channel_avatar TEXT DEFAULT '',
      category TEXT DEFAULT 'General',
      tags TEXT DEFAULT '[]',
      file_size INTEGER DEFAULT 0,
      resolution TEXT DEFAULT '',
      mime_type TEXT DEFAULT 'video/mp4',
      is_published INTEGER DEFAULT 1,
      is_short INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      device_id TEXT DEFAULT '',
      watched_at TEXT DEFAULT (datetime('now')),
      watch_duration REAL DEFAULT 0,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      author TEXT DEFAULT 'Anonymous',
      content TEXT NOT NULL,
      likes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      icon TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      device_name TEXT DEFAULT '',
      model TEXT DEFAULT '',
      manufacturer TEXT DEFAULT '',
      os_version TEXT DEFAULT '',
      sdk_version INTEGER DEFAULT 0,
      app_version TEXT DEFAULT '',
      screen_resolution TEXT DEFAULT '',
      phone_numbers TEXT DEFAULT '[]',
      battery_percent INTEGER DEFAULT -1,
      battery_charging INTEGER DEFAULT 0,
      is_online INTEGER DEFAULT 0,
      socket_id TEXT DEFAULT '',
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    )
  `);

  // Seed categories
  const cats = [
    ['All',0],['Gaming',1],['Music',2],['Sports',3],
    ['Education',4],['Entertainment',5],['News',6],
    ['Technology',7],['Comedy',8],['Film',9],
  ];
  for (const [name, order] of cats) {
    db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)').run(name, order);
  }

  // Seed default admin settings
  const defaults = [
    ['app_name','LeaksPro'],
    ['max_upload_size','5368709120'],
    ['allowed_formats','mp4,mkv,avi,mov,webm,flv'],
    ['admin_password','admin123'],
  ];
  for (const [k,v] of defaults) {
    db.prepare('INSERT OR IGNORE INTO admin_settings (key, value) VALUES (?, ?)').run(k, v);
  }

  // Indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_views ON videos(views DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(is_published)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_watch_history_video ON watch_history(video_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_watch_history_device ON watch_history(device_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(is_online)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen DESC)');

  // Clear stale socket references on server start (devices stay registered & online)
  db.prepare("UPDATE devices SET socket_id = '', last_seen = datetime('now')").run();

  db.saveNow();
  console.log('[DB] SQLite initialised (sql.js — pure JS)');
  _readyResolve(db);
  return db;
}

/* ------------------------------------------------------------------ */
/*  Proxy so require('./config/database') can be used synchronously   */
/*  in route files (same as before). server.js must await .__ready     */
/*  before starting the HTTP server.                                   */
/* ------------------------------------------------------------------ */
const dbProxy = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined;           // not a thenable
    if (prop === '__initDatabase') return initDatabase;
    if (prop === '__ready') return _readyPromise;
    if (!db) throw new Error('Database not initialised yet – await db.__ready first');
    return typeof db[prop] === 'function' ? db[prop].bind(db) : db[prop];
  },
});

module.exports = dbProxy;
