/**
 * Worker configuration - centralized env var loading
 * Phase 0: Feature flags for Polygon logs upgrade
 */

// Trigger mode: how we detect leader fills
export type TriggerMode = 'data_api' | 'polygon' | 'both';

// Execution mode: paper simulation or live trading
export type ExecutionMode = 'paper' | 'live';

// Book store mode: how we get market data
export type BookStoreMode = 'rest' | 'ws' | 'ws+snapshot';

/**
 * Configuration object loaded from environment variables
 */
export interface WorkerConfig {
    // Feature flags
    triggerMode: TriggerMode;
    executionMode: ExecutionMode;
    bookStoreMode: BookStoreMode;

    // Polling intervals
    pollIntervalMs: number;
    leaderStaggerMs: number;
    healthLogIntervalMs: number;
    pnlSnapshotIntervalMs: number;

    // Leader fetch settings
    leaderFetchLimit: number;

    // Polygon blockchain settings
    polygonWsUrl: string;
    polygonHttpUrl: string;
    polyExchangeCtf: string;
    polyExchangeNegRisk: string;

    // CLOB market data settings
    clobMarketWsUrl: string;
    clobHttpUrl: string;

    // Database URL
    databaseUrl: string;

    // Registry sync settings (Phase 2)
    registrySyncOnStartup: boolean;
    registrySyncIntervalMs: number;  // 0 = disabled
    gammaApiUrl: string;
}

/**
 * Parse and validate configuration from environment variables
 */
function parseConfig(): WorkerConfig {
    // Parse trigger mode
    const triggerModeRaw = process.env.TRIGGER_MODE || 'data_api';
    if (!['data_api', 'polygon', 'both'].includes(triggerModeRaw)) {
        throw new Error(`Invalid TRIGGER_MODE: ${triggerModeRaw}. Must be 'data_api', 'polygon', or 'both'`);
    }
    const triggerMode = triggerModeRaw as TriggerMode;

    // Parse execution mode
    const executionModeRaw = process.env.EXECUTION_MODE || 'paper';
    if (!['paper', 'live'].includes(executionModeRaw)) {
        throw new Error(`Invalid EXECUTION_MODE: ${executionModeRaw}. Must be 'paper' or 'live'`);
    }
    const executionMode = executionModeRaw as ExecutionMode;

    // Parse book store mode
    const bookStoreModeRaw = process.env.BOOKSTORE_MODE || 'rest';
    if (!['rest', 'ws', 'ws+snapshot'].includes(bookStoreModeRaw)) {
        throw new Error(`Invalid BOOKSTORE_MODE: ${bookStoreModeRaw}. Must be 'rest', 'ws', or 'ws+snapshot'`);
    }
    const bookStoreMode = bookStoreModeRaw as BookStoreMode;

    return {
        // Feature flags
        triggerMode,
        executionMode,
        bookStoreMode,

        // Polling intervals
        pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
        leaderStaggerMs: parseInt(process.env.LEADER_STAGGER_MS || '500', 10),
        healthLogIntervalMs: parseInt(process.env.HEALTH_LOG_INTERVAL || '60000', 10),
        pnlSnapshotIntervalMs: parseInt(process.env.PNL_SNAPSHOT_INTERVAL || '3600000', 10),

        // Leader fetch settings
        leaderFetchLimit: parseInt(process.env.LEADER_FETCH_LIMIT || '50', 10),

        // Polygon blockchain settings
        polygonWsUrl: process.env.POLYGON_WS_URL || 'wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY',
        polygonHttpUrl: process.env.POLYGON_HTTP_URL || 'https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY',
        polyExchangeCtf: process.env.POLY_EXCHANGE_CTF || '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
        polyExchangeNegRisk: process.env.POLY_EXCHANGE_NEGRISK || '0xC5d563A36AE78145C45a50134d48A1215220f80a',

        // CLOB market data settings
        clobMarketWsUrl: process.env.CLOB_MARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
        clobHttpUrl: process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com',

        // Database URL
        databaseUrl: process.env.DATABASE_URL || 'postgresql://polymarket:polymarket@localhost:5432/polymarket',

        // Registry sync settings (Phase 2)
        registrySyncOnStartup: process.env.REGISTRY_SYNC_ON_STARTUP !== 'false',  // default true
        registrySyncIntervalMs: parseInt(process.env.REGISTRY_SYNC_INTERVAL_MS || '1800000', 10),  // 30 min default
        gammaApiUrl: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    };
}

// Singleton config instance
let configInstance: WorkerConfig | null = null;

/**
 * Get the worker configuration (parsed once and cached)
 */
export function getConfig(): WorkerConfig {
    if (!configInstance) {
        configInstance = parseConfig();
    }
    return configInstance;
}

/**
 * Log configuration on startup (sensitive values masked)
 */
export function logConfig(logger: { info: (obj: object, msg: string) => void }): void {
    const config = getConfig();

    // Mask sensitive URLs
    const maskUrl = (url: string): string => {
        if (url.includes('YOUR_KEY')) return url;
        // Mask API keys in URLs
        return url.replace(/\/v2\/[^/]+/, '/v2/***');
    };

    logger.info({
        triggerMode: config.triggerMode,
        executionMode: config.executionMode,
        bookStoreMode: config.bookStoreMode,
        pollIntervalMs: config.pollIntervalMs,
        leaderStaggerMs: config.leaderStaggerMs,
        healthLogIntervalMs: config.healthLogIntervalMs,
        pnlSnapshotIntervalMs: config.pnlSnapshotIntervalMs,
        leaderFetchLimit: config.leaderFetchLimit,
        polygonWsUrl: maskUrl(config.polygonWsUrl),
        polygonHttpUrl: maskUrl(config.polygonHttpUrl),
        polyExchangeCtf: config.polyExchangeCtf,
        polyExchangeNegRisk: config.polyExchangeNegRisk,
        clobMarketWsUrl: config.clobMarketWsUrl,
        clobHttpUrl: config.clobHttpUrl,
        registrySyncOnStartup: config.registrySyncOnStartup,
        registrySyncIntervalMs: config.registrySyncIntervalMs,
        gammaApiUrl: config.gammaApiUrl,
    }, 'Worker configuration loaded');
}
