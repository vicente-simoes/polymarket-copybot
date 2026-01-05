import * as React from "react"
import { cn } from "@/lib/utils"

function Card({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            className={cn(
                "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
                className
            )}
            {...props}
        />
    )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            className={cn("flex flex-col space-y-1.5 p-4 pb-2", className)}
            {...props}
        />
    )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            className={cn("text-sm font-medium text-muted-foreground uppercase tracking-wide", className)}
            {...props}
        />
    )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            className={cn("text-xs text-muted-foreground", className)}
            {...props}
        />
    )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div className={cn("p-4 pt-0", className)} {...props} />
    )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            className={cn("flex items-center p-4 pt-0", className)}
            {...props}
        />
    )
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
