import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Building2, Globe2, Save } from "lucide-react"
import {
  useListOrganizations,
  useUpdateOrganization,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"

export default function Settings() {
  const { data: organizations } = useListOrganizations()
  const updateOrganization = useUpdateOrganization()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const activeOrg = organizations?.find((org) => org.isActive) ?? organizations?.[0]
  const canEdit = activeOrg?.role === "owner" || activeOrg?.role === "admin"

  const [name, setName] = useState("")

  useEffect(() => {
    if (activeOrg) setName(activeOrg.name)
  }, [activeOrg?.id, activeOrg?.name])

  const handleSave = () => {
    if (!activeOrg) return
    updateOrganization.mutate(
      { organizationId: activeOrg.id, data: { name } },
      {
        onSuccess: () => {
          toast({ title: "Workspace updated" })
          queryClient.invalidateQueries({ queryKey: ["/api/organizations"] })
        },
        onError: () => toast({ title: "Failed to update workspace", variant: "destructive" }),
      }
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your workspace configuration and preferences.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" /> Workspace Profile</CardTitle>
          <CardDescription>General information about your tenant/workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Workspace Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit}
              data-testid="input-workspace-name"
            />
            {!canEdit && (
              <p className="text-xs text-muted-foreground">Only an Owner or Admin can rename the workspace.</p>
            )}
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">Workspace Slug</label>
            <Input defaultValue={activeOrg?.slug ?? ""} disabled className="bg-muted font-mono text-xs" />
          </div>
        </CardContent>
        <CardFooter className="bg-slate-50 dark:bg-slate-900/50 border-t py-4 px-6 flex justify-end">
          <Button
            className="gap-2"
            disabled={!canEdit || updateOrganization.isPending || !activeOrg}
            onClick={handleSave}
            data-testid="button-save-workspace"
          >
            <Save className="h-4 w-4" /> {updateOrganization.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Globe2 className="h-5 w-5" /> Localization</CardTitle>
          <CardDescription>
            Configure timezone and defaults for reporting and scheduling. (Not yet persisted — decorative in this milestone.)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Default Timezone</label>
            <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <option value="UTC">UTC - Coordinated Universal Time</option>
              <option value="EST">EST - Eastern Standard Time</option>
              <option value="PST">PST - Pacific Standard Time</option>
              <option value="CET">CET - Central European Time</option>
            </select>
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">Default Number Format</label>
            <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <option value="e164">E.164 (+15551234567)</option>
              <option value="local">Local Format (varies by region)</option>
            </select>
          </div>
        </CardContent>
        <CardFooter className="bg-slate-50 dark:bg-slate-900/50 border-t py-4 px-6 flex justify-end">
          <Button className="gap-2" disabled data-testid="button-save-localization"><Save className="h-4 w-4" /> Save Changes</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
