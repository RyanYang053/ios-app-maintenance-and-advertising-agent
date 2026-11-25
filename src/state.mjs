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
    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, dedupe TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL, UNIQUE(app_id, dedupe)
    );
    CREATE TABLE IF NOT EXISTS operation_events (
      id INTEGER PRIMARY KEY, operation_id INTEGER NOT NULL, event TEXT NOT NULL,
      captured_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ops_by_app ON operations (app_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation_per_kind
      ON operations(app_id, json_extract(payload, '$.kind'))
      WHERE json_extract(payload, '$.kind') IN ('promotion', 'maintenance')
        AND json_extract(payload, '$.status') NOT IN ('closed', 'cancelled');
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_store_check_per_kind
      ON operations(app_id, json_extract(payload, '$.kind'), coalesce(json_extract(payload, '$.storeVersionId'), ''))
      WHERE json_extract(payload, '$.kind') IN ('store-maintenance', 'review-triage')
        AND json_extract(payload, '$.status') NOT IN ('closed', 'cancelled');
    CREATE TABLE IF NOT EXISTS research (
      id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, captured_at TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(app_id, payload)
    );
    CREATE INDEX IF NOT EXISTS research_by_app ON research(app_id, id DESC);
    CREATE INDEX IF NOT EXISTS events_by_op ON operation_events (operation_id, id);

  `);
  const inflate = (row) => row ? { ...JSON.parse(row.payload), id: row.id, revision: row.revision } : null;
  const operation = (id) => inflate(db.prepare('SELECT id, revision, payload FROM operations WHERE id = ?').get(id));
  const event = (id, type, time, data) => db.prepare(
    'INSERT INTO operation_events(operation_id, event, captured_at, payload) VALUES (?, ?, ?, ?)',
  ).run(id, type, time, JSON.stringify(data));
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    saveResearch(app,time,payload) {
      const result=db.prepare('INSERT INTO research(app_id,captured_at,payload) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(app,time,JSON.stringify(payload));
      return {stored:result.changes===1};
    },
    research(app) {
      return db.prepare('SELECT payload FROM research WHERE app_id=? ORDER BY json_extract(payload, \'$.observedOn\') DESC,id DESC LIMIT 200').all(app).map(r=>JSON.parse(r.payload));
    },
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
    latestScans() {
      return db.prepare('SELECT payload FROM scans WHERE id IN (SELECT MAX(id) FROM scans GROUP BY app_id) ORDER BY app_id')
        .all().map(({ payload }) => JSON.parse(payload));
    },
    operations(app) {
      const base = 'SELECT id, revision, payload FROM operations';
      return (app ? db.prepare(base + ' WHERE app_id = ? ORDER BY id DESC').all(app) :
        db.prepare(base + ' ORDER BY id DESC').all()).map(inflate);
    },
    operation,
    operationEvents(id) {
      return db.prepare('SELECT event, captured_at, payload FROM operation_events WHERE operation_id = ? ORDER BY id').all(id)
        .map(({ event, captured_at, payload }) => ({ event, capturedAt: captured_at, data: JSON.parse(payload) }));
    },
    enqueue(item, now) {
      return transaction(() => {
        const result = db.prepare('INSERT INTO operations(app_id, dedupe, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
          .run(item.appId, item.key, JSON.stringify(item));
        if (result.changes === 0) return null;
        event(result.lastInsertRowid, 'queued', now, item);
        return operation(result.lastInsertRowid);
      });
    },
    updateOperation(item, changes, type, now) {
      return transaction(() => {
        const { id, revision, ...snapshot } = item;
        const result = db.prepare('UPDATE operations SET revision = revision + 1, payload = ? WHERE id = ? AND revision = ?')
          .run(JSON.stringify({ ...snapshot, ...changes, updatedAt: now }), id, revision);
        if (result.changes !== 1) throw new Error('Operation changed. Read the current task before retrying.');
        event(id, type, now, changes);
        return operation(id);
      });
    },
    close() { db.close(); },
  };
}
