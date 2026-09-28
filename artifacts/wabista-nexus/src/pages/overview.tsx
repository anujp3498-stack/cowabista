import { Link } from "wouter"
import { FileText, Phone, Plus, Send, Users } from "lucide-react"
import { useGetOverviewStats, useListCampaigns } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState, ErrorState, PageHeader, StatStripSkeleton, StatusChip } from "@/components/app"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber } from "@/lib/utils"

const RUNNING_PREVIEW_LIMIT = 3

// Home shows only what is real in this workspace: workspace-wide totals
// from the overview endpoint (sample rows excluded server-side), the
// campaigns that are actually in the Running state, and links to real
// destinations. There is no activity feed, no live speed and no alerts
// because none of those are measured yet.
export default function Overview() {
  const stats = useGetOverviewStats()
  const campaigns = useListCampaigns()

  const runningCampaigns = (campaigns.data ?? [])
    .filter((campaign) => campaign.status === "Running" && !campaign.isSample)
    .slice(0, RUNNING_PREVIEW_LIMIT)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Home"
        description="What is happening in this workspace."
        primaryAction={
          <Button asChild className="gap-2">
            <Link href="/campaigns" data-testid="link-home-campaigns">
              <Plus className="h-4 w-4" />
              New campaign
            </Link>
          </Button>
        }
      />

      <section aria-label="Quick actions" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QuickAction href="/campaigns" icon={Send} label="Campaigns" hint="Create and monitor sends" testId="quick-campaigns" />
        <QuickAction href="/phone-numbers" icon={Phone} label="Numbers" hint="Connect and manage numbers" testId="quick-numbers" />
        <QuickAction href="/templates" icon={FileText} label="Templates" hint="Approved message templates" testId="quick-templates" />
        <QuickAction href="/contacts" icon={Users} label="Contacts" hint="Your customer list" testId="quick-contacts" />
      </section>

      <section aria-label="Workspace summary">
        {stats.isLoading ? (
          <StatStripSkeleton count={4} />
        ) : stats.isError ? (
          <ErrorState
            title="Couldn't load workspace summary."
            error={stats.error}
            onRetry={() => void stats.refetch()}
            data-testid="error-overview-stats"
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Messages sent" value={formatNumber(stats.data?.messagesSent ?? 0)} hint="Across real campaigns" testId="text-stat-messages-sent" />
            <StatTile label="Delivery rate" value={`${stats.data?.deliveryRate ?? 0}%`} hint="Delivered as a share of sent" testId="text-stat-delivery-rate" />
            <StatTile label="Running campaigns" value={String(stats.data?.activeCampaigns ?? 0)} hint="Sending right now" testId="text-stat-active-campaigns" />
            <StatTile label="Connected numbers" value={String(stats.data?.connectedNumbers ?? 0)} hint="Ready to send" testId="text-stat-connected-numbers" />
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">Running campaigns</CardTitle>
              <CardDescription>Campaigns currently sending from this workspace.</CardDescription>
            </div>
            <Link href="/campaigns" className="text-sm font-medium text-primary hover:underline" data-testid="link-view-campaigns">
              View campaigns
            </Link>
          </CardHeader>
          <CardContent>
            {campaigns.isLoading ? (
              <div className="space-y-4" aria-busy="true">
                {Array.from({ length: 2 }).map((_, index) => (
                  <div key={index} className="space-y-2">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-2 w-full" />
                  </div>
                ))}
              </div>
            ) : campaigns.isError ? (
              <ErrorState
                title="Couldn't load campaigns."
                error={campaigns.error}
                onRetry={() => void campaigns.refetch()}
                data-testid="error-overview-campaigns"
              />
            ) : runningCampaigns.length === 0 ? (
              <EmptyState
                icon={Send}
                title="No campaigns are running."
                description="Create or open a campaign when you're ready to send."
                primaryAction={
                  <Button asChild variant="outline">
                    <Link href="/campaigns">View campaigns</Link>
                  </Button>
                }
                data-testid="empty-running-campaigns"
              />
            ) : (
              <ul className="space-y-4">
                {runningCampaigns.map((campaign) => {
                  const progress = campaign.audienceSize > 0 ? Math.min(100, (campaign.sent / campaign.audienceSize) * 100) : 0
                  return (
                    <li key={campaign.id} className="space-y-2 border-b pb-4 last:border-0 last:pb-0" data-testid={`row-running-campaign-${campaign.id}`}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-medium">{campaign.name}</p>
                        <StatusChip kind="campaign" value={campaign.status} />
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
                        <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
                      </div>
                      <p className="font-mono text-xs text-muted-foreground">
                        {formatNumber(campaign.sent)} / {formatNumber(campaign.audienceSize)} sent
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Getting started</CardTitle>
            <CardDescription>The usual order for a new workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 text-sm">
              <GettingStartedStep number={1} href="/phone-numbers" label="Connect a WhatsApp number" />
              <GettingStartedStep number={2} href="/templates" label="Sync your message templates" />
              <GettingStartedStep number={3} href="/contacts" label="Add or import contacts" />
              <GettingStartedStep number={4} href="/campaigns" label="Create a campaign" />
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function QuickAction({
  href,
  icon: Icon,
  label,
  hint,
  testId,
}: {
  href: string
  icon: typeof Send
  label: string
  hint: string
  testId: string
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="flex min-h-16 items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-muted"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-muted-foreground">{hint}</div>
      </div>
    </Link>
  )
}

function StatTile({ label, value, hint, testId }: { label: string; value: string; hint: string; testId: string }) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  )
}

function GettingStartedStep({ number, href, label }: { number: number; href: string; label: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">{number}</span>
      <Link href={href} className="text-foreground hover:underline">
        {label}
      </Link>
    </li>
  )
}
