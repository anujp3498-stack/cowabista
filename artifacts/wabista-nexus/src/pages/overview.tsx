import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useGetOverviewStats, useListCampaigns } from "@workspace/api-client-react"
import { activityFeed } from "@/lib/mock-data"
import { formatNumber } from "@/lib/utils"
import { Activity, ArrowRight, MessageSquare, Rocket, Send, Zap } from "lucide-react"
import { Link } from "wouter"

export default function Overview() {
  const { data: stats, isLoading: statsLoading } = useGetOverviewStats()
  const { data: campaigns } = useListCampaigns()
  const activeCampaigns = (campaigns ?? []).filter(c => c.status === "Running").slice(0, 3)

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground">Monitor your messaging infrastructure and campaign performance.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/rocket-campaigns" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 h-9 px-4 py-2 gap-2">
            <Zap className="h-4 w-4" />
            Launch Rocket Campaign
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Messages Sent</CardTitle>
            <Send className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-stat-messages-sent">
              {statsLoading ? "…" : formatNumber(stats?.messagesSent ?? 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Across this workspace</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Delivery Rate</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-stat-delivery-rate">
              {statsLoading ? "…" : `${stats?.deliveryRate ?? 0}%`}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Delivered / sent</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Campaigns</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-stat-active-campaigns">
              {statsLoading ? "…" : stats?.activeCampaigns ?? 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Across {statsLoading ? "…" : stats?.connectedNumbers ?? 0} connected numbers
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Current Throughput</CardTitle>
            <Zap className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-stat-tps">
              {statsLoading ? "…" : formatNumber(stats?.tpsOverall ?? 0)} <span className="text-sm font-normal text-muted-foreground">msg/s</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Configured TPS across active routes
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="lg:col-span-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Active Campaigns</CardTitle>
              <CardDescription>Top campaigns currently running through the engine.</CardDescription>
            </div>
            <Link href="/campaigns" className="text-sm text-primary hover:underline font-medium">View All</Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {activeCampaigns.length === 0 && (
                <p className="text-sm text-muted-foreground">No active campaigns yet.</p>
              )}
              {activeCampaigns.map(camp => (
                <div key={camp.id} className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0">
                  <div className="space-y-1">
                    <p className="text-sm font-medium leading-none">{camp.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{formatNumber(camp.sent)} / {formatNumber(camp.audienceSize)} sent</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="w-[100px] h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${camp.audienceSize > 0 ? (camp.sent / camp.audienceSize) * 100 : 0}%` }}
                      />
                    </div>
                    <Badge variant="success">Running</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Sample data — activity logging isn't wired up yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {activityFeed.map((act) => (
                <div key={act.id} className="flex items-start gap-4">
                  <div className="mt-0.5 w-2 h-2 rounded-full bg-primary shrink-0" />
                  <div className="space-y-1">
                    <p className="text-sm">
                      <span className="font-medium">{act.user}</span> {act.action} <span className="font-medium text-foreground">{act.target}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{act.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-slate-900 text-slate-50 border-slate-800 overflow-hidden relative">
        <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
          <Rocket className="w-48 h-48" />
        </div>
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <Badge className="bg-primary/20 text-primary hover:bg-primary/30 border-none">Rocket Engine</Badge>
            <span className="text-sm text-slate-400 font-mono tracking-tight">STATUS: DEMO PIPELINE</span>
          </div>
          <CardTitle className="text-2xl text-white">Multi-Route Campaign Execution</CardTitle>
          <CardDescription className="text-slate-400 max-w-xl">
            The Rocket Engine visualizes load-balancing campaigns across connected WABA routes.
            Route data below is real; dispatch and sending are a visual demonstration in this milestone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/rocket-campaigns" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors bg-white text-slate-900 hover:bg-slate-200 h-9 px-4 py-2 mt-4">
            View Engine Pipeline <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
