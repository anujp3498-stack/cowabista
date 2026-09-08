import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, MoreHorizontal, PhoneCall, ShieldAlert, SignalHigh, Pencil, Trash2, Sparkles } from "lucide-react"
import {
  useListPhoneNumbers,
  useCreatePhoneNumber,
  useUpdatePhoneNumber,
  useDeletePhoneNumber,
  getListPhoneNumbersQueryKey,
  type PhoneNumber,
  type PhoneNumberInputQuality,
  type PhoneNumberInputStatus,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"

type FormState = {
  phone: string
  displayName: string
  wabaExternalId: string
  provider: string
  quality: PhoneNumberInputQuality
  status: PhoneNumberInputStatus
  tpsLimit: string
}

const emptyForm: FormState = {
  phone: "",
  displayName: "",
  wabaExternalId: "",
  provider: "Cloud API",
  quality: "High",
  status: "Pending",
  tpsLimit: "50",
}

function PhoneNumberFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  isSubmitting,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: FormState
  onSubmit: (values: FormState) => void
  isSubmitting: boolean
  title: string
}) {
  const [form, setForm] = useState<FormState>(initial)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setForm(initial)
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(form)
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="pn-phone">Phone</Label>
              <Input
                id="pn-phone"
                data-testid="input-pn-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+1 555 019 2831"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pn-name">Display Name</Label>
              <Input
                id="pn-name"
                data-testid="input-pn-name"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                required
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pn-waba">WABA ID</Label>
            <Input
              id="pn-waba"
              data-testid="input-pn-waba"
              value={form.wabaExternalId}
              onChange={(e) => setForm({ ...form, wabaExternalId: e.target.value })}
              placeholder="waba_9x8a7b"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Quality</Label>
              <Select
                value={form.quality}
                onValueChange={(v) => setForm({ ...form, quality: v as PhoneNumberInputQuality })}
              >
                <SelectTrigger data-testid="select-pn-quality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Medium">Medium</SelectItem>
                  <SelectItem value="Low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as PhoneNumberInputStatus })}
              >
                <SelectTrigger data-testid="select-pn-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Connected">Connected</SelectItem>
                  <SelectItem value="Flagged">Flagged</SelectItem>
                  <SelectItem value="Pending">Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="pn-provider">Provider</Label>
              <Input
                id="pn-provider"
                data-testid="input-pn-provider"
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pn-tps">TPS Limit</Label>
              <Input
                id="pn-tps"
                data-testid="input-pn-tps"
                type="number"
                min={1}
                value={form.tpsLimit}
                onChange={(e) => setForm({ ...form, tpsLimit: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting} data-testid="button-submit-pn">
              {isSubmitting ? "Saving..." : "Save Number"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function PhoneNumbers() {
  const { data: phoneNumbers, isLoading } = useListPhoneNumbers()
  const createPhoneNumber = useCreatePhoneNumber()
  const updatePhoneNumber = useUpdatePhoneNumber()
  const deletePhoneNumber = useDeletePhoneNumber()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invalidatePhoneNumbers = () =>
    queryClient.invalidateQueries({ queryKey: getListPhoneNumbersQueryKey() })

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<PhoneNumber | null>(null)
  const [deleting, setDeleting] = useState<PhoneNumber | null>(null)

  const numbers = phoneNumbers ?? []
  const connected = numbers.filter((n) => n.status === "Connected").length
  const flagged = numbers.filter((n) => n.status === "Flagged").length
  const aggregateTps = numbers.reduce((sum, n) => sum + n.tpsLimit, 0)

  const buildPayload = (values: FormState) => ({
    phone: values.phone,
    displayName: values.displayName,
    wabaExternalId: values.wabaExternalId || null,
    provider: values.provider,
    quality: values.quality,
    status: values.status,
    tpsLimit: Number(values.tpsLimit) || 1,
  })

  const handleCreate = (values: FormState) => {
    createPhoneNumber.mutate(
      { data: buildPayload(values) },
      {
        onSuccess: () => {
          invalidatePhoneNumbers()
          toast({ title: "Phone number connected" })
          setCreateOpen(false)
        },
        onError: () => toast({ title: "Failed to connect number", variant: "destructive" }),
      }
    )
  }

  const handleUpdate = (values: FormState) => {
    if (!editing) return
    updatePhoneNumber.mutate(
      { phoneNumberId: editing.id, data: buildPayload(values) },
      {
        onSuccess: () => {
          invalidatePhoneNumbers()
          toast({ title: "Phone number updated" })
          setEditing(null)
        },
        onError: () => toast({ title: "Failed to update number", variant: "destructive" }),
      }
    )
  }

  const handleDelete = () => {
    if (!deleting) return
    deletePhoneNumber.mutate(
      { phoneNumberId: deleting.id },
      {
        onSuccess: () => {
          invalidatePhoneNumbers()
          toast({ title: "Phone number removed" })
          setDeleting(null)
        },
        onError: () => toast({ title: "Failed to remove number", variant: "destructive" }),
      }
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Phone Numbers</h1>
          <p className="text-muted-foreground">Manage your connected WhatsApp Business Accounts and routing limits.</p>
        </div>
        <Button className="gap-2" data-testid="button-connect-number" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Connect Number
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Connected Numbers</CardTitle>
            <PhoneCall className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{connected}</div>
            <p className="text-xs text-muted-foreground mt-1">Out of {numbers.length} total</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Aggregate TPS Capacity</CardTitle>
            <SignalHigh className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{aggregateTps}</div>
            <p className="text-xs text-muted-foreground mt-1">Messages per second total limit</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Flagged Numbers</CardTitle>
            <ShieldAlert className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{flagged}</div>
            <p className="text-xs text-muted-foreground mt-1">Requires immediate attention</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Display Name / Phone</TableHead>
              <TableHead>WABA ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Quality</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>TPS Limit</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading numbers...</TableCell>
              </TableRow>
            )}
            {!isLoading && numbers.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">No phone numbers connected.</TableCell>
              </TableRow>
            )}
            {numbers.map((pn) => (
              <TableRow key={pn.id} className="group" data-testid={`row-pn-${pn.id}`}>
                <TableCell>
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    {pn.displayName}
                    {pn.isSample && (
                      <Badge variant="outline" className="gap-1 text-[10px] py-0 h-5">
                        <Sparkles className="h-2.5 w-2.5" /> Sample
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground font-mono mt-1">{pn.phone}</div>
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">
                  {pn.wabaExternalId ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={
                    pn.status === 'Connected' ? 'success' :
                    pn.status === 'Flagged' ? 'destructive' : 'warning'
                  }>
                    {pn.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 text-sm">
                    <div className={`w-2 h-2 rounded-full ${
                      pn.quality === 'High' ? 'bg-emerald-500' :
                      pn.quality === 'Medium' ? 'bg-amber-500' : 'bg-red-500'
                    }`} />
                    {pn.quality}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">{pn.provider}</span>
                    {pn.lastSyncedAt && (
                      <span className="text-[10px] text-muted-foreground">
                        Synced: {new Date(pn.lastSyncedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono font-medium">
                  {pn.tpsLimit}/s
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" data-testid={`button-pn-actions-${pn.id}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditing(pn)} data-testid={`button-edit-pn-${pn.id}`}>
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleting(pn)}
                        data-testid={`button-delete-pn-${pn.id}`}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <PhoneNumberFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={emptyForm}
        onSubmit={handleCreate}
        isSubmitting={createPhoneNumber.isPending}
        title="Connect Number"
      />

      {editing && (
        <PhoneNumberFormDialog
          open={!!editing}
          onOpenChange={(open) => !open && setEditing(null)}
          initial={{
            phone: editing.phone,
            displayName: editing.displayName,
            wabaExternalId: editing.wabaExternalId ?? "",
            provider: editing.provider,
            quality: editing.quality,
            status: editing.status,
            tpsLimit: String(editing.tpsLimit),
          }}
          onSubmit={handleUpdate}
          isSubmitting={updatePhoneNumber.isPending}
          title="Edit Number"
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove number?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {deleting?.displayName} ({deleting?.phone}). Any campaign routes
              using it will need to be reassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} data-testid="button-confirm-delete-pn">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
