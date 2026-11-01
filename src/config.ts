import dotenv from "dotenv";
import { z } from "zod";

/**
 * Environment configuration parsing and validation for runtime and deploy commands.
 */

dotenv.config();

export const MIN_CHECK_INTERVAL_MS = 1000;
export const MAX_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

/** Treats a blank value (for example `KEY=` in a .env file) as unset so the default applies. */
function blankAsUnset(value: unknown): unknown {
    return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const booleanFlag = z.preprocess(
    blankAsUnset,
    z
        .string()
        .default("false")
        .transform((value, ctx) => {
            const normalized = value.trim().toLowerCase();
            if (TRUE_VALUES.has(normalized)) return true;
            if (FALSE_VALUES.has(normalized)) return false;
            ctx.addIssue({ code: "custom", message: "Must be one of: true, false, 1, 0, yes, no, on, off." });
            return z.NEVER;
        })
);

const checkInterval = z.preprocess(
    blankAsUnset,
    z
        .string()
        .default("300000")
        .transform((value, ctx) => {
            const trimmed = value.trim();
            const parsed = Number(trimmed);
            if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed)) {
                ctx.addIssue({ code: "custom", message: "Must be a whole number of milliseconds." });
                return z.NEVER;
            }
            if (parsed < MIN_CHECK_INTERVAL_MS || parsed > MAX_CHECK_INTERVAL_MS) {
                ctx.addIssue({
                    code: "custom",
                    message: `Must be between ${MIN_CHECK_INTERVAL_MS} and ${MAX_CHECK_INTERVAL_MS} milliseconds.`
                });
                return z.NEVER;
            }
            return parsed;
        })
);

const BaseEnvSchema = z.object({
    DISCORD_TOKEN: z.string().min(1),
    DISCORD_PUBLIC_KEY: z.string().optional(),
    DATABASE_PATH: z.preprocess(blankAsUnset, z.string().default("./data/bot.db")),
    CHECK_INTERVAL_MS: checkInterval,
    TWITCH_CLIENT_ID: z.string().optional(),
    TWITCH_CLIENT_SECRET: z.string().optional(),
    TWITCH_MOCK_DROPS: booleanFlag,
    KICK_MOCK_DROPS: booleanFlag
});

const DeployEnvSchema = BaseEnvSchema.extend({
    DISCORD_CLIENT_ID: z.string().min(1),
    DISCORD_GUILD_ID: z.string().min(1)
});

/** Result of validating an environment without side effects (no logging or process exit). */
export type ConfigResult<T> = { ok: true; data: T } | { ok: false; errors: Record<string, string[] | undefined> };

function validateEnv<TSchema extends z.ZodTypeAny>(schema: TSchema, env: NodeJS.ProcessEnv): ConfigResult<z.infer<TSchema>> {
    const parsed = schema.safeParse(env);
    if (parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, errors: parsed.error.flatten().fieldErrors as Record<string, string[] | undefined> };
}

/** Validates runtime configuration from an arbitrary environment map. */
export function validateRuntimeEnv(env: NodeJS.ProcessEnv) {
    return validateEnv(BaseEnvSchema, env);
}

/** Validates command-deployment configuration from an arbitrary environment map. */
export function validateDeployEnv(env: NodeJS.ProcessEnv) {
    return validateEnv(DeployEnvSchema, env);
}

function parseEnv<T>(result: ConfigResult<T>, context: string): T {
    if (!result.ok) {
        // Only field names and validation messages are logged, never values, so secrets stay out of logs.
        console.error(`${context}: invalid environment configuration`, result.errors);
        process.exit(1);
    }

    return result.data;
}

/**
 * Parses environment variables required for normal bot runtime execution.
 */
export function getRuntimeConfig() {
    return parseEnv(validateRuntimeEnv(process.env), "Runtime startup");
}

/**
 * Parses environment variables required for slash command registration.
 */
export function getDeployConfig() {
    return parseEnv(validateDeployEnv(process.env), "Command deployment");
}
