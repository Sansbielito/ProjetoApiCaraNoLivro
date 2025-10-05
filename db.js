const path = require('path');
const fs = require('fs');

// Optional SQLite-backed key/value store (uses better-sqlite3 if installed).
try {
  const Database = require('better-sqlite3');
  const dbPath = path.join(__dirname, 'data', 'cnl.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');

  function get(key) {
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.v); } catch (e) { return null; }
  }
  function set(key, value) {
    const v = JSON.stringify(value);
    db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)').run(key, v);
  }
  function remove(key) {
    db.prepare('DELETE FROM kv WHERE k = ?').run(key);
  }

  module.exports = { available: true, get, set, remove };
} catch (e) {
  console.warn('SQLite kv store (better-sqlite3) not available — continuing with file-backed storage');
  module.exports = { available: false };
}
