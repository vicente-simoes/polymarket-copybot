'use client'

import { Menu, TrendingDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet'
import { Sidebar } from '@/components/sidebar'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'

export function MobileHeader() {
    return (
        <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 lg:hidden">
            <Sheet>
                <SheetTrigger asChild>
                    <Button variant="ghost" size="icon" className="lg:hidden">
                        <Menu className="h-5 w-5" />
                        <span className="sr-only">Toggle menu</span>
                    </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-72 p-0">
                    <VisuallyHidden>
                        <SheetTitle>Navigation Menu</SheetTitle>
                    </VisuallyHidden>
                    <Sidebar />
                </SheetContent>
            </Sheet>

            <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded bg-primary">
                    <TrendingDown className="size-4 text-primary-foreground" />
                </div>
                <span className="font-semibold">PolymarketSpy</span>
            </div>

            {/* Spacer for balance */}
            <div className="w-10" />
        </header>
    )
}
