import { cn } from '@/lib/utils'
import { LucideIcon } from 'lucide-react'

interface PageLayoutProps {
    children: React.ReactNode
    title: string
    description?: string
    icon?: LucideIcon
}

export function PageLayout({ children, title, description, icon: Icon }: PageLayoutProps) {
    return (
        <div className="flex flex-col min-h-full animate-fade-in">
            {/* Page Header */}
            <div className="sticky top-0 lg:top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                <div className="flex items-center gap-3 px-4 py-4 md:px-6 md:py-5">
                    {Icon && (
                        <div className="hidden md:flex size-9 items-center justify-center rounded-md bg-primary/10">
                            <Icon className="size-5 text-primary" />
                        </div>
                    )}
                    <div>
                        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
                            {title}
                        </h1>
                        {description && (
                            <p className="text-sm text-muted-foreground mt-0.5">
                                {description}
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Page Content */}
            <div className="flex-1 p-4 md:p-6 space-y-6">
                {children}
            </div>
        </div>
    )
}

// Stat Card component
interface StatCardProps {
    label: string
    value: string | number
    description?: string
    icon?: LucideIcon
    variant?: 'default' | 'success' | 'warning' | 'destructive'
}

export function StatCard({ label, value, description, icon: Icon, variant = 'default' }: StatCardProps) {
    const variantClasses = {
        default: 'text-foreground',
        success: 'text-success',
        warning: 'text-warning',
        destructive: 'text-destructive',
    }

    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {label}
                </span>
                {Icon && <Icon className="size-4 text-muted-foreground" />}
            </div>
            <div className={cn("text-2xl md:text-3xl font-bold mt-2 font-mono", variantClasses[variant])}>
                {value}
            </div>
            {description && (
                <p className="text-xs text-muted-foreground mt-1">
                    {description}
                </p>
            )}
        </div>
    )
}
