import { REST, Routes } from "discord.js";
import { getDeployConfig } from "../config.js";
import { logger } from "../logger.js";
import { commandDefinitions } from "./definitions.js";

/**
 * One-off command deployment script for guild-scoped slash command registration.
 */

const deployConfig = getDeployConfig();
logger.setLevel(deployConfig.LOG_LEVEL);
logger.addSecret(deployConfig.DISCORD_TOKEN);
logger.addSecret(deployConfig.TWITCH_CLIENT_SECRET);
const log = logger.child("commands");

/** Registers all slash command definitions to the configured guild. */
async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(deployConfig.DISCORD_TOKEN);
    const body = commandDefinitions.map((command) => command.toJSON());

    await rest.put(
        Routes.applicationGuildCommands(deployConfig.DISCORD_CLIENT_ID, deployConfig.DISCORD_GUILD_ID),
        {
            body
        }
    );

    log.info(`Registered ${body.length} command(s).`);
}

registerCommands().catch((error) => {
    log.error("Failed to register commands:", error);
    process.exit(1);
});
