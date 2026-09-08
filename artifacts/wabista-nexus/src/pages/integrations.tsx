import { useState, useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListOrganizations,
  useGetWhatsAppIntegration,
  useUpdateWhatsAppIntegration,
  useGetWhatsAppHealth,
  useSyncWhatsAppResources,
  useListWhatsAppWabas,
  getGetWhatsAppIntegrationQueryKey,
  getGetWhatsAppHealthQueryKey,
  getListWhatsAppWabasQueryKey,
  getListPhoneNumbersQueryKey,
  getListTemplatesQueryKey,
  type WhatsAppProviderMode,
} from "@workspace/api-client-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { AlertCircle, CheckCircle2, RefreshCw, Save, ShieldAlert, Plug, Cable, Activity } from "lucide-react"

export default function Integrations() {
  const { data: organizations } = useListOrganizations()
  const activeOrg = organizations?.find((org) => org.isActive) ?? organizations?.[0]

  if (!activeOrg) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <p className="text-muted-foreground animate-pulse">Loading workspace context...</p>
      </div>
    )
  }

  return <IntegrationsContent orgId={activeOrg.id} orgRole={activeOrg.role} />
}

function IntegrationsContent({ orgId, orgRole }: { orgId: number, orgRole: string }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data: integration, isLoading: isIntLoading, error: intError } = useGetWhatsAppIntegration(orgId)
  const { data: health, isLoading: isHealthLoading, refetch: refetchHealth, isFetching: isHealthFetching } = useGetWhatsAppHealth(orgId)
  const { data: wabas, isLoading: isWabasLoading } = useListWhatsAppWabas(orgId)

  const updateIntegration = useUpdateWhatsAppIntegration()
  const syncResources = useSyncWhatsAppResources()

  const [mode, setMode] = useState<WhatsAppProviderMode>('mock')
  const [wabaId, setWabaId] = useState('')

  const initializedForId = useRef<number | null>(null)

  useEffect(() => {
    if (integration && initializedForId.current !== orgId) {
      initializedForId.current = orgId
      setMode(integration.mode)
      setWabaId(integration.configuredWabaExternalId || '')
    }
  }, [integration, orgId])

  const isForbidden = intError && (intError as any).status === 403

  if (isForbidden || (orgRole !== 'owner' && orgRole !== 'admin')) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center animate-in fade-in zoom-in duration-500">
        <ShieldAlert className="h-16 w-16 text-destructive mb-6" />
        <h2 className="text-3xl font-bold tracking-tight mb-2">Access Restricted</h2>
        <p className="text-muted-foreground max-w-md">
          You don't have permission to view or modify WhatsApp integrations. Only workspace owners and administrators have access to this area.
        </p>
      </div>
    )
  }

  if (isIntLoading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <p className="text-muted-foreground animate-pulse">Loading integration settings...</p>
      </div>
    )
  }

  const handleSaveSettings = () => {
    updateIntegration.mutate(
      {
        organizationId: orgId,
        data: {
          mode,
          configuredWabaExternalId: wabaId || null,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Integration settings updated successfully" })
          queryClient.invalidateQueries({ queryKey: getGetWhatsAppIntegrationQueryKey(orgId) })
          queryClient.invalidateQueries({ queryKey: getGetWhatsAppHealthQueryKey(orgId) })
        },
        onError: () => {
          toast({ title: "Failed to update integration settings", variant: "destructive" })
        },
      }
    )
  }

  const handleSync = () => {
    syncResources.mutate(
      { organizationId: orgId },
      {
        onSuccess: (result) => {
          toast({
            title: "Synchronization complete",
            description: `Synced ${result.wabas} WABAs, ${result.phoneNumbers} numbers, and ${result.templates} templates.`,
          })
          queryClient.invalidateQueries({ queryKey: getGetWhatsAppIntegrationQueryKey(orgId) })
          queryClient.invalidateQueries({ queryKey: getGetWhatsAppHealthQueryKey(orgId) })
          queryClient.invalidateQueries({ queryKey: getListWhatsAppWabasQueryKey(orgId) })
          queryClient.invalidateQueries({ queryKey: getListPhoneNumbersQueryKey() })
          queryClient.invalidateQueries({ queryKey: getListTemplatesQueryKey() })
        },
        onError: () => {
          toast({ title: "Synchronization failed", variant: "destructive" })
        },
      }
    )
  }

  const wabaList = wabas ?? []

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">WhatsApp Integration</h1>
        <p className="text-muted-foreground mt-1">Configure your workspace connection to the WhatsApp Cloud API.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Cable className="h-5 w-5 text-primary" /> Connection Mode</CardTitle>
            <CardDescription>Select how Wabista Nexus interacts with WhatsApp.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 flex-1">
            <div className="grid gap-2">
              <Label>Provider Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as WhatsAppProviderMode)}>
                <SelectTrigger data-testid="select-provider-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mock">Mock (Development / Local Testing)</SelectItem>
                  <SelectItem value="real">Real (Cloud API)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {mode === 'real' && (
              <div className="grid gap-2 animate-in slide-in-from-top-2 duration-300">
                <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-[13px] text-amber-950">
                  This deployment has one shared connector credential. Only one workspace can claim real mode, and only an owner can enable or change it.
                </p>
                <Label htmlFor="waba-id">WABA External ID</Label>
                <Input
                  id="waba-id"
                  data-testid="input-waba-id"
                  value={wabaId}
                  onChange={(e) => setWabaId(e.target.value)}
                  placeholder="e.g. 102345678901234"
                />
                <p className="text-[13px] text-muted-foreground mt-1">
                  This is your WhatsApp Business Account ID from the Meta App Dashboard (API Setup page), NOT your phone number ID.
                </p>
              </div>
            )}
          </CardContent>
          <CardFooter className="border-t bg-muted/20 px-6 py-4">
            <Button 
              onClick={handleSaveSettings} 
              disabled={updateIntegration.isPending}
              data-testid="button-save-settings"
              className="w-full sm:w-auto"
            >
              <Save className="mr-2 h-4 w-4" />
              {updateIntegration.isPending ? "Saving..." : "Save Configuration"}
            </Button>
          </CardFooter>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-start justify-between pb-2">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5 text-primary" /> Health & Webhooks</CardTitle>
              <CardDescription>Current status of the WhatsApp connection.</CardDescription>
            </div>
            <Button 
              variant="outline" 
              size="icon" 
              onClick={() => refetchHealth()} 
              disabled={isHealthLoading || isHealthFetching}
              data-testid="button-refresh-health"
            >
              <RefreshCw className={`h-4 w-4 ${isHealthFetching ? "animate-spin" : ""}`} />
            </Button>
          </CardHeader>
          <CardContent className="space-y-6 flex-1">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b pb-4">
                <span className="font-medium text-sm">Provider Health</span>
                {health?.status === 'healthy' ? (
                  <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Healthy</Badge>
                ) : health?.status === 'unhealthy' ? (
                  <Badge variant="destructive" className="gap-1"><ShieldAlert className="h-3 w-3" /> Unhealthy</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">Not Configured</Badge>
                )}
              </div>
              <div className="flex items-center justify-between border-b pb-4">
                <span className="font-medium text-sm">Webhook Verification</span>
                {integration?.webhookVerificationConfigured ? (
                  <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Configured</Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" /> Missing</Badge>
                )}
              </div>
              <div className="flex items-center justify-between border-b pb-4">
                <span className="font-medium text-sm">Webhook Signature</span>
                {integration?.webhookSignatureConfigured ? (
                  <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Configured</Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" /> Missing</Badge>
                )}
              </div>
            </div>
            
            {health?.error && (
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md border border-destructive/20 break-words">
                <strong>Health Error:</strong> {health.error}
              </div>
            )}
            
            {integration?.lastError && (
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-md border border-destructive/20 break-words">
                <strong>Last Integration Error:</strong> {integration.lastError}
                <div className="text-xs mt-1 opacity-70">
                  {integration.lastErrorAt ? new Date(integration.lastErrorAt).toLocaleString() : ''}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2"><Plug className="h-5 w-5 text-primary" /> Synchronized WABAs</CardTitle>
            <CardDescription>
              Accounts pulled from the connected provider.
              {integration?.lastSyncAt && (
                <span className="block mt-1">Last synced: {new Date(integration.lastSyncAt).toLocaleString()}</span>
              )}
            </CardDescription>
          </div>
          <Button 
            onClick={handleSync} 
            disabled={syncResources.isPending}
            data-testid="button-sync-resources"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${syncResources.isPending ? "animate-spin" : ""}`} />
            {syncResources.isPending ? "Syncing..." : "Sync Resources"}
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Display Name</TableHead>
                <TableHead>External ID</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Synced</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isWabasLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Loading WABAs...</TableCell>
                </TableRow>
              )}
              {!isWabasLoading && wabaList.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">No WABAs synchronized yet.</TableCell>
                </TableRow>
              )}
              {wabaList.map((waba) => (
                <TableRow key={waba.id} data-testid={`row-waba-${waba.id}`}>
                  <TableCell className="font-medium">{waba.displayName}</TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">{waba.externalId}</TableCell>
                  <TableCell>{waba.provider}</TableCell>
                  <TableCell>
                    {waba.providerStatus ? (
                      <Badge variant="outline">{waba.providerStatus}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {waba.lastSyncedAt ? new Date(waba.lastSyncedAt).toLocaleString() : "Never"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
