import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FilePen, Plus, RefreshCw } from "lucide-react"
import {
  getListTemplateDraftsQueryKey,
  getListTemplatesQueryKey,
  listTemplateDrafts,
  useDeleteTemplateDraft,
  useListTemplateDrafts,
  useReconcileTemplateDraft,
  useRefreshTemplateDraftStatus,
  type TemplateDraft,
  type TemplateDraftPage,
} from "@workspace/api-client-react"
import { EmptyState, ErrorState, StatusChip, TableRowsSkeleton } from "@/components/app"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { messageFrom } from "@/lib/api-errors"
import { describeDraftState } from "@/lib/template-draft-model"
import { TemplateDraftEditor } from "./template-draft-editor"

// Drafts tab (V2-03B). Lists what this workspace authored, with the
// lifecycle state Wabista owns and, once submitted, the approval status
// Meta owns. Polling runs only while a submission is in flight and the
// tab is visible; it stops on its own.

const PAGE = 25
const SUBMITTING_POLL_MS = 5_000

export function TemplateDraftsTab({ organizationId, canAuthor }: { organizationId: number; canAuthor: boolean }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [extraPages, setExtraPages] = useState<TemplateDraftPage[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [editing, setEditing] = useState<{ draft: TemplateDraft | null; open: boolean }>({ draft: null, open: false })
  const [deleting, setDeleting] = useState<TemplateDraft | null>(null)
  const [reconciling, setReconciling] = useState<TemplateDraft | null>(null)

  const firstPage = useListTemplateDrafts(organizationId, { limit: PAGE }, {
    query: {
      queryKey: getListTemplateDraftsQueryKey(organizationId, { limit: PAGE }),
      refetchInterval: (query) => {
        const items = query.state.data?.items ?? []
        return items.some((d) => d.state === "submitting") && typeof document !== "undefined" && document.visibilityState === "visible" ? SUBMITTING_POLL_MS : false
      },
    },
  })
  const remove = useDeleteTemplateDraft()
  const reconcile = useReconcileTemplateDraft()
  const refresh = useRefreshTemplateDraftStatus()

  const items = useMemo(() => {
    const seen = new Set<number>()
    const all = [...(firstPage.data?.items ?? []), ...extraPages.flatMap((page) => page.items)]
    return all.filter((draft) => (seen.has(draft.id) ? false : (seen.add(draft.id), true)))
  }, [firstPage.data, extraPages])
  const nextCursor = extraPages.length ? extraPages[extraPages.length - 1].nextCursor : firstPage.data?.nextCursor ?? null

  const invalidate = () => {
    setExtraPages([])
    void queryClient.invalidateQueries({ queryKey: getListTemplateDraftsQueryKey(organizationId) })
    void queryClient.invalidateQueries({ queryKey: getListTemplatesQueryKey() })
  }

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await listTemplateDrafts(organizationId, { limit: PAGE, cursor: nextCursor })
      setExtraPages((pages) => [...pages, page])
    } catch (error) {
      toast({ title: messageFrom(error, "Couldn't load more drafts."), variant: "destructive" })
    } finally { setLoadingMore(false) }
  }

  const onReconcile = (draft: TemplateDraft, discardUnconfirmed: boolean) => {
    reconcile.mutate({ organizationId, draftId: draft.id, data: { discardUnconfirmed } }, {
      onSuccess: (result) => {
        invalidate()
        if (result.state === "submitted") toast({ title: "Confirmed with Meta", description: `"${result.name}" exists at Meta; status ${result.providerStatus ?? "unknown"}.` })
        else if (result.state === "failed") toast({ title: "Unconfirmed submission discarded", description: "The draft can be edited and submitted again." })
        else toast({ title: "Still unconfirmed", description: result.lastError ?? "Meta did not confirm the template. You can check again later or discard the unconfirmed submission." })
      },
      onError: (error) => toast({ title: messageFrom(error, "Couldn't reconcile with Meta."), variant: "destructive" }),
    })
  }

  const onRefresh = (draft: TemplateDraft) => {
    refresh.mutate({ organizationId, draftId: draft.id }, {
      onSuccess: (result) => { invalidate(); toast({ title: "Status refreshed", description: `Meta reports "${result.name}" as ${result.providerStatus ?? "unknown"}.` }) },
      onError: (error) => toast({ title: messageFrom(error, "Couldn't refresh the status."), variant: "destructive" }),
    })
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Drafts</CardTitle>
            <CardDescription>
              {firstPage.isSuccess ? (items.length === 0 ? "Nothing authored yet." : `${items.length}${nextCursor !== null ? "+" : ""} ${items.length === 1 ? "draft" : "drafts"}. Approval always comes from Meta.`) : "Loading…"}
            </CardDescription>
          </div>
          <Button className="gap-2" disabled={!canAuthor} title={canAuthor ? undefined : "Only workspace owners and admins can author templates."} onClick={() => setEditing({ draft: null, open: true })} data-testid="button-create-template">
            <Plus className="h-4 w-4" />
            New draft
          </Button>
        </CardHeader>
        <CardContent>
          {firstPage.isLoading ? (
            <Table><TableBody><TableRowsSkeleton rows={3} columns={5} /></TableBody></Table>
          ) : firstPage.isError ? (
            <ErrorState title="Couldn't load drafts." error={firstPage.error} onRetry={() => void firstPage.refetch()} data-testid="error-template-drafts" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={FilePen}
              title="No drafts yet."
              description={canAuthor ? "Author a template here and submit it to Meta for review through your business account's credential." : "Workspace owners and admins can author templates."}
              primaryAction={canAuthor ? <Button onClick={() => setEditing({ draft: null, open: true })} data-testid="button-create-template-empty">New draft</Button> : undefined}
              data-testid="empty-template-drafts"
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="hidden md:table-cell">Meta status</TableHead>
                    <TableHead className="hidden lg:table-cell">Business account</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((draft) => (
                    <TableRow key={draft.id} data-testid={`row-template-draft-${draft.id}`}>
                      <TableCell>
                        <button type="button" className="text-left" onClick={() => setEditing({ draft, open: true })} data-testid={`link-template-draft-${draft.id}`}>
                          <div className="font-mono text-sm">{draft.name}</div>
                          <div className="text-xs text-muted-foreground">{draft.language} · {draft.category === "MARKETING" ? "Marketing" : "Utility"}{draft.content.body.text ? ` · ${draft.content.body.text.length > 60 ? `${draft.content.body.text.slice(0, 60)}…` : draft.content.body.text}` : ""}</div>
                        </button>
                      </TableCell>
                      <TableCell>
                        <StatusChip kind="templateDraft" value={draft.state} data-testid={`chip-draft-state-${draft.id}`} />
                        {draft.state === "failed" || draft.state === "reconcile_required" ? <div className="mt-1 max-w-xs text-xs text-muted-foreground" title={draft.lastError ?? undefined}>{draft.lastError}</div> : null}
                        {draft.validation?.length && draft.state === "draft" ? <div className="mt-1 text-xs text-muted-foreground">{draft.validation.length} {draft.validation.length === 1 ? "thing" : "things"} to complete</div> : null}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {draft.state === "submitted" ? <StatusChip kind="template" value={draft.providerStatus ?? "Unknown"} data-testid={`chip-draft-provider-status-${draft.id}`} /> : <span className="text-xs text-muted-foreground">{draft.state === "submitting" ? "Waiting for Meta" : "Not submitted"}</span>}
                        {draft.state === "submitted" && draft.providerStatusCheckedAt ? <div className="text-[11px] text-muted-foreground">checked {new Date(draft.providerStatusCheckedAt).toLocaleString()}</div> : null}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">{draft.wabaDisplayName ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {draft.state === "submitted" && canAuthor ? (
                            <Button variant="ghost" size="sm" className="gap-1" disabled={refresh.isPending} onClick={() => onRefresh(draft)} data-testid={`button-draft-refresh-${draft.id}`}>
                              <RefreshCw className={`h-3.5 w-3.5 ${refresh.isPending && refresh.variables?.draftId === draft.id ? "animate-spin" : ""}`} />Refresh status
                            </Button>
                          ) : null}
                          {draft.state === "reconcile_required" && canAuthor ? (
                            <Button variant="outline" size="sm" disabled={reconcile.isPending} onClick={() => setReconciling(draft)} data-testid={`button-draft-reconcile-${draft.id}`}>Reconcile</Button>
                          ) : null}
                          {(draft.state === "draft" || draft.state === "failed") && canAuthor ? (
                            <Button variant="ghost" size="sm" onClick={() => setEditing({ draft, open: true })} data-testid={`button-draft-edit-${draft.id}`}>Edit</Button>
                          ) : (
                            <Button variant="ghost" size="sm" onClick={() => setEditing({ draft, open: true })} data-testid={`button-draft-view-${draft.id}`}>View</Button>
                          )}
                          {canAuthor && draft.state !== "submitting" && draft.state !== "reconcile_required" ? (
                            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(draft)} data-testid={`button-draft-delete-${draft.id}`}>Delete</Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {nextCursor !== null ? (
                <div className="mt-3 flex justify-center">
                  <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()} data-testid="button-drafts-load-more">{loadingMore ? "Loading…" : "Load more"}</Button>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <TemplateDraftEditor organizationId={organizationId} draft={editing.draft} open={editing.open} onOpenChange={(open) => { setEditing((state) => ({ ...state, open })); if (!open) invalidate() }} />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null) }}>
        <AlertDialogContent data-testid="dialog-delete-draft">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft "{deleting?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.state === "submitted" ? "Only the draft in Wabista is removed. The template at Meta is not touched." : "This removes the draft and its submission history from Wabista."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleting) return
                remove.mutate({ organizationId, draftId: deleting.id }, {
                  onSuccess: () => { invalidate(); toast({ title: "Draft deleted" }) },
                  onError: (error) => toast({ title: messageFrom(error, "Couldn't delete the draft."), variant: "destructive" }),
                  onSettled: () => setDeleting(null),
                })
              }}
              data-testid="button-confirm-delete-draft"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={reconciling !== null} onOpenChange={(open) => { if (!open) setReconciling(null) }}>
        <AlertDialogContent data-testid="dialog-reconcile-draft">
          <AlertDialogHeader>
            <AlertDialogTitle>Check "{reconciling?.name}" with Meta</AlertDialogTitle>
            <AlertDialogDescription>
              {describeDraftState("reconcile_required")} Wabista asks Meta whether a template with this exact name, language and content exists. {reconciling?.latestAttempt?.reconcileNote ? `Last check: ${reconciling.latestAttempt.reconcileNote}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap">
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <Button variant="outline" disabled={reconcile.isPending} onClick={() => { if (reconciling) { onReconcile(reconciling, true); setReconciling(null) } }} data-testid="button-confirm-discard-unconfirmed">Discard if not at Meta</Button>
            <AlertDialogAction disabled={reconcile.isPending} onClick={() => { if (reconciling) onReconcile(reconciling, false) }} data-testid="button-confirm-reconcile">Check with Meta</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
