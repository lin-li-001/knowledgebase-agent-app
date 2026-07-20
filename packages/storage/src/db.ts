import Database from "better-sqlite3";
import { runMigrations } from "./migrations";
import type { AppDatabase } from "./types";

export function openAppDatabase(path: string): AppDatabase {
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);

  return {
    sqlite,
    close() {
      sqlite.close();
    },
  };
}
