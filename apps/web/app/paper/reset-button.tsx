'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'

export function ResetButton() {
    const [isConfirming, setIsConfirming] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const router = useRouter()

    async function handleReset() {
        setIsLoading(true)
        try {
            const res = await fetch('/api/reset', { method: 'POST' })
            const data = await res.json()

            if (data.success) {
                // Refresh the page to show empty state
                router.refresh()
                setIsConfirming(false)
            } else {
                alert('Failed to reset: ' + (data.error || 'Unknown error'))
            }
        } catch (error) {
            alert('Failed to reset: ' + (error instanceof Error ? error.message : 'Unknown error'))
        } finally {
            setIsLoading(false)
        }
    }

    if (isConfirming) {
        return (
            <div className="flex items-center gap-2">
                <span className="text-sm text-destructive font-medium">Delete all trading data?</span>
                <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleReset}
                    disabled={isLoading}
                >
                    {isLoading ? 'Resetting...' : 'Yes, Reset'}
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setIsConfirming(false)}
                    disabled={isLoading}
                >
                    Cancel
                </Button>
            </div>
        )
    }

    return (
        <Button
            variant="outline"
            size="sm"
            onClick={() => setIsConfirming(true)}
            className="text-destructive border-destructive hover:bg-destructive hover:text-destructive-foreground"
        >
            <Trash2 className="size-4 mr-2" />
            Reset All Data
        </Button>
    )
}
