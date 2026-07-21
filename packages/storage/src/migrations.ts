import type Database from "better-sqlite3";
import { schemaSql } from "./schema";

export const latestMigrationVersion = 1;

export function runMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");

  const currentVersion = Number(db.pragma("user_version", { simple: true }));
  if (currentVersion >= latestMigrationVersion) {
    return;
  }

  const migrate = db.transaction(() => {
    db.exec(schemaSql);
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(latestMigrationVersion, "initial_schema", new Date().toISOString());
    db.pragma(`user_version = ${latestMigrationVersion}`);
  });

  migrate();
}
