import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Search, MoreHorizontal, Pencil, Trash2, Sparkles } from "lucide-react"
import {
  useListContacts,
  useCreateContact,
  useUpdateContact,
  useDeleteContact,
  getListContactsQueryKey,
  type Contact,
  type ContactInputStatus,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useToast } from "@/hooks/use-toast"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type ContactFormState = {
  name: string
  phone: string
  email: string
  tags: string
  status: ContactInputStatus
  source: string
}

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300

const emptyForm: ContactFormState = {
  name: "",
  phone: "",
  email: "",
  tags: "",
  status: "Active",
  source: "Manual",
}

function ContactFormDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  isSubmitting,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: ContactFormState
  onSubmit: (values: ContactFormState) => void
  isSubmitting: boolean
  title: string
}) {
  const [form, setForm] = useState<ContactFormState>(initial)

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
            <Label htmlFor="contact-name">Name</Label>
            <Input
              id="contact-name"
              data-testid="input-contact-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contact-phone">Phone</Label>
            <Input
              id="contact-phone"
              data-testid="input-contact-phone"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="+1 555 000 1234"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contact-email">Email</Label>
            <Input
              id="contact-email"
              data-testid="input-contact-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contact-tags">Tags (comma separated)</Label>
            <Input
              id="contact-tags"
              data-testid="input-contact-tags"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="VIP, EU"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(value) => setForm({ ...form, status: value as ContactInputStatus })}
              >
                <SelectTrigger data-testid="select-contact-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Inactive">Inactive</SelectItem>
                  <SelectItem value="Unsubscribed">Unsubscribed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="contact-source">Source</Label>
              <Input
                id="contact-source"
                data-testid="input-contact-source"
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting} data-testid="button-submit-contact">
              {isSubmitting ? "Saving..." : "Save Contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function Contacts() {
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [editingContact, setEditingContact] = useState<Contact | null>(null)
  const [deletingContact, setDeletingContact] = useState<Contact | null>(null)

  // Debounce search so fast typing doesn't fire a server request (and a
  // trigram-index scan) per keystroke against a potentially large address book.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const { data, isLoading } = useListContacts({
    search: debouncedSearch || undefined,
    limit: PAGE_SIZE,
    offset,
  })
  const createContact = useCreateContact()
  const updateContact = useUpdateContact()
  const deleteContact = useDeleteContact()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const invalidateContacts = () =>
    queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() })

  const filtered = data?.contacts ?? []
  const total = data?.total ?? 0
  const page = { from: total === 0 ? 0 : offset + 1, to: Math.min(offset + PAGE_SIZE, total) }

  const toTags = (raw: string) =>
    raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)

  const handleCreate = (values: ContactFormState) => {
    createContact.mutate(
      {
        data: {
          name: values.name,
          phone: values.phone,
          email: values.email || null,
          tags: toTags(values.tags),
          status: values.status,
          source: values.source,
        },
      },
      {
        onSuccess: () => {
          invalidateContacts()
          toast({ title: "Contact created" })
          setCreateOpen(false)
        },
        onError: () => toast({ title: "Failed to create contact", variant: "destructive" }),
      }
    )
  }

  const handleUpdate = (values: ContactFormState) => {
    if (!editingContact) return
    updateContact.mutate(
      {
        contactId: editingContact.id,
        data: {
          name: values.name,
          phone: values.phone,
          email: values.email || null,
          tags: toTags(values.tags),
          status: values.status,
          source: values.source,
        },
      },
      {
        onSuccess: () => {
          invalidateContacts()
          toast({ title: "Contact updated" })
          setEditingContact(null)
        },
        onError: () => toast({ title: "Failed to update contact", variant: "destructive" }),
      }
    )
  }

  const handleDelete = () => {
    if (!deletingContact) return
    deleteContact.mutate(
      { contactId: deletingContact.id },
      {
        onSuccess: () => {
          invalidateContacts()
          // If we just deleted the last contact on a page beyond the first,
          // step back a page instead of showing an empty page.
          if (offset > 0 && filtered.length === 1) setOffset(Math.max(0, offset - PAGE_SIZE))
          toast({ title: "Contact deleted" })
          setDeletingContact(null)
        },
        onError: () => toast({ title: "Failed to delete contact", variant: "destructive" }),
      }
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Contacts</h1>
          <p className="text-muted-foreground">Manage your customer database and audience segments.</p>
        </div>
        <Button className="gap-2" data-testid="button-add-contact" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Contact
        </Button>
      </div>

      <Card>
        <div className="p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone, or email..."
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setOffset(0)
              }}
              data-testid="input-search-contacts"
            />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contact</TableHead>
              <TableHead>Phone / Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  Loading contacts...
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No contacts found.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((contact) => (
              <TableRow key={contact.id} className="group" data-testid={`row-contact-${contact.id}`}>
                <TableCell>
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    {contact.name}
                    {contact.isSample && (
                      <Badge variant="outline" className="gap-1 text-[10px] py-0 h-5">
                        <Sparkles className="h-2.5 w-2.5" /> Sample
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-mono text-sm">{contact.phone}</div>
                  <div className="text-xs text-muted-foreground mt-1">{contact.email}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={
                    contact.status === 'Active' ? 'success' :
                    contact.status === 'Inactive' ? 'secondary' : 'destructive'
                  }>
                    {contact.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {contact.tags.map(tag => (
                      <Badge key={tag} variant="outline" className="text-[10px] py-0 h-5">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {contact.source}
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" data-testid={`button-contact-actions-${contact.id}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditingContact(contact)} data-testid={`button-edit-contact-${contact.id}`}>
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeletingContact(contact)}
                        data-testid={`button-delete-contact-${contact.id}`}
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
              data-testid="button-contacts-prev-page"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              data-testid="button-contacts-next-page"
            >
              Next
            </Button>
          </div>
        </div>
      </Card>

      <ContactFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={emptyForm}
        onSubmit={handleCreate}
        isSubmitting={createContact.isPending}
        title="Add Contact"
      />

      {editingContact && (
        <ContactFormDialog
          open={!!editingContact}
          onOpenChange={(open) => !open && setEditingContact(null)}
          initial={{
            name: editingContact.name,
            phone: editingContact.phone,
            email: editingContact.email ?? "",
            tags: editingContact.tags.join(", "),
            status: editingContact.status,
            source: editingContact.source,
          }}
          onSubmit={handleUpdate}
          isSubmitting={updateContact.isPending}
          title="Edit Contact"
        />
      )}

      <AlertDialog open={!!deletingContact} onOpenChange={(open) => !open && setDeletingContact(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete contact?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {deletingContact?.name}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} data-testid="button-confirm-delete-contact">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
