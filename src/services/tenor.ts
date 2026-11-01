/**
 * Small Tenor URL helpers shared by the command handlers and the reminder service.
 */

const TENOR_VIEW_URL_REGEX = /^https:\/\/tenor\.com\/view\/[a-z0-9-]+/i;

/** Normalizes Tenor view URLs and corrects malformed duplicated protocol prefixes. */
export function normalizeTenorViewUrl(url: string): string {
    return url.trim().replace(/^https:\/\/https:\/\//i, "https://");
}

/** Validates whether a URL matches the expected Tenor view URL shape. */
export function isValidTenorViewUrl(url: string): boolean {
    return TENOR_VIEW_URL_REGEX.test(url);
}

/** Decodes the HTML entity used in scraped Tenor metadata fields. */
export function decodeHtmlEntities(value: string): string {
    return value.replaceAll("&amp;", "&");
}
