import type Database from "better-sqlite3";
import { schemaSql, vectorSchemaSql } from "./schema";

export const latestMigrationVersion = 4;

export function runMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");

  const currentVersion = Number(db.pragma("user_version", { simple: true }));
  if (currentVersion >= latestMigrationVersion) {
    return;
  }

  const migrate = db.transaction(() => {
    const now = new Date().toISOString();
    if (currentVersion === 0) {
      db.exec(schemaSql);
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(1, "initial_schema", now);
    } else if (currentVersion === 1) {
      db.exec(`
        ALTER TABLE review_items ADD COLUMN claim_token TEXT;
        ALTER TABLE review_items ADD COLUMN claim_started_at TEXT;
        ALTER TABLE review_items ADD COLUMN application_json TEXT;
      `);
    }
    if (currentVersion > 0 && currentVersion < 3) {
      db.exec(vectorSchemaSql);
    }
    const hasNotesTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get(),
    );
    if (hasNotesTable && currentVersion > 0 && currentVersion < 4) {
      db.exec("ALTER TABLE notes ADD COLUMN content_category TEXT NOT NULL DEFAULT 'unknown';");
    }
    if (currentVersion < 2) {
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(2, "review_application_claims", now);
    }
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(3, "local_vector_index", now);
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(4, "note_content_category", now);
    db.pragma(`user_version = ${latestMigrationVersion}`);
  });

  migrate();
}
