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

/**
 * Bot entrypoint: bootstraps runtime config, providers, interaction handlers, and scheduler.
 */

const config = getRuntimeConfig();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const db = new BotDb(config.DATABASE_PATH);
const providers = [
    new TwitchDropsProvider({
        useMockData: config.TWITCH_MOCK_DROPS,
        clientId: config.TWITCH_CLIENT_ID,
        clientSecret: config.TWITCH_CLIENT_SECRET
    }),
    new KickDropsProvider(config.KICK_MOCK_DROPS)
] as unknown as DropsProvider[];

client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    console.log(
        `Drops providers mode: twitch=${config.TWITCH_MOCK_DROPS ? "mock" : "live"}, kick=${config.KICK_MOCK_DROPS ? "mock" : "live"
        }`
    );

    startScheduler({
        client,
        db,
        providers,
        intervalMs: config.CHECK_INTERVAL_MS,
        envChannelId: config.REMINDER_CHANNEL_ID
    });
});

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            await handleChatInputCommand(interaction, {
                client,
                db,
                providers,
                envChannelId: config.REMINDER_CHANNEL_ID
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
        console.error("Command handling failed:", error);

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
            console.error("Failed to send command error response:", responseError);
        }
    }
});

client.login(config.DISCORD_TOKEN).catch((error) => {
    console.error("Discord login failed:", error);
    process.exit(1);
});
