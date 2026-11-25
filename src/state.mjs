import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { appId, assertEvidenceApp } from './app-context.mjs';

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
    DROP INDEX IF EXISTS one_active_operation_per_kind;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_maintenance
      ON operations(app_id, json_extract(payload, '$.kind'))
      WHERE json_extract(payload, '$.kind') = 'maintenance'
        AND json_extract(payload, '$.status') NOT IN ('closed', 'cancelled');
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_promotion_per_channel
      ON operations(app_id, json_extract(payload, '$.channel'))
      WHERE json_extract(payload, '$.kind') = 'promotion'
        AND json_extract(payload, '$.status') NOT IN ('closed', 'cancelled');
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_store_check_per_kind
      ON operations(app_id, json_extract(payload, '$.kind'), coalesce(json_extract(payload, '$.storeVersionId'), ''))
      WHERE json_extract(payload, '$.kind') IN ('store-maintenance', 'review-triage')
        AND json_extract(payload, '$.status') NOT IN ('closed', 'cancelled');
    CREATE TABLE IF NOT EXISTS research (
      id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, captured_at TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(app_id, payload)
    );
    CREATE TABLE IF NOT EXISTS ops_evidence (
      app_id TEXT NOT NULL, kind TEXT NOT NULL, evidence_key TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(app_id,kind,evidence_key)
    );
    CREATE TABLE IF NOT EXISTS public_request_gate (id INTEGER PRIMARY KEY CHECK(id=1), next_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS skill_lessons (
      app_id TEXT NOT NULL, domain TEXT NOT NULL, lesson_key TEXT NOT NULL,
      revision INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(app_id,domain,lesson_key,revision)
    );
    CREATE INDEX IF NOT EXISTS research_by_app ON research(app_id, id DESC);
    CREATE INDEX IF NOT EXISTS events_by_op ON operation_events (operation_id, id);

  `);
  const inflate = (row) => row ? { ...JSON.parse(row.payload), id: row.id, revision: row.revision } : null;
  const operation = (id, app) => inflate(app === undefined ? db.prepare('SELECT id, revision, payload FROM operations WHERE id = ?').get(id) : db.prepare('SELECT id, revision, payload FROM operations WHERE id = ? AND app_id = ?').get(id, appId(app)));
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
    opsEvidence(app,kind) {
      return db.prepare('SELECT payload FROM ops_evidence WHERE app_id=? AND kind=? ORDER BY rowid DESC').all(appId(app),kind).map(r=>JSON.parse(r.payload));
    },
    saveOpsEvidence(app,kind,key,payload){
      assertEvidenceApp(app,payload);
      const result=db.prepare('INSERT INTO ops_evidence(app_id,kind,evidence_key,payload) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(app,kind,key,JSON.stringify(payload));
      if(!result.changes)throw Error('Evidence already exists; original retained');
      return payload;
    },
    reservePublicRequest(now){
      return transaction(()=>{
        const current=db.prepare('SELECT next_at FROM public_request_gate WHERE id=1').get()?.next_at??0;
        if(now<current)throw Error('Public request cooldown active; retry later');
        db.prepare('INSERT INTO public_request_gate(id,next_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at').run(now+6000);
      });
    },
    pausePublicRequests(until){
      db.prepare('INSERT INTO public_request_gate(id,next_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET next_at=MAX(next_at,excluded.next_at)').run(until);
    },
    lessons(app) {
      return db.prepare('SELECT domain,lesson_key,revision,payload FROM skill_lessons WHERE app_id=? ORDER BY domain,lesson_key,revision DESC').all(appId(app)).map((row,i,all)=>({...JSON.parse(row.payload),appId:app,revision:row.revision,
        current:i===0||all[i-1].domain!==row.domain||all[i-1].lesson_key!==row.lesson_key}));
    },
    saveLesson(app,lesson) {
      appId(app);
      return transaction(()=>{
        const latest=db.prepare('SELECT MAX(revision) AS n FROM skill_lessons WHERE app_id=? AND domain=? AND lesson_key=?').get(app,lesson.domain,lesson.key).n??0;
        if(latest!==lesson.expectedRevision)throw Error('Lesson revision changed; reload this app context');
        if(lesson.taskIds.some(id=>!operation(id,app)))throw Error('Lesson evidence belongs to a different app');
        const {expectedRevision,...payload}=lesson;
        db.prepare('INSERT INTO skill_lessons(app_id,domain,lesson_key,revision,payload) VALUES(?,?,?,?,?)').run(app,lesson.domain,lesson.key,latest+1,JSON.stringify(payload));
        return {...payload,appId:app,revision:latest+1};
      });
    },
    saveResearch(app,time,payload) {
      assertEvidenceApp(app,payload,{required:false});
      const result=db.prepare('INSERT INTO research(app_id,captured_at,payload) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(app,time,JSON.stringify(payload));
      return {stored:result.changes===1};
    },
    research(app) {
      return db.prepare('SELECT payload FROM research WHERE app_id=? ORDER BY json_extract(payload, \'$.observedOn\') DESC,id DESC LIMIT 200').all(app).map(r=>JSON.parse(r.payload));
    },
    saveScan(app, time, payload) { appId(app); if(payload.app?.id!==app)throw Error('Scan app mismatch'); db.prepare('INSERT INTO scans(app_id, captured_at, payload) VALUES (?, ?, ?)').run(app, time, JSON.stringify(payload)); },
    saveExperiment(app, time, payload) { assertEvidenceApp(app,payload,{required:false}); return db.prepare('INSERT INTO experiments(app_id, captured_at, payload) VALUES (?, ?, ?)').run(app, time, JSON.stringify(payload)).lastInsertRowid; },
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
    operationEvents(id,app) {
      if(app!==undefined&&!operation(id,app))throw Error('Task not found for selected app');
      return db.prepare('SELECT event, captured_at, payload FROM operation_events WHERE operation_id = ? ORDER BY id').all(id)
        .map(({ event, captured_at, payload }) => ({ event, capturedAt: captured_at, data: JSON.parse(payload) }));
    },
    enqueue(item, now) {
      appId(item.appId);
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
        if(!operation(id,appId(item.appId))|| (changes.appId!==undefined&&changes.appId!==item.appId))throw Error('Task app identity cannot change');
        const result = db.prepare('UPDATE operations SET revision = revision + 1, payload = ? WHERE id = ? AND revision = ? AND app_id = ?')
          .run(JSON.stringify({ ...snapshot, ...changes, updatedAt: now }), id, revision, item.appId);
        if (result.changes !== 1) throw new Error('Operation changed. Read the current task before retrying.');
        event(id, type, now, changes);
        return operation(id);
      });
    },
    close() { db.close(); },
  };
}
