import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { logger } from "./logger.js";

/**
 * Versioned SQLite schema migrations. The applied version is stored in SQLite's `user_version`
 * pragma, each migration runs in its own transaction, and a consistent backup of an existing
 * database is taken before any pending migration is applied.
 */

export interface Migration {
    /** Strictly increasing, starting at 1 with no gaps. */
    version: number;
    description: string;
    up: (db: Database.Database) => void;
}

export interface MigrationOptions {
    /** Database file path. Without it (for example for in-memory databases) no backup is taken. */
    filePath?: string;
    /** Number of automatic backups to retain. Defaults to 3. */
    keepBackups?: number;
    now?: () => Date;
    log?: (message: string) => void;
}

export interface MigrationResult {
    from: number;
    to: number;
    applied: number[];
    backupPath?: string;
}

/** The database was written by a newer version of the bot than this one understands. */
export class SchemaVersionError extends Error {
    constructor(
        readonly databaseVersion: number,
        readonly supportedVersion: number
    ) {
        super(
            `The database schema is version ${databaseVersion}, but this bot only supports up to version ${supportedVersion}. ` +
                "Update the bot to the version that created the database, or restore a backup from the data/backups folder."
        );
        this.name = "SchemaVersionError";
    }
}

/** A migration failed and was rolled back; the database remains at its previous version. */
export class MigrationError extends Error {
    constructor(
        readonly version: number,
        readonly backupPath: string | undefined,
        cause: unknown
    ) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const backup = backupPath ? ` A backup from before the upgrade is at ${backupPath}.` : "";
        super(`Database migration to version ${version} failed and was rolled back: ${reason}.${backup}`, { cause });
        this.name = "MigrationError";
    }
}

const DEFAULT_KEPT_BACKUPS = 3;

function validateMigrations(migrations: Migration[]): void {
    migrations.forEach((migration, index) => {
        if (migration.version !== index + 1) {
            throw new Error(
                `Migrations must be numbered 1..n without gaps or duplicates (found ${migration.version} at position ${index + 1}).`
            );
        }
    });
}

function getSchemaVersion(db: Database.Database): number {
    return db.pragma("user_version", { simple: true }) as number;
}

function hasUserTables(db: Database.Database): boolean {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get() !== undefined;
}

function formatTimestamp(date: Date): string {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Deletes the oldest automatic backups beyond the retention limit. Timestamps sort chronologically. */
function pruneBackups(directory: string, databaseName: string, keep: number): void {
    const backups = fs
        .readdirSync(directory)
        .filter((name) => name.startsWith(`${databaseName}.`) && name.endsWith(".bak"))
        .sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
        fs.rmSync(path.join(directory, name), { force: true });
    }
}

/** Writes a consistent copy of the live database (safe with WAL) next to it in a `backups` folder. */
function backupDatabase(db: Database.Database, filePath: string, from: number, to: number, options: MigrationOptions): string {
    const directory = path.join(path.dirname(filePath), "backups");
    fs.mkdirSync(directory, { recursive: true });

    const base = `${path.basename(filePath)}.${formatTimestamp((options.now ?? (() => new Date()))())}.v${from}-to-v${to}`;
    let target = path.join(directory, `${base}.bak`);
    for (let attempt = 1; fs.existsSync(target); attempt++) {
        target = path.join(directory, `${base}-${attempt}.bak`);
    }

    db.prepare("VACUUM INTO ?").run(target);
    pruneBackups(directory, path.basename(filePath), options.keepBackups ?? DEFAULT_KEPT_BACKUPS);
    return target;
}

/**
 * Brings the database to the latest version. Throws SchemaVersionError for databases from a newer bot,
 * and refuses to migrate an existing database if its pre-upgrade backup cannot be written.
 */
export function runMigrations(db: Database.Database, migrations: Migration[], options: MigrationOptions = {}): MigrationResult {
    validateMigrations(migrations);
    const log = options.log ?? ((message: string) => logger.child("database").info(message));
    const latest = migrations.length;
    const from = getSchemaVersion(db);

    if (from > latest) {
        throw new SchemaVersionError(from, latest);
    }

    const pending = migrations.filter((migration) => migration.version > from);
    if (pending.length === 0) {
        return { from, to: from, applied: [] };
    }

    let backupPath: string | undefined;
    if (options.filePath && hasUserTables(db)) {
        try {
            backupPath = backupDatabase(db, options.filePath, from, latest, options);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Could not back up the database before upgrading it, so it was left unchanged: ${reason}. ` +
                    "Free disk space or fix folder permissions, then start the bot again."
            );
        }
        log(`Database backup written before schema upgrade: ${backupPath}`);
    }

    const applied: number[] = [];
    for (const migration of pending) {
        try {
            db.transaction(() => {
                migration.up(db);
                db.pragma(`user_version = ${migration.version}`);
            })();
        } catch (error) {
            throw new MigrationError(migration.version, backupPath, error);
        }
        applied.push(migration.version);
        log(`Database schema upgraded to version ${migration.version}: ${migration.description}`);
    }

    return { from, to: latest, applied, backupPath };
}
