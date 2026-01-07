/**
 * API endpoint for trigger mode control
 * GET /api/trigger-mode - Returns current mode
 * POST /api/trigger-mode - Update trigger mode
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@polymarket-bot/db';

const VALID_MODES = ['data_api', 'polygon', 'both'] as const;
type TriggerMode = typeof VALID_MODES[number];

export async function GET() {
    try {
        const config = await prisma.workerConfig.findUnique({
            where: { key: 'trigger_mode' },
        });

        const mode = config?.value || 'data_api';
        const updatedAt = config?.updatedAt || null;

        return NextResponse.json({
            mode,
            updatedAt: updatedAt?.toISOString() || null,
            availableModes: VALID_MODES,
        });
    } catch (error) {
        console.error('Error fetching trigger mode:', error);
        return NextResponse.json(
            { error: 'Failed to fetch trigger mode' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { mode } = body;

        // Validate mode
        if (!mode || !VALID_MODES.includes(mode)) {
            return NextResponse.json(
                { error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}` },
                { status: 400 }
            );
        }

        // Update config
        const config = await prisma.workerConfig.upsert({
            where: { key: 'trigger_mode' },
            create: { key: 'trigger_mode', value: mode },
            update: { value: mode },
        });

        return NextResponse.json({
            success: true,
            mode: config.value,
            updatedAt: config.updatedAt.toISOString(),
            message: `Trigger mode updated to '${mode}'. Worker will pick up change on next poll cycle.`,
        });
    } catch (error) {
        console.error('Error updating trigger mode:', error);
        return NextResponse.json(
            { error: 'Failed to update trigger mode' },
            { status: 500 }
        );
    }
}
