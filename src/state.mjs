import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

export function state(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, 'history.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, captured_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scans_app_id ON scans (app_id, id DESC);
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, captured_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS experiments_app_id ON experiments (app_id, id DESC);
  `);
  return {
    saveScan(app, time, payload) { db.prepare('INSERT INTO scans(app_id, captured_at, payload) VALUES (?, ?, ?)').run(app, time, JSON.stringify(payload)); },
    saveExperiment(app, time, payload) { return db.prepare('INSERT INTO experiments(app_id, captured_at, payload) VALUES (?, ?, ?)').run(app, time, JSON.stringify(payload)).lastInsertRowid; },
    latest(app) {
      const row = db.prepare('SELECT payload FROM scans WHERE app_id = ? ORDER BY id DESC LIMIT 1').get(app);
      return row ? JSON.parse(row.payload) : null;
    },
    history(app) {
      const compact = db.prepare('SELECT payload FROM scans WHERE app_id = ? ORDER BY id DESC LIMIT 12').all(app).map(({ payload }) => {
        const { capturedAt, periods, store, sales, analytics, ads, decision } = JSON.parse(payload);
        return { capturedAt, periods, store, sales, analytics, ads, decision };
      });
      return { scans: compact, experiments: db.prepare('SELECT id, captured_at, payload FROM experiments WHERE app_id = ? ORDER BY id DESC LIMIT 30')
        .all(app).map(({ payload, ...row }) => ({ ...row, ...JSON.parse(payload) })) };
    },
    close() { db.close(); },
  };
}
