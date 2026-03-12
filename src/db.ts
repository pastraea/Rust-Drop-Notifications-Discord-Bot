import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Drop, NormalizedDrop, Platform, Watch } from "./types.js";
import { TOTAL_SECRETS, type SecretKey } from "./services/secrets.js";

/**
 * SQLite-backed persistence layer for user settings, drops state, and notification dedupe history.
 */

/** Timed alert channels supported by the bot. */
export type TimedAlertType = "alert_24h_6am" | "alert_12h_6pm" | "alert_1h";
/** All alert channels including manual checkdrops pings. */
export type AlertType = TimedAlertType | "alert_checkdrops";
/** GIF source mode for announcement media selection. */
export type GifMode = "default" | "custom" | "both";

/** Stored custom GIF metadata row. */
export interface CustomGifEntry {
    id: number;
    viewUrl: string;
    displayName: string | null;
    createdAt: string;
}

/** Resolved user alert toggles used by interaction status output. */
export interface UserAlertSettings {
    autoPing: boolean;
    alert24h6am: boolean;
    alert12h6pm: boolean;
    alert1h: boolean;
    alertCheckdrops: boolean;
}

/** Result payload when marking a secret as discovered for a user. */
export interface SecretDiscoveryResult {
    isNew: boolean;
    foundCount: number;
    totalSecrets: number;
}

/**
 * Main data-access object used by scheduler, commands, and reminder services.
 */
export class BotDb {
    private readonly db: Database.Database;
    private readonly upsertDropsBatchTx: (drops: NormalizedDrop[]) => void;
    private readonly markUserNotificationsSentBatchTx: (
        rows: Array<{ discordUserId: string; dropId: number; notificationType: string }>
    ) => void;
    private readonly setAlertsEnabledStatementsByKey = new Map<string, Database.Statement>();
    private readonly eligibleUsersForDropsStatementsByCount = new Map<number, Database.Statement>();
    private readonly selectDropsByPlatformStatementsByCount = new Map<number, Database.Statement>();
    private readonly endMissingDropsStatementsByCount = new Map<number, Database.Statement>();
    private readonly alertEnabledStatements: Record<AlertType, Database.Statement>;
    private readonly alertUserIdsStatements: Record<AlertType, Database.Statement>;
    private readonly customGifStatements: {
        add: Database.Statement;
        remove: Database.Statement;
        rename: Database.Statement;
        listByUser: Database.Statement;
        listAllDistinctViewUrls: Database.Statement;
    };
    private readonly hotStatements: {
        ensureUser: Database.Statement;
        setAutoPing: Database.Statement;
        recomputeAutoPingFromAlerts: Database.Statement;
        isAutoPingEnabled: Database.Statement;
        getUserAlertSettings: Database.Statement;
        getAutoPingUserIds: Database.Statement;
        getEligibleAutoPingUserIdsForDrop: Database.Statement;
        getActiveDrops: Database.Statement;
        getUpcomingDropsWithinHours: Database.Statement;
        wasNotificationSent: Database.Statement;
        markNotificationSent: Database.Statement;
        wasUserNotificationSent: Database.Statement;
        markUserNotificationSent: Database.Statement;
        setSetting: Database.Statement;
        getSetting: Database.Statement;
        upsertDrop: Database.Statement;
        selectDropByExternalId: Database.Statement;
        endMissingDropsWhenNoSeenIds: Database.Statement;
        markSecretFound: Database.Statement;
        getSecretsFoundCount: Database.Statement;
        resetSecrets: Database.Statement;
        pruneOldUserNotifications: Database.Statement;
        pruneOldWatchNotifications: Database.Statement;
    };

    /** Opens the SQLite database, initializes schema, and precompiles hot statements. */
    constructor(dbPath: string) {
        const fullPath = path.resolve(dbPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        this.db = new Database(fullPath);
        this.db.pragma("journal_mode = WAL");
        this.init();
        this.alertEnabledStatements = {
            alert_24h_6am: this.db.prepare("SELECT alert_24h_6am as enabled FROM users WHERE discord_user_id = ?"),
            alert_12h_6pm: this.db.prepare("SELECT alert_12h_6pm as enabled FROM users WHERE discord_user_id = ?"),
            alert_1h: this.db.prepare("SELECT alert_1h as enabled FROM users WHERE discord_user_id = ?"),
            alert_checkdrops: this.db.prepare("SELECT alert_checkdrops as enabled FROM users WHERE discord_user_id = ?")
        };
        this.alertUserIdsStatements = {
            alert_24h_6am: this.db.prepare(
                "SELECT discord_user_id as discordUserId FROM users WHERE auto_ping = 1 AND alert_24h_6am = 1"
            ),
            alert_12h_6pm: this.db.prepare(
                "SELECT discord_user_id as discordUserId FROM users WHERE auto_ping = 1 AND alert_12h_6pm = 1"
            ),
            alert_1h: this.db.prepare(
                "SELECT discord_user_id as discordUserId FROM users WHERE auto_ping = 1 AND alert_1h = 1"
            ),
            alert_checkdrops: this.db.prepare(
                "SELECT discord_user_id as discordUserId FROM users WHERE auto_ping = 1 AND alert_checkdrops = 1"
            )
        };
        this.customGifStatements = {
            add: this.db.prepare(
                `
                INSERT OR IGNORE INTO custom_gifs (discord_user_id, view_url)
                VALUES (?, ?)
                `
            ),
            remove: this.db.prepare("DELETE FROM custom_gifs WHERE id = ? AND discord_user_id = ?"),
            rename: this.db.prepare("UPDATE custom_gifs SET display_name = ? WHERE id = ? AND discord_user_id = ?"),
            listByUser: this.db.prepare(
                `
                SELECT
                    id,
                    view_url as viewUrl,
                    display_name as displayName,
                    created_at as createdAt
                FROM custom_gifs
                WHERE discord_user_id = ?
                ORDER BY created_at DESC
                `
            ),
            listAllDistinctViewUrls: this.db.prepare(
                `
                SELECT DISTINCT view_url as viewUrl
                FROM custom_gifs
                `
            )
        };
        this.hotStatements = {
            ensureUser: this.db.prepare("INSERT OR IGNORE INTO users (discord_user_id) VALUES (?)"),
            setAutoPing: this.db.prepare("UPDATE users SET auto_ping = ? WHERE discord_user_id = ?"),
            recomputeAutoPingFromAlerts: this.db.prepare(
                `
                                UPDATE users
                                SET auto_ping = CASE
                                        WHEN alert_24h_6am = 1
                                            OR alert_12h_6pm = 1
                                            OR alert_1h = 1
                                            OR alert_checkdrops = 1
                                        THEN 1
                                        ELSE 0
                                END
                                WHERE discord_user_id = ?
                                `
            ),
            isAutoPingEnabled: this.db.prepare("SELECT auto_ping as autoPing FROM users WHERE discord_user_id = ?"),
            getUserAlertSettings: this.db.prepare(
                `
                SELECT
                    auto_ping as autoPing,
                    alert_24h_6am as alert24h6am,
                    alert_12h_6pm as alert12h6pm,
                    alert_1h as alert1h,
                    alert_checkdrops as alertCheckdrops
                FROM users
                WHERE discord_user_id = ?
                `
            ),
            getAutoPingUserIds: this.db.prepare(
                `
                SELECT discord_user_id as discordUserId
                FROM users
                WHERE auto_ping = 1
                `
            ),
            getEligibleAutoPingUserIdsForDrop: this.db.prepare(
                `
                                SELECT u.discord_user_id as discordUserId
                                FROM users u
                                WHERE u.auto_ping = 1
                                    AND NOT EXISTS (
                                        SELECT 1
                                        FROM user_notifications_sent uns
                                        WHERE uns.discord_user_id = u.discord_user_id
                                            AND uns.drop_id = ?
                                            AND uns.notification_type = ?
                                    )
                                `
            ),
            getActiveDrops: this.db.prepare(
                `
                SELECT
                  id,
                  platform,
                  external_id as externalId,
                  title,
                  channels_json as channelsJson,
                  game,
                  start_time as startTime,
                  end_time as endTime,
                  status,
                  last_seen as lastSeen
                FROM drops
                WHERE status = 'active'
                  AND datetime(end_time) > datetime('now')
                `
            ),
            getUpcomingDropsWithinHours: this.db.prepare(
                `
                SELECT
                  id,
                  platform,
                  external_id as externalId,
                  title,
                  channels_json as channelsJson,
                  game,
                  start_time as startTime,
                  end_time as endTime,
                  status,
                  last_seen as lastSeen
                FROM drops
                WHERE status IN ('upcoming', 'active')
                  AND datetime(start_time) > datetime('now')
                  AND datetime(start_time) <= datetime('now', '+' || ? || ' hours')
                `
            ),
            wasNotificationSent: this.db.prepare(
                "SELECT 1 FROM notifications_sent WHERE watch_id = ? AND drop_id = ? AND notification_type = ?"
            ),
            markNotificationSent: this.db.prepare(
                `
                INSERT OR IGNORE INTO notifications_sent (watch_id, drop_id, notification_type)
                VALUES (?, ?, ?)
                `
            ),
            wasUserNotificationSent: this.db.prepare(
                "SELECT 1 FROM user_notifications_sent WHERE discord_user_id = ? AND drop_id = ? AND notification_type = ?"
            ),
            markUserNotificationSent: this.db.prepare(
                `
                INSERT OR IGNORE INTO user_notifications_sent (discord_user_id, drop_id, notification_type)
                VALUES (?, ?, ?)
                `
            ),
            setSetting: this.db.prepare(
                `
                INSERT INTO settings (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                `
            ),
            getSetting: this.db.prepare("SELECT value FROM settings WHERE key = ?"),
            upsertDrop: this.db.prepare(
                `
                INSERT INTO drops (platform, external_id, title, channels_json, game, start_time, end_time, status, last_seen)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(platform, external_id)
                DO UPDATE SET
                  title = excluded.title,
                  channels_json = excluded.channels_json,
                  game = excluded.game,
                  start_time = excluded.start_time,
                  end_time = excluded.end_time,
                  status = excluded.status,
                  last_seen = datetime('now')
                `
            ),
            selectDropByExternalId: this.db.prepare(
                `
                SELECT
                  id,
                  platform,
                  external_id as externalId,
                  title,
                  channels_json as channelsJson,
                  game,
                  start_time as startTime,
                  end_time as endTime,
                  status,
                  last_seen as lastSeen
                FROM drops
                WHERE platform = ? AND external_id = ?
                `
            ),
            endMissingDropsWhenNoSeenIds: this.db.prepare(
                `
                UPDATE drops
                SET status = 'ended'
                WHERE platform = ?
                  AND status IN ('upcoming', 'active')
                `
            ),
            markSecretFound: this.db.prepare(
                `
                INSERT OR IGNORE INTO user_secrets_found (discord_user_id, secret_key)
                VALUES (?, ?)
                `
            ),
            getSecretsFoundCount: this.db.prepare(
                "SELECT COUNT(*) as count FROM user_secrets_found WHERE discord_user_id = ?"
            ),
            resetSecrets: this.db.prepare("DELETE FROM user_secrets_found WHERE discord_user_id = ?"),
            pruneOldUserNotifications: this.db.prepare(
                `
                DELETE FROM user_notifications_sent
                WHERE sent_at < datetime('now', '-' || ? || ' days')
                `
            ),
            pruneOldWatchNotifications: this.db.prepare(
                `
                DELETE FROM notifications_sent
                WHERE sent_at < datetime('now', '-' || ? || ' days')
                `
            )
        };
        this.markUserNotificationsSentBatchTx = this.db.transaction(
            (rows: Array<{ discordUserId: string; dropId: number; notificationType: string }>) => {
                for (const row of rows) {
                    this.hotStatements.markUserNotificationSent.run(
                        row.discordUserId,
                        row.dropId,
                        row.notificationType
                    );
                }
            }
        );
        this.upsertDropsBatchTx = this.db.transaction((drops: NormalizedDrop[]) => {
            for (const drop of drops) {
                const channelsJson = JSON.stringify(Array.from(new Set(drop.channels ?? [])));
                this.hotStatements.upsertDrop.run(
                    drop.platform,
                    drop.externalId,
                    drop.title,
                    channelsJson,
                    drop.game.toLowerCase(),
                    drop.startTime,
                    drop.endTime,
                    drop.status
                );
            }
        });
    }

    /** Creates base tables/indexes and performs additive schema migrations if needed. */
    private init() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        discord_user_id TEXT PRIMARY KEY,
                auto_ping INTEGER NOT NULL DEFAULT 0,
                alert_24h_6am INTEGER NOT NULL DEFAULT 0,
                alert_12h_6pm INTEGER NOT NULL DEFAULT 0,
                alert_1h INTEGER NOT NULL DEFAULT 1,
                                alert_checkdrops INTEGER NOT NULL DEFAULT 1,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS watches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('twitch', 'kick')),
        streamer TEXT NOT NULL,
        game TEXT NOT NULL DEFAULT 'rust',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(discord_user_id, platform, streamer)
      );

      CREATE TABLE IF NOT EXISTS drops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK (platform IN ('twitch', 'kick')),
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
                channels_json TEXT NOT NULL DEFAULT '[]',
        game TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('upcoming', 'active', 'ended')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(platform, external_id)
      );

      CREATE TABLE IF NOT EXISTS notifications_sent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id INTEGER NOT NULL,
        drop_id INTEGER NOT NULL,
        notification_type TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(watch_id, drop_id, notification_type)
      );

            CREATE TABLE IF NOT EXISTS user_notifications_sent (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                discord_user_id TEXT NOT NULL,
                drop_id INTEGER NOT NULL,
                notification_type TEXT NOT NULL,
                sent_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(discord_user_id, drop_id, notification_type)
            );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

            CREATE TABLE IF NOT EXISTS secrets_found (
                secret_key TEXT PRIMARY KEY,
                found_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS user_secrets_found (
                discord_user_id TEXT NOT NULL,
                secret_key TEXT NOT NULL,
                found_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (discord_user_id, secret_key)
            );

            CREATE TABLE IF NOT EXISTS custom_gifs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                discord_user_id TEXT NOT NULL,
                view_url TEXT NOT NULL,
                display_name TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(discord_user_id, view_url)
            );

            CREATE INDEX IF NOT EXISTS idx_drops_status_end_time
                ON drops(status, end_time);
            CREATE INDEX IF NOT EXISTS idx_drops_status_start_time
                ON drops(status, start_time);
            CREATE INDEX IF NOT EXISTS idx_drops_platform_status
                ON drops(platform, status);
            CREATE INDEX IF NOT EXISTS idx_users_auto_ping
                ON users(auto_ping);
            CREATE INDEX IF NOT EXISTS idx_user_notifications_user_drop_type
                ON user_notifications_sent(discord_user_id, drop_id, notification_type);
            CREATE INDEX IF NOT EXISTS idx_user_notifications_sent_at
                ON user_notifications_sent(sent_at);
            CREATE INDEX IF NOT EXISTS idx_notifications_sent_sent_at
                ON notifications_sent(sent_at);
    `);

        const userColumns = this.db
            .prepare("PRAGMA table_info(users)")
            .all() as Array<{ name: string }>;

        const hasAutoPing = userColumns.some((column) => column.name === "auto_ping");
        if (!hasAutoPing) {
            this.db.exec("ALTER TABLE users ADD COLUMN auto_ping INTEGER NOT NULL DEFAULT 0");
        }

        const hasAlert24h6am = userColumns.some((column) => column.name === "alert_24h_6am");
        if (!hasAlert24h6am) {
            this.db.exec("ALTER TABLE users ADD COLUMN alert_24h_6am INTEGER NOT NULL DEFAULT 0");
        }

        const hasAlert12h6pm = userColumns.some((column) => column.name === "alert_12h_6pm");
        if (!hasAlert12h6pm) {
            this.db.exec("ALTER TABLE users ADD COLUMN alert_12h_6pm INTEGER NOT NULL DEFAULT 0");
        }

        const hasAlert1h = userColumns.some((column) => column.name === "alert_1h");
        if (!hasAlert1h) {
            this.db.exec("ALTER TABLE users ADD COLUMN alert_1h INTEGER NOT NULL DEFAULT 1");
        }

        const hasAlertCheckdrops = userColumns.some((column) => column.name === "alert_checkdrops");
        if (!hasAlertCheckdrops) {
            this.db.exec("ALTER TABLE users ADD COLUMN alert_checkdrops INTEGER NOT NULL DEFAULT 1");
        }

        const customGifColumns = this.db
            .prepare("PRAGMA table_info(custom_gifs)")
            .all() as Array<{ name: string }>;

        const dropColumns = this.db
            .prepare("PRAGMA table_info(drops)")
            .all() as Array<{ name: string }>;

        const hasChannelsJson = dropColumns.some((column) => column.name === "channels_json");
        if (!hasChannelsJson) {
            this.db.exec("ALTER TABLE drops ADD COLUMN channels_json TEXT NOT NULL DEFAULT '[]'");
        }

        const hasDisplayName = customGifColumns.some((column) => column.name === "display_name");
        if (!hasDisplayName) {
            this.db.exec("ALTER TABLE custom_gifs ADD COLUMN display_name TEXT");
        }
    }

    /** Ensures a user row exists before writing user-scoped settings or state. */
    private ensureUser(discordUserId: string): void {
        this.hotStatements.ensureUser.run(discordUserId);
    }

    /** Returns (and caches) dynamic UPDATE statement for a specific alert-type set. */
    private getSetAlertsEnabledStatement(alertTypes: AlertType[]): Database.Statement {
        const sortedTypes = [...alertTypes].sort();
        const key = sortedTypes.join("|");
        const cached = this.setAlertsEnabledStatementsByKey.get(key);
        if (cached) {
            return cached;
        }

        const assignments = sortedTypes.map((alertType) => `${alertType} = ?`).join(", ");
        const statement = this.db.prepare(`UPDATE users SET ${assignments} WHERE discord_user_id = ?`);
        this.setAlertsEnabledStatementsByKey.set(key, statement);
        return statement;
    }

    /** Returns (and caches) eligibility query for a specific drop-id IN-list size. */
    private getEligibleUsersForDropsStatement(dropCount: number): Database.Statement {
        const cached = this.eligibleUsersForDropsStatementsByCount.get(dropCount);
        if (cached) {
            return cached;
        }

        const placeholders = Array.from({ length: dropCount }, () => "?").join(", ");
        const statement = this.db.prepare(
            `
                SELECT
                    d.id as dropId,
                    u.discord_user_id as discordUserId
                FROM drops d
                JOIN users u ON u.auto_ping = 1
                WHERE d.id IN (${placeholders})
                  AND NOT EXISTS (
                    SELECT 1
                    FROM user_notifications_sent uns
                    WHERE uns.discord_user_id = u.discord_user_id
                      AND uns.drop_id = d.id
                      AND uns.notification_type = ?
                  )
                `
        );

        this.eligibleUsersForDropsStatementsByCount.set(dropCount, statement);
        return statement;
    }

    /** Returns (and caches) drop select query for a specific external-id IN-list size. */
    private getSelectDropsByPlatformStatement(externalIdCount: number): Database.Statement {
        const cached = this.selectDropsByPlatformStatementsByCount.get(externalIdCount);
        if (cached) {
            return cached;
        }

        const placeholders = Array.from({ length: externalIdCount }, () => "?").join(", ");
        const statement = this.db.prepare(
            `
                    SELECT
                      id,
                      platform,
                      external_id as externalId,
                      title,
                      channels_json as channelsJson,
                      game,
                      start_time as startTime,
                      end_time as endTime,
                      status,
                      last_seen as lastSeen
                    FROM drops
                    WHERE platform = ?
                      AND external_id IN (${placeholders})
                    `
        );

        this.selectDropsByPlatformStatementsByCount.set(externalIdCount, statement);
        return statement;
    }

    /** Returns (and caches) end-missing query for a specific seen-id IN-list size. */
    private getEndMissingDropsStatement(seenCount: number): Database.Statement {
        const cached = this.endMissingDropsStatementsByCount.get(seenCount);
        if (cached) {
            return cached;
        }

        const placeholders = Array.from({ length: seenCount }, () => "?").join(", ");
        const statement = this.db.prepare(
            `
                UPDATE drops
                SET status = 'ended'
                WHERE platform = ?
                  AND status IN ('upcoming', 'active')
                  AND external_id NOT IN (${placeholders})
                `
        );

        this.endMissingDropsStatementsByCount.set(seenCount, statement);
        return statement;
    }

    /** Legacy watch-management operations kept for compatibility with earlier bot modes. */
    addWatch(discordUserId: string, platform: Platform, streamer: string, game = "rust"): boolean {
        this.ensureUser(discordUserId);

        const result = this.db
            .prepare(
                `
        INSERT OR IGNORE INTO watches (discord_user_id, platform, streamer, game, enabled)
        VALUES (?, ?, ?, ?, 1)
      `
            )
            .run(discordUserId, platform, streamer.toLowerCase(), game.toLowerCase());

        return result.changes > 0;
    }

    listWatches(discordUserId: string): Watch[] {
        const rows = this.db
            .prepare(
                `
        SELECT
          id,
          discord_user_id as discordUserId,
          platform,
          streamer,
          game,
          enabled,
          created_at as createdAt
        FROM watches
        WHERE discord_user_id = ?
        ORDER BY created_at DESC
      `
            )
            .all(discordUserId);

        return rows as Watch[];
    }

    removeWatch(discordUserId: string, watchId: number): boolean {
        const result = this.db
            .prepare("DELETE FROM watches WHERE id = ? AND discord_user_id = ?")
            .run(watchId, discordUserId);

        return result.changes > 0;
    }

    getWatchesForPlatform(platform: Platform, game = "rust"): Watch[] {
        const rows = this.db
            .prepare(
                `
        SELECT
          id,
          discord_user_id as discordUserId,
          platform,
          streamer,
          game,
          enabled,
          created_at as createdAt
        FROM watches
        WHERE platform = ? AND game = ? AND enabled = 1
      `
            )
            .all(platform, game.toLowerCase());

        return rows as Watch[];
    }

    /** Alert preference and user-level ping toggle management. */
    setAutoPing(discordUserId: string, enabled: boolean): void {
        this.ensureUser(discordUserId);

        this.hotStatements.setAutoPing.run(enabled ? 1 : 0, discordUserId);
    }

    isAutoPingEnabled(discordUserId: string): boolean {
        const row = this.hotStatements.isAutoPingEnabled
            .get(discordUserId) as { autoPing: number } | undefined;

        return row?.autoPing === 1;
    }

    setTimedAlertEnabled(discordUserId: string, alertType: TimedAlertType, enabled: boolean): void {
        this.setAlertEnabled(discordUserId, alertType, enabled);
    }

    setAlertEnabled(discordUserId: string, alertType: AlertType, enabled: boolean): void {
        this.setAlertsEnabled(discordUserId, [alertType], enabled);
    }

    setAlertsEnabled(discordUserId: string, alertTypes: AlertType[], enabled: boolean): void {
        this.ensureUser(discordUserId);

        const uniqueTypes = Array.from(new Set(alertTypes));
        if (uniqueTypes.length === 0) {
            return;
        }

        const enabledValue = enabled ? 1 : 0;
        this.getSetAlertsEnabledStatement(uniqueTypes)
            .run(...uniqueTypes.map(() => enabledValue), discordUserId);
        this.hotStatements.recomputeAutoPingFromAlerts.run(discordUserId);
    }

    getUserAlertSettings(discordUserId: string): UserAlertSettings {
        this.ensureUser(discordUserId);

        const row = this.hotStatements.getUserAlertSettings
            .get(discordUserId) as
            | {
                autoPing: number;
                alert24h6am: number;
                alert12h6pm: number;
                alert1h: number;
                alertCheckdrops: number;
            }
            | undefined;

        return {
            autoPing: row?.autoPing === 1,
            alert24h6am: row?.alert24h6am === 1,
            alert12h6pm: row?.alert12h6pm === 1,
            alert1h: row?.alert1h === 1,
            alertCheckdrops: row?.alertCheckdrops === 1
        };
    }

    isAlertEnabled(discordUserId: string, alertType: AlertType): boolean {
        this.ensureUser(discordUserId);

        const row = this.alertEnabledStatements[alertType]
            .get(discordUserId) as { enabled: number } | undefined;

        return row?.enabled === 1;
    }

    getUserIdsForAlert(alertType: AlertType): string[] {
        const rows = this.alertUserIdsStatements[alertType]
            .all() as Array<{ discordUserId: string }>;

        return rows.map((row) => row.discordUserId);
    }

    getAutoPingUserIds(): string[] {
        const rows = this.hotStatements.getAutoPingUserIds
            .all() as Array<{ discordUserId: string }>;

        return rows.map((row) => row.discordUserId);
    }

    getEligibleAutoPingUserIdsForDrop(dropId: number, notificationType: string): string[] {
        const rows = this.hotStatements.getEligibleAutoPingUserIdsForDrop
            .all(dropId, notificationType) as Array<{ discordUserId: string }>;

        return rows.map((row) => row.discordUserId);
    }

    getEligibleAutoPingUserIdsForDrops(
        dropIds: number[],
        notificationType: string
    ): Map<number, string[]> {
        const uniqueDropIds = Array.from(new Set(dropIds.filter((id) => Number.isFinite(id))));
        const result = new Map<number, string[]>();

        for (const dropId of uniqueDropIds) {
            result.set(dropId, []);
        }

        if (uniqueDropIds.length === 0) {
            return result;
        }

        const rows = this.getEligibleUsersForDropsStatement(uniqueDropIds.length)
            .all(...uniqueDropIds, notificationType) as Array<{ dropId: number; discordUserId: string }>;

        for (const row of rows) {
            const existing = result.get(row.dropId);
            if (existing) {
                existing.push(row.discordUserId);
            }
        }

        return result;
    }

    /** Drop campaign persistence, lookup, and reconciliation helpers. */
    upsertDrop(drop: NormalizedDrop): Drop {
        const channelsJson = JSON.stringify(Array.from(new Set(drop.channels ?? [])));

        this.hotStatements.upsertDrop
            .run(
                drop.platform,
                drop.externalId,
                drop.title,
                channelsJson,
                drop.game.toLowerCase(),
                drop.startTime,
                drop.endTime,
                drop.status
            );

        const row = this.hotStatements.selectDropByExternalId
            .get(drop.platform, drop.externalId);

        return this.mapDropRow(row);
    }

    upsertDrops(drops: NormalizedDrop[]): Drop[] {
        if (drops.length === 0) {
            return [];
        }

        this.upsertDropsBatchTx(drops);

        const externalIdsByPlatform = new Map<Platform, Set<string>>();
        for (const drop of drops) {
            const existing = externalIdsByPlatform.get(drop.platform);
            if (existing) {
                existing.add(drop.externalId);
            } else {
                externalIdsByPlatform.set(drop.platform, new Set([drop.externalId]));
            }
        }

        const rowByKey = new Map<string, any>();
        for (const [platform, externalIdsSet] of externalIdsByPlatform.entries()) {
            const externalIds = Array.from(externalIdsSet);
            if (externalIds.length === 0) {
                continue;
            }

            const rows = this.getSelectDropsByPlatformStatement(externalIds.length)
                .all(platform, ...externalIds) as Array<{ platform: string; externalId: string }>;

            for (const row of rows) {
                const key = `${String(row.platform)}:${String(row.externalId)}`;
                rowByKey.set(key, row);
            }
        }

        return drops.map((drop) => {
            const key = `${drop.platform}:${drop.externalId}`;
            const row = rowByKey.get(key) ?? this.hotStatements.selectDropByExternalId
                .get(drop.platform, drop.externalId);
            return this.mapDropRow(row);
        });
    }

    endMissingDropsForPlatform(platform: Platform, seenExternalIds: string[]): void {
        const normalizedSeen = Array.from(new Set(seenExternalIds.map((value) => value.trim()).filter(Boolean)));

        if (normalizedSeen.length === 0) {
            this.hotStatements.endMissingDropsWhenNoSeenIds.run(platform);
            return;
        }

        this.getEndMissingDropsStatement(normalizedSeen.length)
            .run(platform, ...normalizedSeen);
    }

    private mapDropRow(row: any): Drop {
        const parsedChannels = (() => {
            const rawChannelsJson = String(row?.channelsJson ?? "[]").trim();
            if (rawChannelsJson === "[]") {
                return [];
            }

            try {
                const parsed = JSON.parse(rawChannelsJson);
                if (!Array.isArray(parsed)) {
                    return [];
                }

                return parsed.map((value) => String(value));
            } catch {
                return [];
            }
        })();

        return {
            id: Number(row.id),
            platform: row.platform as Platform,
            externalId: String(row.externalId),
            title: String(row.title),
            channels: parsedChannels,
            game: String(row.game),
            startTime: String(row.startTime),
            endTime: String(row.endTime),
            status: row.status as "upcoming" | "active" | "ended",
            lastSeen: String(row.lastSeen)
        };
    }

    /** Legacy watch-based notification dedupe records. */
    getActiveDrops(): Drop[] {
        const rows = this.hotStatements.getActiveDrops.all();

        return rows.map((row) => this.mapDropRow(row));
    }

    getUpcomingDropsWithinHours(maxHours: number): Drop[] {
        const rows = this.hotStatements.getUpcomingDropsWithinHours
            .all(maxHours);

        return rows.map((row) => this.mapDropRow(row));
    }

    wasNotificationSent(watchId: number, dropId: number, notificationType: string): boolean {
        const row = this.hotStatements.wasNotificationSent
            .get(watchId, dropId, notificationType);

        return Boolean(row);
    }

    markNotificationSent(watchId: number, dropId: number, notificationType: string): void {
        this.hotStatements.markNotificationSent
            .run(watchId, dropId, notificationType);
    }

    /** User-level notification dedupe records for timed/live/checkdrops announcements. */
    wasUserNotificationSent(discordUserId: string, dropId: number, notificationType: string): boolean {
        const row = this.hotStatements.wasUserNotificationSent
            .get(discordUserId, dropId, notificationType);

        return Boolean(row);
    }

    markUserNotificationSent(discordUserId: string, dropId: number, notificationType: string): void {
        this.hotStatements.markUserNotificationSent
            .run(discordUserId, dropId, notificationType);
    }

    markUserNotificationsSentBatch(
        rows: Array<{ discordUserId: string; dropId: number; notificationType: string }>
    ): void {
        if (rows.length === 0) {
            return;
        }

        this.markUserNotificationsSentBatchTx(rows);
    }

    /** Generic settings, GIF preferences, and custom GIF list management. */
    setSetting(key: string, value: string): void {
        this.hotStatements.setSetting
            .run(key, value);
    }

    getSetting(key: string): string | undefined {
        const row = this.hotStatements.getSetting.get(key) as
            | { value: string }
            | undefined;
        return row?.value;
    }

    setGifMode(mode: GifMode): void {
        this.setSetting("gif_mode", mode);
    }

    setBlahBlahIdkLmaoEnabled(enabled: boolean): void {
        this.setSetting("blah_blah_idk_lmao_enabled", enabled ? "1" : "0");
    }

    isBlahBlahIdkLmaoEnabled(): boolean {
        const value = this.getSetting("blah_blah_idk_lmao_enabled");
        if (value === undefined) {
            return true;
        }

        const normalized = value.trim().toLowerCase();
        return normalized === "1" || normalized === "true" || normalized === "on";
    }

    getGifMode(): GifMode {
        const value = this.getSetting("gif_mode");
        if (value === "custom" || value === "both") {
            return value;
        }

        return "default";
    }

    addCustomGif(discordUserId: string, viewUrl: string): boolean {
        this.ensureUser(discordUserId);

        const result = this.customGifStatements.add
            .run(discordUserId, viewUrl);

        return result.changes > 0;
    }

    removeCustomGif(discordUserId: string, gifId: number): boolean {
        const result = this.customGifStatements.remove
            .run(gifId, discordUserId);

        return result.changes > 0;
    }

    renameCustomGif(discordUserId: string, gifId: number, displayName: string): boolean {
        const result = this.customGifStatements.rename
            .run(displayName, gifId, discordUserId);

        return result.changes > 0;
    }

    listCustomGifs(discordUserId: string): CustomGifEntry[] {
        const rows = this.customGifStatements.listByUser
            .all(discordUserId);

        return rows as CustomGifEntry[];
    }

    listAllCustomGifViewUrls(): string[] {
        const rows = this.customGifStatements.listAllDistinctViewUrls
            .all() as Array<{ viewUrl: string }>;

        return rows.map((row) => row.viewUrl);
    }

    /** Secret/easter-egg discovery tracking per user. */
    markSecretFound(discordUserId: string, secretKey: SecretKey): SecretDiscoveryResult {
        this.ensureUser(discordUserId);

        const result = this.hotStatements.markSecretFound
            .run(discordUserId, secretKey);

        const row = this.hotStatements.getSecretsFoundCount
            .get(discordUserId) as { count: number };

        return {
            isNew: result.changes > 0,
            foundCount: row.count,
            totalSecrets: TOTAL_SECRETS
        };
    }

    getSecretsFoundCount(discordUserId: string): number {
        this.ensureUser(discordUserId);

        const row = this.hotStatements.getSecretsFoundCount
            .get(discordUserId) as { count: number };

        return row.count;
    }

    resetSecrets(discordUserId: string): void {
        this.ensureUser(discordUserId);

        this.hotStatements.resetSecrets
            .run(discordUserId);
    }

    /** Scheduled cleanup of dedupe history tables to control database growth. */
    pruneOldNotificationHistory(retentionDays: number): { userNotificationsDeleted: number; watchNotificationsDeleted: number } {
        const safeRetention = Math.max(1, Math.floor(retentionDays));

        const userResult = this.hotStatements.pruneOldUserNotifications
            .run(safeRetention);

        const watchResult = this.hotStatements.pruneOldWatchNotifications
            .run(safeRetention);

        return {
            userNotificationsDeleted: userResult.changes,
            watchNotificationsDeleted: watchResult.changes
        };
    }
}
