/**
 * Secret discovery metadata and formatting helpers.
 */
/** Total number of hidden easter eggs tracked by the bot. */
export const TOTAL_SECRETS = 3;

/** Valid keys representing each discoverable secret. */
export type SecretKey = "rare_bee" | "no_cheating" | "spelling_bee";

/**
 * Returns user-facing progress text for discovered secrets count.
 */
export function formatSecretsProgress(foundCount: number): string {
    return `Secrets found: ${foundCount}/${TOTAL_SECRETS}`;
}
