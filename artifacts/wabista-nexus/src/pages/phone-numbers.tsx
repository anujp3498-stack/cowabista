import { useMemo, useState } from "react"
import { MoreHorizontal, Phone, Plus, Trash2 } from "lucide-react"
import { useListPhoneNumbers, type PhoneNumber } from "@workspace/api-client-react"
import {
  EmptyState,
  ErrorState,
  PageHeader,
  StatusChip,
  TableRowsSkeleton,
  TechnicalDetails,
} from "@/components/app"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ConnectNumberDialog } from "@/components/numbers/connect-number-dialog"
import { RemoveNumberDialog } from "@/components/numbers/remove-number-dialog"
import { useActiveOrganization } from "@/hooks/use-active-organization"

// Number Center (V2-02A foundation).
//
// Everything shown is read from the server: status, quality and the
// throughput cap are owned by Meta sync / the engine and are never editable
// here. Sample rows are hidden. Raw provider IDs live under Technical
// details only. "Ready to send" is derived strictly from the engine-facing
// status; a freshly discovered number is shown as discovered, never ready.

function isReadyToSend(row: PhoneNumber): boolean {
  return row.status === "Connected" && !row.isSample
}

function readinessLabel(row: PhoneNumber): string {
  if (isReadyToSend(row)) return "Ready to send"
  if (row.setupState === "discovered") return "Discovered, needs verification"
  if (row.status === "Flagged") return "Needs attention"
  return "Setup incomplete"
}

export default function PhoneNumbers() {
  const { organizationId, role } = useActiveOrganization()
  // The API only lets owners and admins connect credentials; mirror that so
  // managers and agents are not offered a button that would be refused.
  const canConnect = role === "owner" || role === "admin"
  const numbers = useListPhoneNumbers()
  const [connectOpen, setConnectOpen] = useState(false)
  const [removing, setRemoving] = useState<PhoneNumber | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  const rows = useMemo(() => (numbers.data ?? []).filter((row) => !row.isSample), [numbers.data])
  const readyCount = rows.filter(isReadyToSend).length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Numbers"
        description="WhatsApp numbers connected to this workspace."
        primaryAction={
          <Button
            className="gap-2"
            onClick={() => setConnectOpen(true)}
            disabled={!canConnect}
            title={canConnect ? undefined : "Only workspace owners and admins can connect numbers."}
            data-testid="button-connect-number"
          >
            <Plus className="h-4 w-4" />
            Connect number
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected numbers</CardTitle>
          <CardDescription>
            {numbers.isSuccess
              ? rows.length === 0
                ? "No numbers yet."
                : `${rows.length} ${rows.length === 1 ? "number" : "numbers"}, ${readyCount} ready to send.`
              : "Loading…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {numbers.isLoading ? (
            <Table>
              <TableBody>
                <TableRowsSkeleton rows={3} columns={4} />
              </TableBody>
            </Table>
          ) : numbers.isError ? (
            <ErrorState
              title="Couldn't load numbers."
              error={numbers.error}
              onRetry={() => void numbers.refetch()}
              data-testid="error-phone-numbers"
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Phone}
              title="Connect your first WhatsApp number."
              description={
                canConnect
                  ? "Campaigns send from numbers in this workspace. Connect one to get started."
                  : "Campaigns send from numbers in this workspace. Ask a workspace owner or admin to connect one."
              }
              primaryAction={
                <Button onClick={() => setConnectOpen(true)} disabled={!canConnect} data-testid="button-connect-number-empty">
                  Connect number
                </Button>
              }
              data-testid="empty-phone-numbers"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Quality</TableHead>
                  <TableHead className="hidden lg:table-cell">Business account</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const isExpanded = expanded === row.id
                  return [
                    <TableRow key={row.id} data-testid={`row-phone-number-${row.id}`}>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left"
                          onClick={() => setExpanded(isExpanded ? null : row.id)}
                          aria-expanded={isExpanded}
                          data-testid={`button-expand-number-${row.id}`}
                        >
                          <div className="text-sm font-medium">{row.displayName}</div>
                          <div className="font-mono text-xs text-muted-foreground">{row.phone}</div>
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusChip kind="phoneNumber" value={row.status} data-testid={`chip-number-status-${row.id}`} />
                          {row.setupState && row.setupState !== "unknown" ? (
                            <StatusChip kind="phoneSetup" value={row.setupState} data-testid={`chip-number-setup-${row.id}`} />
                          ) : null}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground" data-testid={`text-number-readiness-${row.id}`}>
                          {readinessLabel(row)}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <StatusChip kind="phoneQuality" value={row.quality} />
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                        {row.wabaDisplayName ?? row.wabaExternalId ?? "—"}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${row.displayName}`} data-testid={`button-number-actions-${row.id}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setExpanded(isExpanded ? null : row.id)}>
                              {isExpanded ? "Hide details" : "Show details"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setRemoving(row)}
                              data-testid={`button-remove-number-${row.id}`}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Remove from Wabista
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>,
                    isExpanded ? (
                      <TableRow key={`${row.id}-details`} className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={5}>
                          {/* No "Connected via" fact: a credentialId only says a
                              workspace credential discovered this number. Campaign
                              sending does not use it yet (that is V2-02C), so
                              claiming a transport source here would be false. */}
                          <div className="grid gap-3 py-1 sm:grid-cols-2">
                            <Fact label="Ready to send" value={isReadyToSend(row) ? "Yes" : "Not yet"} />
                            <Fact label="Last checked" value={row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString() : "Never"} />
                          </div>
                          <TechnicalDetails
                            className="mt-3"
                            fields={[
                              { label: "Phone number ID", value: row.providerPhoneId, copyable: true },
                              { label: "WABA ID", value: row.wabaExternalId, copyable: true },
                              { label: "Credential associated", value: row.credentialId ? "Yes" : "No" },
                              { label: "Credential ID", value: row.credentialId },
                              { label: "Provider", value: row.provider },
                              { label: "Engine status", value: row.status },
                              { label: "Setup state", value: row.setupState ?? "unknown" },
                              { label: "Throughput cap (msgs/s)", value: row.tpsLimit },
                              { label: "Setup error", value: row.setupError },
                              { label: "Provider metadata", value: row.providerMetadata ?? {} },
                            ]}
                            data-testid={`technical-number-${row.id}`}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null,
                  ]
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConnectNumberDialog open={connectOpen} onOpenChange={setConnectOpen} organizationId={organizationId} />
      <RemoveNumberDialog phoneNumber={removing} onOpenChange={(open) => { if (!open) setRemoving(null) }} />
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  )
}
