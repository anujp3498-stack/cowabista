import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { Plus, Search, FileCode2, Globe, Trash2, Sparkles } from "lucide-react"
import {
  useListTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  getListTemplatesQueryKey,
  type Template,
  type TemplateInputCategory,
  type TemplateInputStatus,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"

type FormState = {
  name: string
  category: TemplateInputCategory
  language: string
  status: TemplateInputStatus
  body: string
}

const emptyForm: FormState = {
  name: "",
  category: "Marketing",
  language: "en_US",
  status: "Pending",
  body: "",
}

function TemplateFormDialog({
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
          <div className="grid gap-2">
            <Label htmlFor="tpl-name">Template Name</Label>
            <Input
              id="tpl-name"
              data-testid="input-template-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="order_confirmation_1"
              required
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v as TemplateInputCategory })}
              >
                <SelectTrigger data-testid="select-template-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Marketing">Marketing</SelectItem>
                  <SelectItem value="Utility">Utility</SelectItem>
                  <SelectItem value="Authentication">Authentication</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tpl-lang">Language</Label>
              <Input
                id="tpl-lang"
                data-testid="input-template-language"
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as TemplateInputStatus })}
              >
                <SelectTrigger data-testid="select-template-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Approved">Approved</SelectItem>
                  <SelectItem value="Pending">Pending</SelectItem>
                  <SelectItem value="Rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tpl-body">Body</Label>
            <Textarea
              id="tpl-body"
              data-testid="textarea-template-body"
              rows={4}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              placeholder="Hi {{1}}, ..."
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting} data-testid="button-submit-template">
              {isSubmitting ? "Saving..." : "Save Template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function Templates() {
  const { data: templates, isLoading } = useListTemplates()
  const createTemplate = useCreateTemplate()
  const updateTemplate = useUpdateTemplate()
  const deleteTemplate = useDeleteTemplate()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invalidateTemplates = () =>
    queryClient.invalidateQueries({ queryKey: getListTemplatesQueryKey() })

  const [search, setSearch] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Template | null>(null)
  const [deleting, setDeleting] = useState<Template | null>(null)

  const filtered = (templates ?? []).filter((t) =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
  )

  const handleCreate = (values: FormState) => {
    createTemplate.mutate(
      { data: values },
      {
        onSuccess: () => {
          invalidateTemplates()
          toast({ title: "Template created" })
          setCreateOpen(false)
        },
        onError: () => toast({ title: "Failed to create template", variant: "destructive" }),
      }
    )
  }

  const handleUpdate = (values: FormState) => {
    if (!editing) return
    updateTemplate.mutate(
      { templateId: editing.id, data: values },
      {
        onSuccess: () => {
          invalidateTemplates()
          toast({ title: "Template updated" })
          setEditing(null)
        },
        onError: () => toast({ title: "Failed to update template", variant: "destructive" }),
      }
    )
  }

  const handleDelete = () => {
    if (!deleting) return
    deleteTemplate.mutate(
      { templateId: deleting.id },
      {
        onSuccess: () => {
          invalidateTemplates()
          toast({ title: "Template deleted" })
          setDeleting(null)
        },
        onError: () => toast({ title: "Failed to delete template", variant: "destructive" }),
      }
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
          <p className="text-muted-foreground">Manage your pre-approved WhatsApp message templates.</p>
        </div>
        <Button className="gap-2" data-testid="button-create-template" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Template
        </Button>
      </div>

      <div className="flex gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-templates"
          />
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading templates...</p>}
      {!isLoading && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">No templates found.</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.map((tpl) => (
          <Card key={tpl.id} className="flex flex-col hover:border-primary/50 transition-colors" data-testid={`card-template-${tpl.id}`}>
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base font-mono break-all flex items-center gap-2">
                    {tpl.name}
                    {tpl.isSample && (
                      <Badge variant="outline" className="gap-1 text-[10px] py-0 h-5">
                        <Sparkles className="h-2.5 w-2.5" /> Sample
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="flex items-center gap-2 mt-2 text-xs">
                    <span className="flex items-center gap-1"><FileCode2 className="h-3 w-3" /> {tpl.category}</span>
                    <span className="flex items-center gap-1"><Globe className="h-3 w-3" /> {tpl.language}</span>
                  </CardDescription>
                </div>
                <Badge variant={
                  tpl.status === 'Approved' ? 'success' :
                  tpl.status === 'Rejected' ? 'destructive' : 'warning'
                }>
                  {tpl.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col">
              <div className="bg-slate-50 dark:bg-slate-900 rounded-md p-4 text-sm font-medium font-mono text-slate-700 dark:text-slate-300 flex-1 whitespace-pre-wrap border shadow-inner">
                {tpl.body}
              </div>
              <div className="text-xs text-muted-foreground mt-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div className="flex flex-col">
                  <span>Updated {new Date(tpl.updatedAt).toLocaleDateString()}</span>
                  {tpl.lastSyncedAt && (
                    <span className="text-[10px] opacity-70">Synced: {new Date(tpl.lastSyncedAt).toLocaleString()}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="link"
                    className="p-0 h-auto text-xs"
                    onClick={() => setEditing(tpl)}
                    data-testid={`button-edit-template-${tpl.id}`}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="link"
                    className="p-0 h-auto text-xs text-destructive"
                    onClick={() => setDeleting(tpl)}
                    data-testid={`button-delete-template-${tpl.id}`}
                  >
                    <Trash2 className="h-3 w-3 mr-1" /> Delete
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <TemplateFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={emptyForm}
        onSubmit={handleCreate}
        isSubmitting={createTemplate.isPending}
        title="Create Template"
      />

      {editing && (
        <TemplateFormDialog
          open={!!editing}
          onOpenChange={(open) => !open && setEditing(null)}
          initial={{
            name: editing.name,
            category: editing.category,
            language: editing.language,
            status: editing.status,
            body: editing.body,
          }}
          onSubmit={handleUpdate}
          isSubmitting={updateTemplate.isPending}
          title="Edit Template"
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {deleting?.name}. Campaign routes referencing it will need a new template.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} data-testid="button-confirm-delete-template">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
