import fs from "fs";
import path from "path";
import { createRequire } from "module";

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface DbClient {
  driverName: "better-sqlite3" | "node:sqlite" | "sql.js";
  dbPath: string;
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): RunResult;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  transaction<T>(fn: () => T): T;
  backupTo(destPath: string): void;
}

export async function openDatabase(dbPath: string): Promise<DbClient> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const req = createRequire(import.meta.url);

  // 1. Try better-sqlite3 if native binary compiled/installed cleanly
  try {
    const BetterSqlite3 = req("better-sqlite3");
    const nativeDb = new BetterSqlite3(dbPath);
    nativeDb.pragma("journal_mode = WAL");
    nativeDb.pragma("foreign_keys = ON");
    return {
      driverName: "better-sqlite3",
      dbPath,
      exec: (sql) => nativeDb.exec(sql),
      run: (sql, ...params) => {
        const info = nativeDb.prepare(sql).run(...params);
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      },
      get: <T>(sql: string, ...params: unknown[]) => nativeDb.prepare(sql).get(...params) as T | undefined,
      all: <T>(sql: string, ...params: unknown[]) => nativeDb.prepare(sql).all(...params) as T[],
      transaction: <T>(fn: () => T) => nativeDb.transaction(fn)(),
      backupTo: (destPath: string) => {
        nativeDb.pragma("wal_checkpoint(TRUNCATE)");
        fs.copyFileSync(dbPath, destPath);
      },
    };
  } catch {
    // Fall through to zero-compile alternatives
  }

  // 2. Try Node.js built-in node:sqlite (zero external C++ build tools)
  try {
    const builtinMod = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as
      | { DatabaseSync: new (p: string) => any }
      | undefined;
    const sqliteMod = builtinMod ?? (await import("node:sqlite"));
    if (sqliteMod?.DatabaseSync) {
      const nodeDb = new sqliteMod.DatabaseSync(dbPath);
      nodeDb.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      let txDepth = 0;
      return {
        driverName: "node:sqlite",
        dbPath,
        exec: (sql) => nodeDb.exec(sql),
        run: (sql, ...params) => {
          const info = nodeDb.prepare(sql).run(...params);
          return {
            changes: Number(info?.changes ?? 0),
            lastInsertRowid: Number(info?.lastInsertRowid ?? 0),
          };
        },
        get: <T>(sql: string, ...params: unknown[]) => nodeDb.prepare(sql).get(...params) as T | undefined,
        all: <T>(sql: string, ...params: unknown[]) => nodeDb.prepare(sql).all(...params) as T[],
        transaction: <T>(fn: () => T) => {
          const isOuter = txDepth === 0;
          if (isOuter) nodeDb.exec("BEGIN IMMEDIATE");
          txDepth++;
          try {
            const out = fn();
            txDepth--;
            if (isOuter) nodeDb.exec("COMMIT");
            return out;
          } catch (err) {
            txDepth--;
            if (isOuter) {
              try { nodeDb.exec("ROLLBACK"); } catch {}
            }
            throw err;
          }
        },
        backupTo: (destPath: string) => {
          try { nodeDb.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
          fs.copyFileSync(dbPath, destPath);
        },
      };
    }
  } catch {
    // Fall through to sql.js WASM
  }

  // 3. Guaranteed pure-WASM sql.js fallback (works on every Windows machine)
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const existingBuffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : undefined;
  const wasmDb = existingBuffer ? new SQL.Database(existingBuffer) : new SQL.Database();
  wasmDb.run("PRAGMA foreign_keys = ON;");

  let txDepth = 0;
  const flush = () => {
    const tmp = dbPath + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(wasmDb.export()));
    fs.renameSync(tmp, dbPath);
  };
  if (!existingBuffer) flush();

  const normalizeParams = (params: unknown[]): any[] =>
    params.map((v) => (v === undefined ? null : v instanceof Float32Array ? new Uint8Array(v.buffer) : v));

  return {
    driverName: "sql.js",
    dbPath,
    exec: (sql) => {
      wasmDb.exec(sql);
      if (txDepth === 0) flush();
    },
    run: (sql, ...params) => {
      const stmt = wasmDb.prepare(sql);
      try {
        stmt.bind(normalizeParams(params));
        while (stmt.step()) {}
      } finally {
        stmt.free();
      }
      const changes = wasmDb.getRowsModified();
      const row = wasmDb.exec("SELECT last_insert_rowid() AS id");
      const lastInsertRowid = Number(row?.[0]?.values?.[0]?.[0] ?? 0);
      if (txDepth === 0) flush();
      return { changes, lastInsertRowid };
    },
    get: <T>(sql: string, ...params: unknown[]) => {
      const stmt = wasmDb.prepare(sql);
      try {
        stmt.bind(normalizeParams(params));
        if (stmt.step()) {
          return stmt.getAsObject() as T;
        }
        return undefined;
      } finally {
        stmt.free();
      }
    },
    all: <T>(sql: string, ...params: unknown[]) => {
      const stmt = wasmDb.prepare(sql);
      const rows: T[] = [];
      try {
        stmt.bind(normalizeParams(params));
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as T);
        }
        return rows;
      } finally {
        stmt.free();
      }
    },
    transaction: <T>(fn: () => T) => {
      const isOuter = txDepth === 0;
      if (isOuter) wasmDb.run("BEGIN");
      txDepth++;
      try {
        const out = fn();
        txDepth--;
        if (isOuter) {
          wasmDb.run("COMMIT");
          flush();
        }
        return out;
      } catch (err) {
        txDepth--;
        if (isOuter) {
          try { wasmDb.run("ROLLBACK"); } catch {}
        }
        throw err;
      }
    },
    backupTo: (destPath: string) => {
      flush();
      fs.copyFileSync(dbPath, destPath);
    },
  };
}
