import { prisma } from '@polymarket-bot/db'
import { PageLayout, StatCard } from '@/components/page-layout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { LayoutDashboard, Users, TrendingUp, FileText, Activity, Clock } from 'lucide-react'

export const dynamic = 'force-dynamic'

async function getStats() {
  const [leaderCount, tradeCount, paperIntentCount] = await Promise.all([
    prisma.leader.count({ where: { enabled: true } }),
    prisma.trade.count(),
    prisma.paperIntent.count(),
  ])

  return { leaderCount, tradeCount, paperIntentCount }
}

async function checkDbConnection() {
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

export default async function DashboardPage() {
  const isConnected = await checkDbConnection()
  const stats = await getStats()

  return (
    <PageLayout
      title="Dashboard Overview"
      description="Welcome to your copy trading control center"
      icon={LayoutDashboard}
    >
      {/* Status Badge */}
      <div>
        <Badge variant={isConnected ? "success" : "destructive"}>
          <span className="size-2 rounded-full bg-current mr-2" />
          Database: {isConnected ? 'Connected' : 'Not Connected'}
        </Badge>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label="Active Leaders"
          value={stats.leaderCount}
          description="Monitored for trades"
          icon={Users}
        />
        <StatCard
          label="Total Trades"
          value={stats.tradeCount}
          description="Ingested from API"
          icon={TrendingUp}
        />
        <StatCard
          label="Paper Intents"
          value={stats.paperIntentCount}
          description="Simulated decisions"
          icon={FileText}
        />
      </div>

      {/* System Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" />
            System Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                Worker Status
              </div>
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-success" />
                <span className="font-medium">Running</span>
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                Last Update
              </div>
              <div className="flex items-center gap-2">
                <Clock className="size-4 text-muted-foreground" />
                <span className="font-mono text-sm">{new Date().toLocaleTimeString()}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </PageLayout>
  )
}
