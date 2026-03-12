import { SlashCommandBuilder } from "discord.js";
import {
    CLOSING_PHRASE_COMMAND
} from "./commandNames.js";

/**
 * Slash command definitions used for guild command registration.
 */

/** Canonical slash command schema consumed by the deploy script. */
function buildClosingPhraseCommand(name: string) {
    return new SlashCommandBuilder()
        .setName(name)
        .setDescription("Turn the closing phrase on or off in bot announcements")
        .addStringOption((opt) =>
            opt
                .setName("state")
                .setDescription("Set phrase mode")
                .addChoices(
                    { name: "on", value: "on" },
                    { name: "off", value: "off" }
                )
                .setRequired(true)
        );
}

export const commandDefinitions = [
    new SlashCommandBuilder()
        .setName("setchannel")
        .setDescription("Set channel for bot reminders")
        .addChannelOption((opt) =>
            opt.setName("channel").setDescription("Target reminder channel").setRequired(true)
        ),
    buildClosingPhraseCommand(CLOSING_PHRASE_COMMAND),
    new SlashCommandBuilder()
        .setName("alerts")
        .setDescription("Manage your automated drop ping preferences")
        .addSubcommand((sub) =>
            sub
                .setName("enable")
                .setDescription("Enable one or more alert types")
                .addStringOption((opt) =>
                    opt
                        .setName("types")
                        .setDescription("Use one or more: 24h 12h 1h checkdrops or all")
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("disable")
                .setDescription("Disable one or more alert types")
                .addStringOption((opt) =>
                    opt
                        .setName("types")
                        .setDescription("Use one or more: 24h 12h 1h checkdrops or all")
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub.setName("status").setDescription("Show whether automatic pings are enabled")
        ),
    new SlashCommandBuilder()
        .setName("gifs")
        .setDescription("Manage GIF mode and your custom GIF list")
        .addSubcommand((sub) =>
            sub
                .setName("mode")
                .setDescription("Set GIF source mode")
                .addStringOption((opt) =>
                    opt
                        .setName("mode")
                        .setDescription("GIF source mode")
                        .addChoices(
                            { name: "Default (built-in only)", value: "default" },
                            { name: "Custom only", value: "custom" },
                            { name: "Both (built-in + custom)", value: "both" }
                        )
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub.setName("status").setDescription("Show current GIF mode and custom GIF counts")
        )
        .addSubcommand((sub) =>
            sub
                .setName("add")
                .setDescription("Add a Tenor view URL to your custom GIF list")
                .addStringOption((opt) =>
                    opt.setName("url").setDescription("Tenor view URL").setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("remove")
                .setDescription("Remove one of your custom GIFs by id")
                .addIntegerOption((opt) =>
                    opt.setName("id").setDescription("GIF id from /gifs list").setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("rename")
                .setDescription("Rename one of your custom GIFs by id")
                .addIntegerOption((opt) =>
                    opt.setName("id").setDescription("GIF id from /gifs list").setRequired(true)
                )
                .addStringOption((opt) =>
                    opt
                        .setName("name")
                        .setDescription("New custom display name")
                        .setMinLength(1)
                        .setMaxLength(80)
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("list")
                .setDescription("List your custom GIFs with previews")
                .addIntegerOption((opt) =>
                    opt
                        .setName("page")
                        .setDescription("Page number (5 GIFs per page)")
                        .setMinValue(1)
                        .setRequired(false)
                )
        ),
    new SlashCommandBuilder()
        .setName("checkdrops")
        .setDescription("Run a drops check now")
        .addStringOption((opt) =>
            opt
                .setName("mode")
                .setDescription("Snapshot mode")
                .addChoices(
                    { name: "verified only (default)", value: "verified" },
                    { name: "full (verified, discovered, unknown, none)", value: "full" }
                )
                .setRequired(false)
        ),
    new SlashCommandBuilder().setName("help").setDescription("Show bot commands and usage")
];
