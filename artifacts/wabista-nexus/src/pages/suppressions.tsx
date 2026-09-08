import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Search, Trash2, ShieldOff } from "lucide-react"
import {
  useListSuppressions,
  useCreateSuppression,
  useDeleteSuppression,
  getListSuppressionsQueryKey,
  type Suppression,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"

const PAGE_SIZE = 25

function AddSuppressionDialog({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (phone: string, reason: string) => void
  isSubmitting: boolean
  error: string | null
}) {
  const [phone, setPhone] = useState("")
  const [reason, setReason] = useState("")

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setPhone("")
          setReason("")
        }
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to do-not-contact list</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(phone, reason)
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="suppression-phone">Phone number</Label>
            <Input
              id="suppression-phone"
              data-testid="input-suppression-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+15550001234"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="suppression-reason">Reason (optional)</Label>
            <Input
              id="suppression-reason"
              data-testid="input-suppression-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Requested by phone"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting} data-testid="button-submit-suppression">
              {isSubmitting ? "Adding..." : "Add to list"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function Suppressions() {
  const [search, setSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Suppression | null>(null)

  const { data, isLoading } = useListSuppressions({
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  })
  const createSuppression = useCreateSuppression()
  const deleteSuppression = useDeleteSuppression()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListSuppressionsQueryKey() })

  const suppressions = data?.suppressions ?? []
  const total = data?.total ?? 0
  const page = { from: total === 0 ? 0 : offset + 1, to: Math.min(offset + PAGE_SIZE, total) }

  const handleCreate = (phone: string, reason: string) => {
    setCreateError(null)
    createSuppression.mutate(
      { data: { phone, reason: reason || undefined } },
      {
        onSuccess: () => {
          invalidate()
          toast({ title: "Added to do-not-contact list" })
          setCreateOpen(false)
        },
        onError: (err: unknown) => {
          const message =
            (err as { data?: { error?: string } } | undefined)?.data?.error ??
            "Failed to add suppression"
          setCreateError(message)
        },
      }
    )
  }

  const handleDelete = () => {
    if (!deleting) return
    deleteSuppression.mutate(
      { suppressionId: deleting.id },
      {
        onSuccess: () => {
          invalidate()
          toast({ title: "Removed from do-not-contact list" })
          setDeleting(null)
        },
        onError: () => toast({ title: "Failed to remove suppression", variant: "destructive" }),
      }
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Do-Not-Contact List</h1>
          <p className="text-muted-foreground">
            Numbers here are never sent a campaign message -- added automatically from CSV imports and
            inbound STOP replies, or manually by staff below.
          </p>
        </div>
        <Button className="gap-2" data-testid="button-add-suppression" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Number
        </Button>
      </div>

      <Card>
        <div className="p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by phone number..."
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setOffset(0)
              }}
              data-testid="input-search-suppressions"
            />
          </div>
        </div>
        <Table data-testid="list-suppressions">
          <TableHeader>
            <TableRow>
              <TableHead>Phone</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                  Loading...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && suppressions.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                  <div className="flex flex-col items-center gap-2">
                    <ShieldOff className="h-6 w-6 text-muted-foreground/50" />
                    No suppressed numbers found.
                  </div>
                </TableCell>
              </TableRow>
            )}
            {suppressions.map((s) => (
              <TableRow key={s.id} data-testid={`row-suppression-${s.id}`}>
                <TableCell className="font-mono text-sm">{s.normalizedPhone}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{s.reason}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(s.createdAt).toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleting(s)}
                    data-testid={`button-delete-suppression-${s.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between p-4 border-t text-sm text-muted-foreground">
          <span>
            {total === 0 ? "0 results" : `${page.from}\u2013${page.to} of ${total}`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              data-testid="button-suppressions-prev-page"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              data-testid="button-suppressions-next-page"
            >
              Next
            </Button>
          </div>
        </div>
      </Card>

      <AddSuppressionDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) setCreateError(null)
        }}
        onSubmit={handleCreate}
        isSubmitting={createSuppression.isPending}
        error={createError}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from do-not-contact list?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.normalizedPhone} will become eligible to receive campaign messages again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} data-testid="button-confirm-delete-suppression">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
