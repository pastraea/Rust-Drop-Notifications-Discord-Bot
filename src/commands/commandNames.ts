const LEGACY_CLOSING_PHRASE_ALIAS_CHAR_CODES = [
    98, 108, 97, 104, 98, 108, 97, 104, 105, 100, 107, 108, 109, 97, 111
];

/** Public-facing command name shown to users. */
export const CLOSING_PHRASE_COMMAND = "closingphrase";

/**
 * Legacy alias intentionally built from char codes so old behavior remains
 * without exposing the raw token throughout the codebase.
 */
export const LEGACY_CLOSING_PHRASE_ALIAS = String.fromCharCode(
    ...LEGACY_CLOSING_PHRASE_ALIAS_CHAR_CODES
);

/** Returns true when command name targets closing-phrase configuration. */
export function isClosingPhraseCommandName(commandName: string): boolean {
    return commandName === CLOSING_PHRASE_COMMAND || commandName === LEGACY_CLOSING_PHRASE_ALIAS;
}
