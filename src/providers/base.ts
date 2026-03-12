import type { NormalizedDrop, Platform } from "../types.js";

/**
 * Provider interface implemented by each drops source adapter.
 */

export interface DropsProvider {
    readonly platform: Platform;
    fetchRustDrops(): Promise<NormalizedDrop[]>;
    getSourceStatus?(): string;
}
