import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    type ChatInputCommandInteraction,
    type Client,
    type ModalSubmitInteraction
} from "discord.js";
import type { AlertType, BotDb, GifMode, TimedAlertType } from "../db.js";
import type { DropsProvider } from "../providers/base.js";
import { runDropsCycle } from "../scheduler.js";
import { RARE_BEE_GIF_CHANCE, RARE_BEE_GIF_VIEW_URL } from "../services/rustGifAllowlist.js";
import { getAnnouncementChannelsSummary } from "../services/announcementTargets.js";
import { formatSecretsProgress } from "../services/secrets.js";
import {
    CLOSING_PHRASE_COMMAND,
    isClosingPhraseCommandName
} from "./commandNames.js";

/**
 * Discord interaction handlers for slash commands, buttons, and modals.
 */

/**
 * Runtime dependencies required to process command and component interactions.
 */
export interface InteractionDeps {
    client: Client;
    db: BotDb;
    providers: DropsProvider[];
    envChannelId?: string;
}

const TENOR_VIEW_URL_REGEX = /^https:\/\/tenor\.com\/view\/[a-z0-9\-]+/i;
const GIF_LIST_PAGE_SIZE = 5;
const NO_CHEATING_GIF_VIEW_URL =
    "https://tenor.com/view/you-wouldn%27t-ratatouille-piracy-it%27s-a-crime-piracy-is-stealing-meme-gif-11554142448863112842";
const BEE_FACE_REVEAL_GIF_VIEW_URL =
    "https://tenor.com/view/bee-dance-oondasta-gif-7840770166591174503";
const BEE_QUIZ_QUESTION_COUNT = 5;
const BEE_QUIZ_ANSWER_BUTTON_PREFIX = "beequiz-answer";
const BEE_QUIZ_MODAL_PREFIX = "beequiz-modal";
const RESET_SECRETS_YES_BUTTON_PREFIX = "secrets-reset-yes";
const RESET_SECRETS_NO_BUTTON_PREFIX = "secrets-reset-no";
const TENOR_MEDIA_CACHE_TTL_MS = 10 * 60 * 1000;
const ALL_ALERT_TYPES: AlertType[] = ["alert_24h_6am", "alert_12h_6pm", "alert_1h", "alert_checkdrops"];
const ALERT_TYPE_TOKEN_MAP = new Map<string, AlertType>([
    ["24h", "alert_24h_6am"],
    ["6am", "alert_24h_6am"],
    ["morning", "alert_24h_6am"],
    ["alert_24h_6am", "alert_24h_6am"],
    ["12h", "alert_12h_6pm"],
    ["6pm", "alert_12h_6pm"],
    ["evening", "alert_12h_6pm"],
    ["alert_12h_6pm", "alert_12h_6pm"],
    ["1h", "alert_1h"],
    ["hour", "alert_1h"],
    ["alert_1h", "alert_1h"],
    ["checkdrops", "alert_checkdrops"],
    ["checkdrop", "alert_checkdrops"],
    ["check", "alert_checkdrops"],
    ["manual", "alert_checkdrops"]
]);
const VERB_LIKE_TOKENS = new Set([
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "can",
    "could",
    "will",
    "would",
    "should",
    "might",
    "may"
]);
const VERB_SUFFIX_REGEX = /(?:ed|ing)$/;

interface BeeQuizWord {
    word: string;
}

interface BeeQuizSession {
    words: BeeQuizWord[];
    index: number;
}

const beeQuizSessions = new Map<string, BeeQuizSession>();
const lastBeeQuizSignatureByUser = new Map<string, string>();
const tenorMediaUrlCache = new Map<string, { mediaUrl?: string; expiresAt: number }>();

const BEE_WORD_POOL: BeeQuizWord[] = [
    "antidisestablishmentarianism",
    "pneumonoultramicroscopicsilicovolcanoconiosis",
    "floccinaucinihilipilification",
    "hippopotomonstrosesquipedaliophobia",
    "honorificabilitudinitatibus",
    "electroencephalographically",
    "immunoelectrophoretically",
    "psychoneuroendocrinological",
    "dichlorodifluoromethane",
    "thyroparathyroidectomized",
    "counterrevolutionaries",
    "sesquipedalianism",
    "uncharacteristically",
    "interdisciplinarity",
    "incomprehensibility",
    "chrononhotonthologos",
    "microspectrophotometries",
    "spectrophotofluorometrically",
    "transubstantiationalist",
    "subdermatoglyphic",
    "disproportionableness",
    "institutionalization",
    "autochronodromometer",
    "thermoelectroluminescence",
    "mischaracterization",
    "otorhinolaryngological",
    "hepaticocholangiogastrostomy",
    "radioimmunoelectrophoresis",
    "psychophysicotherapeutics",
    "ultracrepidarianism",
    "electroencephalograph",
    "hypercholesterolemia",
    "gastroenterological",
    "laryngotracheobronchitis",
    "deinstitutionalization",
    "intersubjectivities",
    "hyperparathyroidism",
    "immunohistochemistry",
    "magnetohydrodynamics",
    "microarchitectonics",
    "pseudopseudohypoparathyroidism",
    "psychopharmacological",
    "electrocardiographically",
    "counterreformation",
    "misinterpretation",
    "otorhinolaryngology",
    "pathophysiological",
    "supercalifragilisticexpialidocious",
    "thigmotropism",
    "xenotransplantation",
    "ultramicroscopic",
    "incommensurability",
    "characteristically",
    "intercontinental",
    "metamorphoses",
    "bioluminescence",
    "institutionalisation",
    "electrodynamometer",
    "multidimensionality",
    "neurophysiological",
    "electroluminescent",
    "otorhinolaryngologist",
    "microangiopathy",
    "counterproductive",
    "chronophotography",
    "cardiothoracic",
    "hyperventilation",
    "deoxyribonucleic",
    "indistinguishability",
    "phenylketonuria",
    "schizophreniform",
    "counterintelligence",
    "unconstitutionality",
    "photosensitization",
    "electromagnetism",
    "stereolithography",
    "microencapsulation",
    "disenfranchisement",
    "thermoregulation",
    "immunocompromised",
    "neurotransmitter",
    "electrophotography",
    "metallurgical",
    "intellectualization",
    "hyperresponsiveness",
    "miscommunication",
    "psycholinguistics",
    "counterbalancing",
    "intergovernmental",
    "electrostatically",
    "microcirculation",
    "photoautotrophic",
    "dysfunctionalities",
    "heteroscedasticity",
    "interdenominational",
    "misappropriation",
    "counterargument",
    "electroanalytical",
    "indiscriminately",
    "recharacterization",
    "institutionalism",
    "anthropomorphism"
].map((word) => ({ word }));

function shuffleWords<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
}

/** Starts (or restarts) a spelling-quiz session for a specific user. */
function startBeeQuiz(userId: string): BeeQuizSession {
    const previousSignature = lastBeeQuizSignatureByUser.get(userId);
    let words = shuffleWords(BEE_WORD_POOL).slice(0, BEE_QUIZ_QUESTION_COUNT);
    let signature = words.map((entry) => entry.word).join("|");

    // Ensure immediate retries do not get the exact same 5-word sequence.
    for (let attempt = 0; attempt < 10 && signature === previousSignature; attempt += 1) {
        words = shuffleWords(BEE_WORD_POOL).slice(0, BEE_QUIZ_QUESTION_COUNT);
        signature = words.map((entry) => entry.word).join("|");
    }

    const session: BeeQuizSession = {
        words,
        index: 0
    };

    beeQuizSessions.set(userId, session);
    lastBeeQuizSignatureByUser.set(userId, signature);
    return session;
}

/** Retrieves the active spelling-quiz session for a user, if any. */
function getBeeQuizSession(userId: string): BeeQuizSession | undefined {
    return beeQuizSessions.get(userId);
}

/** Clears any active spelling-quiz session for a user. */
function clearBeeQuiz(userId: string): void {
    beeQuizSessions.delete(userId);
}

/** Builds the button row used to open the spelling answer modal. */
function buildBeeAnswerButton(userId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${BEE_QUIZ_ANSWER_BUTTON_PREFIX}:${userId}`)
            .setLabel("Answer this word")
            .setStyle(ButtonStyle.Primary)
    );
}

/** Builds confirmation buttons for resetting secret progress. */
function buildResetSecretsButtons(userId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${RESET_SECRETS_YES_BUTTON_PREFIX}:${userId}`)
            .setLabel("Yes")
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${RESET_SECRETS_NO_BUTTON_PREFIX}:${userId}`)
            .setLabel("No")
            .setStyle(ButtonStyle.Secondary)
    );
}

/** Builds the modal used for one spelling quiz question answer. */
function buildBeeQuizModal(userId: string, questionNumber: number): ModalBuilder {
    const spellingInput = new TextInputBuilder()
        .setCustomId("spelling")
        .setLabel("Spell the word")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(128);

    return new ModalBuilder()
        .setCustomId(`${BEE_QUIZ_MODAL_PREFIX}:${userId}`)
        .setTitle(`Spelling Bee Q${questionNumber}/${BEE_QUIZ_QUESTION_COUNT}`)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(spellingInput));
}

/** Normalizes words for tolerant spelling comparisons. */
function normalizeWord(value: string): string {
    return value.toLowerCase().replace(/[^a-z]/g, "");
}

/** Generates accepted spelling variants (UK/US and common orthographic forms). */
function getAcceptedSpellings(word: string): Set<string> {
    const normalized = normalizeWord(word);
    const accepted = new Set<string>([normalized]);

    const queue = [normalized];
    const transformations: Array<[RegExp, string]> = [
        [/isation/g, "ization"],
        [/ization/g, "isation"],
        [/ise/g, "ize"],
        [/ize/g, "ise"],
        [/yse/g, "yze"],
        [/yze/g, "yse"],
        [/our/g, "or"],
        [/or/g, "our"]
    ];

    for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];

        for (const [pattern, replacement] of transformations) {
            const variant = current.replace(pattern, replacement);
            if (!accepted.has(variant)) {
                accepted.add(variant);
                queue.push(variant);
            }
        }
    }

    return accepted;
}

/** Returns whether a normalized sentence includes a normalized target word. */
function sentenceContainsWord(sentence: string, word: string): boolean {
    return normalizeWord(sentence).includes(normalizeWord(word));
}

/** Escapes a string for safe interpolation inside regex sources. */
function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Validates that a user sentence uses the target word with enough context. */
function evaluateSentenceUsage(sentence: string, word: string): { valid: boolean; reason?: string } {
    const trimmed = sentence.trim();
    const tokens = trimmed.match(/[a-zA-Z']+/g) ?? [];
    const normalizedTarget = normalizeWord(word);
    const normalizedTokens = tokens.map((token) => normalizeWord(token)).filter((token) => token.length > 0);
    const hasExactToken = normalizedTokens.includes(normalizedTarget);

    if (!hasExactToken) {
        return { valid: false, reason: "Your sentence must include the exact target word." };
    }

    if (tokens.length < 6) {
        return { valid: false, reason: "Your sentence is too short. Use a full sentence with context." };
    }

    const nonTargetTokens = normalizedTokens.filter((token) => token !== normalizedTarget);
    if (nonTargetTokens.length < 3) {
        return { valid: false, reason: "Add more context words around the target word." };
    }

    const lowerTokens = tokens.map((token) => token.toLowerCase());
    const hasVerbLikeWord = lowerTokens.some((token) =>
        VERB_LIKE_TOKENS.has(token) || VERB_SUFFIX_REGEX.test(token)
    );

    if (!hasVerbLikeWord) {
        return { valid: false, reason: "Your sentence needs a verb/action to read like a real sentence." };
    }

    return { valid: true };
}

/** Builds a temporary text-to-speech attachment for spelling quiz prompts. */
async function buildTtsAttachment(text: string, fileName: string): Promise<AttachmentBuilder | undefined> {
    const hosts = ["translate.googleapis.com", "translate.google.com"];
    const encoded = encodeURIComponent(text);

    for (const host of hosts) {
        const url = `https://${host}/translate_tts?ie=UTF-8&client=tw-ob&tl=en&ttsspeed=1&q=${encoded}`;

        try {
            const response = await fetch(url, {
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    Accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
                    Referer: "https://translate.google.com/",
                    Origin: "https://translate.google.com"
                },
                signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
                continue;
            }

            const audioBuffer = Buffer.from(await response.arrayBuffer());
            if (audioBuffer.length < 1024) {
                continue;
            }

            return new AttachmentBuilder(audioBuffer, { name: fileName });
        } catch {
            // Try next host.
        }
    }

    return undefined;
}

/** Sends one spelling-quiz question prompt and controls ephemeral reply behavior. */
async function sendBeeQuizQuestion(
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
    userId: string,
    session: BeeQuizSession
): Promise<void> {
    const questionNumber = session.index + 1;
    const currentWord = session.words[session.index];
    const voiceAttachment = await buildTtsAttachment(
        currentWord.word,
        `bee-quiz-q${questionNumber}.mp3`
    );

    const payload = {
        content: [
            questionNumber === 1 ? "**SURPRISE!!!\n\nSpelling Bee Quiz**" : "**Spelling Bee Quiz**",
            `Question ${questionNumber}/${BEE_QUIZ_QUESTION_COUNT}`,
            "Listen to the attached voice recording to hear the word.",
            "Press the button below and submit the spelling."
        ].join("\n"),
        files: voiceAttachment ? [voiceAttachment] : [],
        components: [buildBeeAnswerButton(userId)]
    };

    if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

/** Decodes limited HTML entities used in Tenor metadata fields. */
function decodeHtmlEntities(value: string): string {
    return value.replaceAll("&amp;", "&");
}

/** Decodes escaped Tenor media URL fragments extracted from page sources. */
function decodeEscapedTenorUrl(value: string): string {
    return decodeHtmlEntities(value)
        .replaceAll("\\u002F", "/")
        .replaceAll("\\/", "/")
        .replace(/^https:\/\//i, "https://");
}

/** Resolves a Tenor view URL to one direct GIF media URL, with small TTL cache. */
async function resolveTenorGifMediaUrl(viewUrl: string): Promise<string | undefined> {
    const cached = tenorMediaUrlCache.get(viewUrl);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        return cached.mediaUrl;
    }

    try {
        const response = await fetch(viewUrl, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0"
            },
            signal: AbortSignal.timeout(2500)
        });

        if (!response.ok) {
            return undefined;
        }

        const html = await response.text();
        const unescapedMatches = html.match(/https:\/\/(?:media|media1)\.tenor\.com\/[^"'\s>]+/gi) ?? [];
        const escapedMatches =
            html.match(/https:\\u002F\\u002F(?:media|media1)\.tenor\.com\\u002F[^"'\s>]+/gi) ?? [];

        const candidates = Array.from(
            new Set([...unescapedMatches, ...escapedMatches].map((url) => decodeEscapedTenorUrl(url)))
        ).filter((url) => /\.gif($|\?)/i.test(url));

        const mediaUrl = candidates[0];
        tenorMediaUrlCache.set(viewUrl, {
            mediaUrl,
            expiresAt: now + TENOR_MEDIA_CACHE_TTL_MS
        });
        return mediaUrl;
    } catch {
        tenorMediaUrlCache.set(viewUrl, {
            mediaUrl: undefined,
            expiresAt: now + TENOR_MEDIA_CACHE_TTL_MS
        });
        return undefined;
    }
}

/** Downloads a GIF media URL into a Discord attachment payload. */
async function downloadGifAttachmentFromMediaUrl(
    mediaUrl: string,
    fileName: string
): Promise<AttachmentBuilder | undefined> {
    try {
        const response = await fetch(mediaUrl, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0"
            },
            signal: AbortSignal.timeout(3000)
        });

        if (!response.ok) {
            return undefined;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: fileName });
    } catch {
        return undefined;
    }
}

/** Builds the anti-cheat GIF attachment used for the protected rare-bee URL path. */
async function buildNoCheatingGifAttachment(): Promise<AttachmentBuilder | undefined> {
    const mediaUrl = await resolveTenorGifMediaUrl(NO_CHEATING_GIF_VIEW_URL);
    if (!mediaUrl) {
        return undefined;
    }

    return downloadGifAttachmentFromMediaUrl(mediaUrl, "no-cheating.gif");
}

/** Builds a GIF attachment from a Tenor view URL by resolving then downloading media. */
async function buildGifAttachmentFromViewUrl(
    viewUrl: string,
    fileName: string
): Promise<AttachmentBuilder | undefined> {
    const mediaUrl = await resolveTenorGifMediaUrl(viewUrl);
    if (!mediaUrl) {
        return undefined;
    }

    return downloadGifAttachmentFromMediaUrl(mediaUrl, fileName);
}

function buildSecretFooterLines(foundCount: number): string[] {
    return ["Congratulations, you found a secret!", formatSecretsProgress(foundCount)];
}

function buildGifWithSecretFooterEmbed(fileName: string, secretLines: string[]): EmbedBuilder {
    const embed = new EmbedBuilder().setImage(`attachment://${fileName}`);
    if (secretLines.length > 0) {
        embed.setFooter({ text: secretLines.join("\n") });
    }

    return embed;
}

function normalizeTenorViewUrl(url: string): string {
    return url.trim().replace(/^https:\/\/https:\/\//i, "https://");
}

function isValidTenorViewUrl(url: string): boolean {
    return TENOR_VIEW_URL_REGEX.test(url);
}

function normalizeTenorViewUrlForCompare(url: string): string {
    return normalizeTenorViewUrl(url).split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
}

function getGifModeLabel(mode: GifMode): string {
    if (mode === "custom") {
        return "custom";
    }

    if (mode === "both") {
        return "both";
    }

    return "default";
}

function formatAlertTypeLabel(alertType: TimedAlertType): string {
    if (alertType === "alert_24h_6am") {
        return "24h morning (6:00 AM AEST)";
    }

    if (alertType === "alert_12h_6pm") {
        return "12h evening (6:00 PM AEST)";
    }

    return "1h before start";
}

function formatAnyAlertTypeLabel(alertType: AlertType): string {
    if (alertType === "alert_checkdrops") {
        return "Checkdrops manual ping";
    }

    return formatAlertTypeLabel(alertType);
}

function parseAlertTypesInput(rawInput: string | null): { parsed: AlertType[]; invalid: string[] } {
    const normalizedInput = (rawInput ?? "all").trim().toLowerCase();
    if (normalizedInput.length === 0 || normalizedInput === "all") {
        return { parsed: ALL_ALERT_TYPES, invalid: [] };
    }

    const tokens = normalizedInput
        .split(/[\s,|+]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

    if (tokens.includes("all")) {
        return { parsed: ALL_ALERT_TYPES, invalid: [] };
    }

    const parsed = new Set<AlertType>();
    const invalid: string[] = [];

    for (const token of tokens) {
        const mapped = ALERT_TYPE_TOKEN_MAP.get(token);
        if (!mapped) {
            invalid.push(token);
            continue;
        }

        parsed.add(mapped);
    }

    return { parsed: Array.from(parsed), invalid };
}

/**
 * Handles slash command interactions and dispatches command-specific workflows.
 */
export async function handleChatInputCommand(
    interaction: ChatInputCommandInteraction,
    deps: InteractionDeps
): Promise<void> {
    if (interaction.commandName === "help") {
        const helpText = [
            "**Rust Drop Notifications - Commands**",
            "`/setchannel channel:<#channel>` - Set where reminders are posted.",
            `\`/${CLOSING_PHRASE_COMMAND} state:<on|off>\` - Toggle the closing phrase in announcements.`,
            "`/alerts enable types:<24h 12h 1h checkdrops|all>` - Enable one or more alerts.",
            "`/alerts disable types:<24h 12h 1h checkdrops|all>` - Disable one or more alerts.",
            "`/alerts status` - Show your current alert settings.",
            "`/gifs mode mode:<default|custom|both>` - Set GIF source mode.",
            "`/gifs add url:<tenor_view_url>` - Add a GIF to your custom list.",
            "`/gifs remove id:<gif_id>` - Remove one of your custom GIFs.",
            "`/gifs rename id:<gif_id> name:<new_name>` - Rename one of your custom GIFs.",
            "`/gifs list page:<n>` - List your custom GIF entries with previews.",
            "`/gifs status` - Show current mode and list counts.",
            "`/checkdrops` - Run an immediate drops check.",
            "`/help` - Show this help message."
        ].join("\n");

        await interaction.reply({ content: helpText, flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.commandName === "setchannel") {
        const channel = interaction.options.getChannel("channel", true);
        deps.db.setSetting("reminder_channel_id", channel.id);
        await interaction.reply({
            content: `Reminder channel set to <#${channel.id}>.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (isClosingPhraseCommandName(interaction.commandName)) {
        const state = interaction.options.getString("state", true);
        const enabled = state === "on";
        deps.db.setBlahBlahIdkLmaoEnabled(enabled);

        await interaction.reply({
            content: `Closing phrase is now ${enabled ? "on" : "off"}.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (interaction.commandName === "alerts") {
        const sub = interaction.options.getSubcommand();

        if (sub === "enable") {
            const typesInput = interaction.options.getString("types");
            const parsed = parseAlertTypesInput(typesInput);

            if (parsed.invalid.length > 0 || parsed.parsed.length === 0) {
                await interaction.reply({
                    content:
                        "Unrecognized alert types. Use one or more of: `24h 12h 1h checkdrops` or `all`.",
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            deps.db.setAlertsEnabled(interaction.user.id, parsed.parsed, true);

            const labels = parsed.parsed.map((type) => formatAnyAlertTypeLabel(type)).join(", ");
            await interaction.reply({
                content: `Enabled alerts: ${labels}.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (sub === "disable") {
            const typesInput = interaction.options.getString("types");
            const parsed = parseAlertTypesInput(typesInput);

            if (parsed.invalid.length > 0 || parsed.parsed.length === 0) {
                await interaction.reply({
                    content:
                        "Unrecognized alert types. Use one or more of: `24h 12h 1h checkdrops` or `all`.",
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            deps.db.setAlertsEnabled(interaction.user.id, parsed.parsed, false);

            const labels = parsed.parsed.map((type) => formatAnyAlertTypeLabel(type)).join(", ");
            await interaction.reply({
                content: `Disabled alerts: ${labels}.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (sub === "status") {
            const settings = deps.db.getUserAlertSettings(interaction.user.id);
            const sourceModeLines = deps.providers.map((provider) => {
                const status = provider.getSourceStatus?.() ?? "status unavailable";
                const label = String(provider.platform).toLowerCase() === "twitch" ? "Twitch" : "Kick";
                return `${label} source: ${status}`;
            });
            await interaction.reply({
                content: [
                    `Auto-pings: ${settings.autoPing ? "**enabled**" : "**disabled**"}`,
                    `24h morning (6:00 AM AEST): ${settings.alert24h6am ? "on" : "off"}`,
                    `12h evening (6:00 PM AEST): ${settings.alert12h6pm ? "on" : "off"}`,
                    `1h before start: ${settings.alert1h ? "on" : "off"}`,
                    `Checkdrops manual ping: ${settings.alertCheckdrops ? "on" : "off"}`,
                    "",
                    "**Channel Confidence Legend**",
                    "verified: active drop with concrete channel list",
                    "discovered: upcoming drop with discovered channel list",
                    "unknown: channels not published/discoverable yet",
                    "",
                    "**Provider Source Modes**",
                    ...sourceModeLines
                ].join("\n"),
                flags: MessageFlags.Ephemeral
            });
            return;
        }
    }

    if (interaction.commandName === "gifs") {
        const sub = interaction.options.getSubcommand();

        if (sub === "mode") {
            const mode = interaction.options.getString("mode", true) as GifMode;
            deps.db.setGifMode(mode);
            await interaction.reply({
                content: `GIF mode set to **${getGifModeLabel(mode)}**.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (sub === "status") {
            const mode = deps.db.getGifMode();
            const yourCustomCount = deps.db.listCustomGifs(interaction.user.id).length;
            const sharedCustomCount = deps.db.listAllCustomGifViewUrls().length;

            await interaction.reply({
                content: [
                    "**GIF Status**",
                    `Mode: **${getGifModeLabel(mode)}**`,
                    `Your custom GIFs: ${yourCustomCount}`,
                    `Shared custom GIF pool: ${sharedCustomCount}`,
                    "Note: custom and both modes use the same shared custom pool."
                ].join("\n"),
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (sub === "add") {
            const rawUrl = interaction.options.getString("url", true);
            const normalizedUrl = normalizeTenorViewUrl(rawUrl);

            if (!isValidTenorViewUrl(normalizedUrl)) {
                await interaction.reply({
                    content: "Please provide a valid Tenor view URL (https://tenor.com/view/...).",
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (
                normalizeTenorViewUrlForCompare(normalizedUrl) ===
                normalizeTenorViewUrlForCompare(RARE_BEE_GIF_VIEW_URL)
            ) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const noCheatingGif = await buildNoCheatingGifAttachment();
                const secretResult = deps.db.markSecretFound(interaction.user.id, "no_cheating");
                const secretLines = secretResult.isNew
                    ? buildSecretFooterLines(secretResult.foundCount)
                    : [];
                const antiCheatLines = ["**NO CHEATING!!!**", ...secretLines];

                await interaction.editReply({
                    content: noCheatingGif ? "**NO CHEATING!!!**" : antiCheatLines.join("\n"),
                    embeds: noCheatingGif
                        ? [buildGifWithSecretFooterEmbed("no-cheating.gif", secretLines)]
                        : [],
                    files: noCheatingGif ? [noCheatingGif] : [],
                });
                return;
            }

            const added = deps.db.addCustomGif(interaction.user.id, normalizedUrl);
            await interaction.reply({
                content: added
                    ? "Added to your custom GIF list."
                    : "That GIF is already in your custom list.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (sub === "remove") {
            const id = interaction.options.getInteger("id", true);
            const removed = deps.db.removeCustomGif(interaction.user.id, id);
            await interaction.reply({
                content: removed
                    ? `Removed custom GIF #${id}.`
                    : `Custom GIF #${id} was not found in your list.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (sub === "rename") {
            const id = interaction.options.getInteger("id", true);
            const rawName = interaction.options.getString("name", true).trim();
            const isEscapedKeyword = rawName.startsWith("!");
            const keywordOrName = isEscapedKeyword ? rawName.slice(1).trim() : rawName;
            const lowerKeywordOrName = keywordOrName.toLowerCase();

            // Secret keyword commands must not rename any GIF and should work even with id 0 / no GIFs.
            if (!isEscapedKeyword && lowerKeywordOrName === "reset secrets") {
                await interaction.reply({
                    content: "**Reset your secrets tally?** This only affects your account.",
                    components: [buildResetSecretsButtons(interaction.user.id)],
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (!isEscapedKeyword && lowerKeywordOrName === "bee") {
                const session = startBeeQuiz(interaction.user.id);
                await sendBeeQuizQuestion(interaction, interaction.user.id, session);
                return;
            }

            const name = keywordOrName;
            const exists = deps.db.listCustomGifs(interaction.user.id).some((gif) => gif.id === id);

            if (!exists) {
                await interaction.reply({
                    content: `Custom GIF #${id} was not found in your list.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            const renamed = deps.db.renameCustomGif(interaction.user.id, id, name);

            await interaction.reply({
                content: renamed
                    ? `Renamed custom GIF **#${id}** to **${name}**.`
                    : `Custom GIF #${id} was not found in your list.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (sub === "list") {
            const gifs = deps.db.listCustomGifs(interaction.user.id);
            if (gifs.length === 0) {
                await interaction.reply({
                    content: "Your custom GIF list is empty.",
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            const requestedPage = interaction.options.getInteger("page") ?? 1;
            const totalPages = Math.max(1, Math.ceil(gifs.length / GIF_LIST_PAGE_SIZE));
            const page = Math.min(Math.max(requestedPage, 1), totalPages);
            const start = (page - 1) * GIF_LIST_PAGE_SIZE;
            const pageItems = gifs.slice(start, start + GIF_LIST_PAGE_SIZE);

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const previewResults = await Promise.all(
                pageItems.map((gif) =>
                    buildGifAttachmentFromViewUrl(gif.viewUrl, `custom-gif-${gif.id}.gif`)
                )
            );
            const previews = previewResults.filter((attachment) => attachment !== undefined);

            const lines = pageItems.map(
                (gif) => `**#${gif.id}** - ${gif.displayName ?? "Custom GIF"} (${gif.createdAt})`
            );
            await interaction.editReply({
                content: [
                    `**Your custom GIFs** (page ${page}/${totalPages}):`,
                    ...lines,
                    `Preview attachments: ${previews.length}/${pageItems.length}`,
                    "Use /gifs remove id:<gif_id> to delete one."
                ].join("\n"),
                files: previews
            });
            return;
        }
    }

    if (interaction.commandName === "checkdrops") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const checkdropsMode =
            interaction.options.getString("mode") === "full" ? "full" : "verified";

        await runDropsCycle({
            client: deps.client,
            db: deps.db,
            providers: deps.providers,
            intervalMs: 0,
            envChannelId: deps.envChannelId
        }, {
            forceAnnounce: true,
            forceAnnounceMode: checkdropsMode
        });

        const activeDrops = deps.db.getActiveDrops();
        const replyDrops =
            checkdropsMode === "full"
                ? activeDrops
                : activeDrops.filter((drop) => drop.channels.length > 0);
        const canRollRareBee = deps.db.getGifMode() === "default";
        const gotRareBee = canRollRareBee && Math.random() < RARE_BEE_GIF_CHANCE;

        if (!gotRareBee || replyDrops.length === 0) {
            await interaction.editReply("Drops check completed and posted to the reminder channel.");
            return;
        }

        const targetDrop = replyDrops[0];
        const resolvedChannels =
            targetDrop.channels.length > 0
                ? targetDrop.channels.join(", ")
                : getAnnouncementChannelsSummary(String(targetDrop.platform));
        const channelConfidence = targetDrop.channels.length > 0 ? "verified" : "unknown";
        const autoPingUsers = deps.db.getUserIdsForAlert("alert_checkdrops");
        const mentionText =
            autoPingUsers.length > 0
                ? Array.from(new Set(autoPingUsers.map((userId) => `<@${userId}>`))).join(" ")
                : "No opted-in users to ping yet. Use `/alerts enable types:checkdrops` to opt in.";

        const rareBeeGif = await buildGifAttachmentFromViewUrl(RARE_BEE_GIF_VIEW_URL, "rare-bee.gif");
        const secretResult = deps.db.markSecretFound(interaction.user.id, "rare_bee");
        const secretLines = secretResult.isNew ? buildSecretFooterLines(secretResult.foundCount) : [];

        await interaction.editReply({
            content: [
                "**Rust drop update**",
                `Platform: **${targetDrop.platform}**`,
                `Campaign: **${targetDrop.title}**`,
                `Channels: ${resolvedChannels || "none"}`,
                ...(targetDrop.channels.length > 0 ? [`Channel confidence: ${channelConfidence}`] : []),
                `Ends: <t:${Math.floor(new Date(targetDrop.endTime).getTime() / 1000)}:R>`,
                `Auto-ping: ${mentionText}`,
                ...(deps.db.isBlahBlahIdkLmaoEnabled() ? ["blah blah idk lmao"] : [])
            ].join("\n"),
            embeds: rareBeeGif ? [buildGifWithSecretFooterEmbed("rare-bee.gif", secretLines)] : [],
            files: rareBeeGif ? [rareBeeGif] : []
        });
    }
}

/**
 * Handles button interactions for secret reset and spelling quiz flows.
 */
export async function handleButtonInteraction(
    interaction: ButtonInteraction,
    deps: Pick<InteractionDeps, "db">
): Promise<void> {
    if (
        interaction.customId.startsWith(`${RESET_SECRETS_YES_BUTTON_PREFIX}:`) ||
        interaction.customId.startsWith(`${RESET_SECRETS_NO_BUTTON_PREFIX}:`)
    ) {
        const [prefix, ownerUserId] = interaction.customId.split(":");
        if (!ownerUserId || ownerUserId !== interaction.user.id) {
            await interaction.reply({
                content: "This confirmation belongs to someone else.",
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (prefix === RESET_SECRETS_NO_BUTTON_PREFIX) {
            await interaction.update({
                content: "Secrets reset cancelled.",
                components: []
            });
            setTimeout(() => {
                void interaction.deleteReply().catch(() => undefined);
            }, 1500);
            return;
        }

        deps.db.resetSecrets(ownerUserId);
        await interaction.update({
            content: "Secrets have been reset for your account.",
            components: []
        });
        setTimeout(() => {
            void interaction.deleteReply().catch(() => undefined);
        }, 2000);
        return;
    }

    if (!interaction.customId.startsWith(`${BEE_QUIZ_ANSWER_BUTTON_PREFIX}:`)) {
        return;
    }

    const ownerUserId = interaction.customId.split(":")[1];
    if (!ownerUserId || ownerUserId !== interaction.user.id) {
        await interaction.reply({
            content: "This quiz button belongs to someone else.",
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const session = getBeeQuizSession(ownerUserId);
    if (!session) {
        await interaction.reply({
            content: "That Spelling Bee quiz has expired.",
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const modal = buildBeeQuizModal(ownerUserId, session.index + 1);
    await interaction.showModal(modal);
}

/**
 * Handles modal submissions for spelling quiz answers.
 */
export async function handleModalSubmitInteraction(
    interaction: ModalSubmitInteraction,
    deps: Pick<InteractionDeps, "db">
): Promise<void> {
    if (!interaction.customId.startsWith(`${BEE_QUIZ_MODAL_PREFIX}:`)) {
        return;
    }

    const ownerUserId = interaction.customId.split(":")[1];
    if (!ownerUserId || ownerUserId !== interaction.user.id) {
        await interaction.reply({
            content: "This quiz submission is not for your session.",
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const session = getBeeQuizSession(ownerUserId);
    if (!session) {
        await interaction.reply({
            content: "That Spelling Bee quiz has expired.",
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const currentWord = session.words[session.index];
    const spelling = interaction.fields.getTextInputValue("spelling").trim();
    // Modal submissions must be acknowledged quickly; subsequent work can be slower.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const spellingCorrect = getAcceptedSpellings(currentWord.word).has(normalizeWord(spelling));

    if (!spellingCorrect) {
        clearBeeQuiz(ownerUserId);
        await interaction.editReply({
            content: [
                "**Spelling Bee quiz failed.**",
                `Correct word: **${currentWord.word}**`,
                "Spelling check: incorrect."
            ].join("\n")
        });
        return;
    }

    session.index += 1;

    if (session.index >= session.words.length) {
        clearBeeQuiz(ownerUserId);
        const rewardGif = await buildGifAttachmentFromViewUrl(BEE_FACE_REVEAL_GIF_VIEW_URL, "bee-face-reveal.gif");
        const secretResult = deps.db.markSecretFound(ownerUserId, "spelling_bee");
        const secretLines = secretResult.isNew ? buildSecretFooterLines(secretResult.foundCount) : [];

        await interaction.editReply({
            content: rewardGif ? "**Bee Face Reveal**" : ["**Bee Face Reveal**", ...secretLines].join("\n"),
            embeds: rewardGif
                ? [buildGifWithSecretFooterEmbed("bee-face-reveal.gif", secretLines)]
                : [],
            files: rewardGif ? [rewardGif] : []
        });
        return;
    }

    await interaction.editReply("**Correct!** Next word coming up...");

    await sendBeeQuizQuestion(interaction, ownerUserId, session);
}
