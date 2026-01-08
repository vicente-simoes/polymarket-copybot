/**
 * Stage 5+8: Trade ingestion and position tracking module
 */
export { ingestTrade, buildTradeDedupeKey, type IngestTradeInput, type IngestTradeResult } from './ingestTrade.js';
export { updateLeaderPosition, getLeaderPosition, getLeaderPositions, type PositionUpdateResult } from './leaderPosition.js';
export {
    updatePaperPosition,
    getPaperPosition,
    getAllPaperPositions,
    calculateProportionalSellSize
} from './paperPosition.js';

