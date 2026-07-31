import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { runMigrations } from "./migrations";
import type { AppDatabase } from "./types";

export function openAppDatabase(path: string): AppDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  sqliteVec.load(sqlite);
  runMigrations(sqlite);

  return {
    sqlite,
    close() {
      sqlite.close();
    },
  };
}
