/**
 * OrderFilled event decoder for Polymarket CTF Exchange contracts
 * Phase 3: Polygon Logs
 * 
 * The OrderFilled event is emitted when an order is filled on the CTF Exchange
 * or NegRisk CTF Exchange contracts on Polygon.
 */

import { ethers } from 'ethers';

/**
 * OrderFilled event signature
 * event OrderFilled(
 *   bytes32 indexed orderHash,
 *   address indexed maker,
 *   address indexed taker,
 *   uint256 makerAssetId,
 *   uint256 takerAssetId,
 *   uint256 makerAmountFilled,
 *   uint256 takerAmountFilled,
 *   uint256 fee
 * )
 */
export const ORDER_FILLED_TOPIC = ethers.id(
    'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
);

/**
 * ABI for decoding OrderFilled event data
 */
const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

const orderFilledInterface = new ethers.Interface(ORDER_FILLED_ABI);

/**
 * USDC asset ID (0 = USDC in CTF Exchange)
 */
export const USDC_ASSET_ID = 0n;

/**
 * Decimals for USDC (6 decimals)
 */
export const USDC_DECIMALS = 6;

/**
 * Decimals for CTF tokens (6 decimals to match USDC)
 */
export const CTF_TOKEN_DECIMALS = 6;

/**
 * Decoded OrderFilled event
 */
export interface DecodedOrderFilled {
    // From indexed topics
    orderHash: string;
    maker: string;
    taker: string;

    // From data
    makerAssetId: bigint;
    takerAssetId: bigint;
    makerAmountFilled: bigint;
    takerAmountFilled: bigint;
    fee: bigint;

    // Log metadata
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
    exchangeAddress: string;
}

/**
 * Derived fill information
 */
export interface DerivedFillInfo {
    // Trade direction from leader's perspective
    side: 'BUY' | 'SELL';

    // The non-USDC token being traded
    tokenId: string;

    // Amounts
    usdcAmount: number;    // USDC in human-readable (6 decimals)
    tokenAmount: number;   // Token amount in human-readable (6 decimals)

    // Price (USDC per token)
    price: number;

    // Fee
    feeUsdc: number;

    // Leader role
    leaderRole: 'maker' | 'taker';
    leaderAddress: string;
}

/**
 * Decode an OrderFilled log
 */
export function decodeOrderFilledLog(log: {
    topics: string[];
    data: string;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
    address: string;
}): DecodedOrderFilled | null {
    try {
        // Parse the log using ethers interface
        const parsed = orderFilledInterface.parseLog({
            topics: log.topics,
            data: log.data,
        });

        if (!parsed) return null;

        return {
            orderHash: parsed.args[0],
            maker: parsed.args[1],
            taker: parsed.args[2],
            makerAssetId: parsed.args[3],
            takerAssetId: parsed.args[4],
            makerAmountFilled: parsed.args[5],
            takerAmountFilled: parsed.args[6],
            fee: parsed.args[7],
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            exchangeAddress: log.address.toLowerCase(),
        };
    } catch (error) {
        return null;
    }
}

/**
 * Derive trade information from a decoded OrderFilled event
 * 
 * In CTF Exchange:
 * - If makerAssetId = 0 (USDC), maker is selling USDC to buy tokens (maker is BUYING tokens)
 * - If takerAssetId = 0 (USDC), taker is selling USDC to buy tokens (taker is BUYING tokens)
 * 
 * @param decoded The decoded OrderFilled event
 * @param leaderAddress The leader address we're tracking (lowercase)
 * @returns Derived fill info or null if leader is not in this trade
 */
export function deriveFillInfo(
    decoded: DecodedOrderFilled,
    leaderAddress: string
): DerivedFillInfo | null {
    const makerLower = decoded.maker.toLowerCase();
    const takerLower = decoded.taker.toLowerCase();
    const leaderLower = leaderAddress.toLowerCase();

    // Check if leader is maker or taker
    let leaderRole: 'maker' | 'taker';
    if (makerLower === leaderLower) {
        leaderRole = 'maker';
    } else if (takerLower === leaderLower) {
        leaderRole = 'taker';
    } else {
        // Leader is not in this trade
        return null;
    }

    const makerAssetId = decoded.makerAssetId;
    const takerAssetId = decoded.takerAssetId;
    const makerAmount = decoded.makerAmountFilled;
    const takerAmount = decoded.takerAmountFilled;

    let side: 'BUY' | 'SELL';
    let tokenId: string;
    let usdcAmount: bigint;
    let tokenAmount: bigint;

    // Determine side and amounts based on which asset is USDC
    if (makerAssetId === USDC_ASSET_ID) {
        // Maker is providing USDC, receiving tokens -> Maker is BUYING
        // Taker is providing tokens, receiving USDC -> Taker is SELLING
        tokenId = takerAssetId.toString();
        usdcAmount = makerAmount;
        tokenAmount = takerAmount;

        side = leaderRole === 'maker' ? 'BUY' : 'SELL';
    } else if (takerAssetId === USDC_ASSET_ID) {
        // Taker is providing USDC, receiving tokens -> Taker is BUYING
        // Maker is providing tokens, receiving USDC -> Maker is SELLING
        tokenId = makerAssetId.toString();
        usdcAmount = takerAmount;
        tokenAmount = makerAmount;

        side = leaderRole === 'maker' ? 'SELL' : 'BUY';
    } else {
        // Neither asset is USDC - this shouldn't happen in normal trading
        // Could be a token-to-token swap, skip it
        return null;
    }

    // Convert to human-readable amounts
    const usdcAmountDecimal = Number(usdcAmount) / Math.pow(10, USDC_DECIMALS);
    const tokenAmountDecimal = Number(tokenAmount) / Math.pow(10, CTF_TOKEN_DECIMALS);
    const feeUsdcDecimal = Number(decoded.fee) / Math.pow(10, USDC_DECIMALS);

    // Calculate price (USDC per token)
    const price = tokenAmountDecimal > 0 ? usdcAmountDecimal / tokenAmountDecimal : 0;

    return {
        side,
        tokenId,
        usdcAmount: usdcAmountDecimal,
        tokenAmount: tokenAmountDecimal,
        price,
        feeUsdc: feeUsdcDecimal,
        leaderRole,
        leaderAddress: leaderLower,
    };
}

/**
 * Generate a unique dedupe key for a log
 */
export function generateDedupeKey(decoded: DecodedOrderFilled): string {
    return `${decoded.exchangeAddress}|${decoded.blockNumber}|${decoded.transactionHash}|${decoded.logIndex}`;
}
