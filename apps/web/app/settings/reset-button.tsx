'use client';

import { Button } from '@/components/ui/button';
import { useState } from 'react';

export function ResetButton() {
    const [isConfirming, setIsConfirming] = useState(false);

    const handleClick = () => {
        if (!isConfirming) {
            setIsConfirming(true);
            return;
        }
        // Submit the form
        const form = document.getElementById('reset-form') as HTMLFormElement;
        form?.submit();
    };

    const handleCancel = () => {
        setIsConfirming(false);
    };

    if (isConfirming) {
        return (
            <div className="flex items-center gap-2">
                <span className="text-sm text-destructive">Are you sure?</span>
                <Button type="button" variant="destructive" size="sm" onClick={handleClick}>
                    Yes, Reset
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleCancel}>
                    Cancel
                </Button>
            </div>
        );
    }

    return (
        <Button type="button" variant="destructive" onClick={handleClick}>
            Reset Paper State
        </Button>
    );
}
