import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { getRuntimeConfig } from "./config.js";
import { BotDb } from "./db.js";
import {
    handleButtonInteraction,
    handleChatInputCommand,
    handleModalSubmitInteraction
} from "./commands/handleInteraction.js";
import { KickDropsProvider } from "./providers/kick.js";
import { TwitchDropsProvider } from "./providers/twitch.js";
import type { DropsProvider } from "./providers/base.js";
import { startScheduler } from "./scheduler.js";
import { createShutdown } from "./shutdown.js";
import { logger } from "./logger.js";

/**
 * Bot entrypoint: bootstraps runtime config, providers, interaction handlers, and scheduler.
 */

const config = getRuntimeConfig();
logger.setLevel(config.LOG_LEVEL);
logger.addSecret(config.DISCORD_TOKEN);
logger.addSecret(config.TWITCH_CLIENT_SECRET);
const log = logger.child("bot");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const db = new BotDb(config.DATABASE_PATH);
let scheduler: ReturnType<typeof startScheduler> | undefined;

const shutdown = createShutdown({
    timeoutMs: 15000,
    exit: (code) => process.exit(code),
    steps: [
        { name: "scheduler", run: () => scheduler?.stop() },
        { name: "discord client", run: () => client.destroy() },
        { name: "database", run: () => db.close() }
    ]
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
}
process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection:", reason);
    void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
    log.error("Uncaught exception:", error);
    void shutdown("uncaughtException", 1);
});
const providers = [
    new TwitchDropsProvider({
        useMockData: config.TWITCH_MOCK_DROPS,
        clientId: config.TWITCH_CLIENT_ID,
        clientSecret: config.TWITCH_CLIENT_SECRET
    }),
    new KickDropsProvider(config.KICK_MOCK_DROPS)
] as unknown as DropsProvider[];

client.once(Events.ClientReady, (readyClient) => {
    log.info(`Logged in as ${readyClient.user.tag}`);
    log.info(
        `Drops providers mode: twitch=${config.TWITCH_MOCK_DROPS ? "mock" : "live"}, kick=${config.KICK_MOCK_DROPS ? "mock" : "live"
        }`
    );

    scheduler = startScheduler({
        client,
        db,
        providers,
        intervalMs: config.CHECK_INTERVAL_MS
    });
});

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            await handleChatInputCommand(interaction, {
                client,
                db,
                providers
            });
            return;
        }

        if (interaction.isButton()) {
            await handleButtonInteraction(interaction, { db });
            return;
        }

        if (interaction.isModalSubmit()) {
            await handleModalSubmitInteraction(interaction, { db });
        }
    } catch (error) {
        log.error("Command handling failed:", error);

        try {
            if (interaction.isRepliable()) {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({
                        content: "Something went wrong.",
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }

                await interaction.reply({
                    content: "Something went wrong.",
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (responseError) {
            log.error("Failed to send command error response:", responseError);
        }
    }
});

client.login(config.DISCORD_TOKEN).catch((error) => {
    log.error("Discord login failed:", error);
    void shutdown("login failure", 1);
});
