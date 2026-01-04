// Settings service - Centralized guardrails management
// Reads from database, supports caching, and applies operation-specific modifiers

import { prisma } from '@polymarket-bot/db';

// ============================================================================
// Types
// ============================================================================

export interface Settings {
    ratioDefault: number;
    maxUsdcPerTrade: number;
    maxUsdcPerDay: number;
    maxPriceMovePct: number;
    maxSpread: number;
    // Operation-specific modifiers
    sellMaxPriceMovePct: number;
    sellMaxSpread: number;
    sellAlwaysAttempt: boolean;
    splitMergeAlwaysFollow: boolean;
}

export type OperationType = 'BUY' | 'SELL' | 'SPLIT' | 'MERGE';

export interface EffectiveConfig extends Settings {
    leaderId: string;
    operationType: OperationType;
    // Effective values after applying operation-specific modifiers
    effectiveMaxPriceMovePct: number;
    effectiveMaxSpread: number;
    shouldSkipPriceCheck: boolean;
    isOverridden: {
        ratio: boolean;
        maxUsdcPerTrade: boolean;
        maxUsdcPerDay: boolean;
    };
}

// ============================================================================
// Settings Cache (10-second TTL to avoid DB hits per trade)
// ============================================================================

let cachedSettings: Settings | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 10000; // 10 seconds

function invalidateCache() {
    cachedSettings = null;
    cacheTime = 0;
}

// ============================================================================
// Get Global Settings
// ============================================================================

export async function getGlobalSettings(): Promise<Settings> {
    const now = Date.now();

    // Return cached if still valid
    if (cachedSettings && now - cacheTime < CACHE_TTL_MS) {
        return cachedSettings;
    }

    // Fetch from database
    let settings = await prisma.settings.findUnique({ where: { id: 1 } });

    // Create default settings if none exist
    if (!settings) {
        settings = await prisma.settings.create({
            data: { id: 1 }
        });
    }

    // Update cache
    cachedSettings = settings;
    cacheTime = now;

    return settings;
}

// ============================================================================
// Update Global Settings
// ============================================================================

export async function updateGlobalSettings(updates: Partial<Settings>): Promise<Settings> {
    const settings = await prisma.settings.upsert({
        where: { id: 1 },
        update: updates,
        create: { id: 1, ...updates }
    });

    // Invalidate and refresh cache
    cachedSettings = settings;
    cacheTime = Date.now();

    return settings;
}

// ============================================================================
// Get Effective Config (with leader overrides and operation-specific modifiers)
// ============================================================================

export async function getEffectiveConfig(
    leaderId: string,
    operationType: OperationType
): Promise<EffectiveConfig> {
    const global = await getGlobalSettings();
    const leader = await prisma.leader.findUnique({ where: { id: leaderId } });

    // Apply operation-specific modifiers
    let effectiveMaxPriceMovePct = global.maxPriceMovePct;
    let effectiveMaxSpread = global.maxSpread;
    let shouldSkipPriceCheck = false;

    if (operationType === 'SELL') {
        // SELL operations use more lenient thresholds
        effectiveMaxPriceMovePct = global.sellMaxPriceMovePct;
        effectiveMaxSpread = global.sellMaxSpread;
        shouldSkipPriceCheck = global.sellAlwaysAttempt;
    } else if (operationType === 'SPLIT' || operationType === 'MERGE') {
        // SPLIT/MERGE operations always follow if configured
        shouldSkipPriceCheck = global.splitMergeAlwaysFollow;
    }

    return {
        // Spread global settings
        ...global,

        // Metadata
        leaderId,
        operationType,

        // Apply leader overrides (null = use global)
        ratioDefault: leader?.ratio ?? global.ratioDefault,
        maxUsdcPerTrade: leader?.maxUsdcPerTrade ?? global.maxUsdcPerTrade,
        maxUsdcPerDay: leader?.maxUsdcPerDay ?? global.maxUsdcPerDay,

        // Operation-specific effective values
        effectiveMaxPriceMovePct,
        effectiveMaxSpread,
        shouldSkipPriceCheck,

        // Track what's overridden for debugging
        isOverridden: {
            ratio: leader?.ratio != null,
            maxUsdcPerTrade: leader?.maxUsdcPerTrade != null,
            maxUsdcPerDay: leader?.maxUsdcPerDay != null,
        }
    };
}

// ============================================================================
// Utility: Force Cache Refresh
// ============================================================================

export { invalidateCache as invalidateSettingsCache };
