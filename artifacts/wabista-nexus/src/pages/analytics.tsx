import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { BarChart3, TrendingUp, TrendingDown, Send, Radio } from "lucide-react"
import { useGetAnalyticsSummary, useGetDeliveryTrends, useGetRouteHealth } from "@workspace/api-client-react"
import { formatNumber } from "@/lib/utils"
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  BarChart,
  Bar,
} from "recharts"

function formatDateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
}

export default function Analytics() {
  const { data: summary, isLoading: summaryLoading } = useGetAnalyticsSummary()
  const { data: trends, isLoading: trendsLoading } = useGetDeliveryTrends({ days: 30 })
  const { data: routeHealth, isLoading: routeHealthLoading } = useGetRouteHealth()

  const trendData = (trends?.days ?? []).map((day) => ({ ...day, label: formatDateLabel(day.date) }))
  const routes = routeHealth?.routes ?? []
  const hasVolume = (summary?.totalSent ?? 0) > 0

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground">Deep dive into campaign performance and routing health.</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Messages Sent</CardTitle>
            <Send className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-analytics-total-sent">
              {summaryLoading ? "…" : formatNumber(summary?.totalSent ?? 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Across this workspace</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Delivery Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-analytics-delivery-rate">
              {summaryLoading ? "…" : `${summary?.deliveryRate ?? 0}%`}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Delivered / sent</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Read Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-analytics-read-rate">
              {summaryLoading ? "…" : `${summary?.readRate ?? 0}%`}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Read / sent</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failure Rate</CardTitle>
            <TrendingDown className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-analytics-failure-rate">
              {summaryLoading ? "…" : `${summary?.failureRate ?? 0}%`}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Across {summaryLoading ? "…" : summary?.activeRoutes ?? 0} active routes
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="min-h-[400px] flex flex-col">
          <CardHeader>
            <CardTitle>Delivery Trends (30 Days)</CardTitle>
            <CardDescription>Sent vs Delivered vs Read vs Failed</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 border-t pt-4">
            {trendsLoading ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
            ) : !hasVolume ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-2">
                <BarChart3 className="h-10 w-10 opacity-20" />
                <p className="text-sm font-medium">No message activity yet</p>
                <p className="text-xs">Trends will appear once campaigns start sending.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={trendData} data-testid="chart-delivery-trends">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="label" fontSize={12} tickLine={false} />
                  <YAxis fontSize={12} tickLine={false} allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="sent" name="Sent" stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="delivered" name="Delivered" stroke="#10b981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="read" name="Read" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="failed" name="Failed" stroke="#ef4444" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="min-h-[400px] flex flex-col">
          <CardHeader>
            <CardTitle>Route Health Breakdown</CardTitle>
            <CardDescription>Failure rates across connected WhatsApp numbers</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 border-t pt-4">
            {routeHealthLoading ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
            ) : routes.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-2">
                <Radio className="h-10 w-10 opacity-20" />
                <p className="text-sm font-medium">No route activity yet</p>
                <p className="text-xs">Connect a number and send a campaign to see route health.</p>
              </div>
            ) : (
              <div className="space-y-4">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={routes} data-testid="chart-route-health">
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="displayName" fontSize={12} tickLine={false} />
                    <YAxis fontSize={12} tickLine={false} unit="%" allowDecimals={false} />
                    <Tooltip formatter={(value: number) => `${value}%`} />
                    <Bar dataKey="failureRate" name="Failure Rate" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="space-y-2 max-h-[110px] overflow-y-auto">
                  {routes.map((route) => (
                    <div key={route.phoneNumberId} className="flex items-center justify-between text-xs border-b pb-2 last:border-0">
                      <div>
                        <p className="font-medium">{route.displayName}</p>
                        <p className="text-muted-foreground font-mono">{route.phone}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono">{formatNumber(route.sent)} sent · {formatNumber(route.failed)} failed</p>
                        {route.topErrorReasons[0] && (
                          <p className="text-muted-foreground">{route.topErrorReasons[0].reason}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
