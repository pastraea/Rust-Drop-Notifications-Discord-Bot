import dotenv from "dotenv";
import { z } from "zod";

/**
 * Environment configuration parsing and validation for runtime and deploy commands.
 */

dotenv.config();

const BaseEnvSchema = z.object({
    DISCORD_TOKEN: z.string().min(1),
    DISCORD_PUBLIC_KEY: z.string().optional(),
    REMINDER_CHANNEL_ID: z.string().optional(),
    DATABASE_PATH: z.string().default("./data/bot.db"),
    CHECK_INTERVAL_MS: z
        .string()
        .default("300000")
        .transform((value) => Number(value)),
    TWITCH_CLIENT_ID: z.string().optional(),
    TWITCH_CLIENT_SECRET: z.string().optional(),
    TWITCH_MOCK_DROPS: z
        .string()
        .default("false")
        .transform((value) => value.toLowerCase() === "true"),
    KICK_MOCK_DROPS: z
        .string()
        .default("false")
        .transform((value) => value.toLowerCase() === "true")
});

const DeployEnvSchema = BaseEnvSchema.extend({
    DISCORD_CLIENT_ID: z.string().min(1),
    DISCORD_GUILD_ID: z.string().min(1)
});

function parseEnv<TSchema extends z.ZodTypeAny>(schema: TSchema, context: string): z.infer<TSchema> {
    const parsed = schema.safeParse(process.env);

    if (!parsed.success) {
        console.error(`${context}: invalid environment configuration`, parsed.error.flatten().fieldErrors);
        process.exit(1);
    }

    return parsed.data;
}

/**
 * Parses environment variables required for normal bot runtime execution.
 */
export function getRuntimeConfig() {
    return parseEnv(BaseEnvSchema, "Runtime startup");
}

/**
 * Parses environment variables required for slash command registration.
 */
export function getDeployConfig() {
    return parseEnv(DeployEnvSchema, "Command deployment");
}
