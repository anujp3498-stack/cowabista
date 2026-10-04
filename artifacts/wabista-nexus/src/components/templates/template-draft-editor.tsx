import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, Plus, Send, Trash2, Upload } from "lucide-react"
import {
  getListTemplateAuthoringWabasQueryKey,
  getListTemplateDraftsQueryKey,
  getListTemplatesQueryKey,
  uploadTemplateMedia,
  useCreateTemplateDraft,
  useListTemplateAuthoringWabas,
  useSubmitTemplateDraft,
  useUpdateTemplateDraft,
  type TemplateDraft,
  type TemplateDraftButton,
  type TemplateDraftContent,
  type TemplateDraftError,
  type TemplateDraftFieldError,
  type TemplateDraftHeader,
} from "@workspace/api-client-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { StatusChip } from "@/components/app"
import { useIsMobile } from "@/hooks/use-mobile"
import { useToast } from "@/hooks/use-toast"
import { messageFrom } from "@/lib/api-errors"
import { BODY_TEXT_MAX, BUTTON_TEXT_MAX, FOOTER_TEXT_MAX, HEADER_TEXT_MAX, MAX_BUTTONS, draftComponents, emptyContent, isMediaHeader, variableNumbers, withExamples } from "@/lib/template-draft-model"
import { TemplatePreview } from "./template-preview"

// V2-03B draft editor. Saving stores a draft in Wabista only; "Submit to
// Meta" is a separate, explicit action that sends the creation request
// through the workspace credential of the chosen business account. The
// status shown after submission is Meta's; nothing is approved locally.
// Every write carries the revision the editor loaded, so two people
// editing the same draft get a clear conflict instead of silent overwrite.

type Props = {
  organizationId: number
  draft: TemplateDraft | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Form = { name: string; language: string; category: "MARKETING" | "UTILITY"; wabaId: number | null; content: TemplateDraftContent }

const MEDIA_ACCEPT: Record<string, string> = { image: "image/jpeg,image/png", video: "video/mp4", document: "application/pdf" }

function formFrom(draft: TemplateDraft | null): Form {
  if (!draft) return { name: "", language: "en_US", category: "MARKETING", wabaId: null, content: emptyContent() }
  return { name: draft.name, language: draft.language, category: draft.category, wabaId: draft.wabaId, content: draft.content }
}

function errorData(error: unknown): TemplateDraftError | null {
  const data = (error as { data?: unknown } | null)?.data
  return data && typeof data === "object" && "code" in (data as object) ? (data as TemplateDraftError) : null
}

export function TemplateDraftEditor({ organizationId, draft, open, onOpenChange }: Props) {
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const wabas = useListTemplateAuthoringWabas(organizationId, { query: { enabled: open, queryKey: getListTemplateAuthoringWabasQueryKey(organizationId) } })
  const create = useCreateTemplateDraft()
  const update = useUpdateTemplateDraft()
  const submit = useSubmitTemplateDraft()

  const [form, setForm] = useState<Form>(() => formFrom(draft))
  const [current, setCurrent] = useState<TemplateDraft | null>(draft)
  const [fieldErrors, setFieldErrors] = useState<TemplateDraftFieldError[]>([])
  const [banner, setBanner] = useState<{ title: string; description?: string; variant?: "default" | "destructive" } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadedName, setUploadedName] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) { setForm(formFrom(draft)); setCurrent(draft); setFieldErrors([]); setBanner(null); setUploadedName(null) }
  }, [open, draft])

  const editable = !current || current.state === "draft" || current.state === "failed"
  const busy = create.isPending || update.isPending || submit.isPending || uploading
  const selectedWaba = wabas.data?.find((item) => item.id === form.wabaId) ?? null
  const mediaSupported = Boolean(selectedWaba?.mediaSupported)
  const bodyVariables = useMemo(() => variableNumbers(form.content.body.text), [form.content.body.text])
  const headerVariables = form.content.header.kind === "text" ? variableNumbers(form.content.header.text ?? "") : []
  const previewComponents = useMemo(() => draftComponents(form.content), [form.content])
  const previewWithExamples = useMemo(() => {
    const content: TemplateDraftContent = {
      ...form.content,
      header: form.content.header.kind === "text" ? { ...form.content.header, text: withExamples(form.content.header.text ?? "", [form.content.header.example ?? ""]) } : form.content.header,
      body: { text: withExamples(form.content.body.text, form.content.body.examples), examples: form.content.body.examples },
      buttons: form.content.buttons.map((button) => (button.type === "url" ? { ...button, url: withExamples(button.url ?? "", [button.example ?? ""]) } : button)),
    }
    return draftComponents(content)
  }, [form.content])
  const errorFor = (field: string) => fieldErrors.filter((e) => e.field === field).map((e) => e.message)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getListTemplateDraftsQueryKey(organizationId) })
    void queryClient.invalidateQueries({ queryKey: getListTemplatesQueryKey() })
  }

  const applyError = (error: unknown, fallback: string) => {
    const data = errorData(error)
    setFieldErrors(data?.fields ?? [])
    if (data?.code === "stale_revision") setBanner({ title: "This draft changed elsewhere", description: "Reload the draft to see the latest version, then apply your edits again.", variant: "destructive" })
    else if (data?.code === "invalid_draft" && data.fields?.length) setBanner({ title: "Fix the highlighted fields", variant: "destructive" })
    else setBanner({ title: messageFrom(error, fallback), variant: "destructive" })
  }

  const setContent = (patch: Partial<TemplateDraftContent>) => setForm((f) => ({ ...f, content: { ...f.content, ...patch } }))
  const setHeader = (header: TemplateDraftHeader) => setContent({ header })
  const setButton = (index: number, button: TemplateDraftButton) => setContent({ buttons: form.content.buttons.map((b, i) => (i === index ? button : b)) })

  const save = async (): Promise<TemplateDraft | null> => {
    setBanner(null)
    setFieldErrors([])
    const data = { name: form.name.trim(), language: form.language.trim(), category: form.category, wabaId: form.wabaId, content: form.content }
    try {
      const saved = current
        ? await update.mutateAsync({ organizationId, draftId: current.id, data: { ...data, expectedRevision: current.revision } })
        : await create.mutateAsync({ organizationId, data })
      setCurrent(saved)
      setForm(formFrom(saved))
      invalidate()
      return saved
    } catch (error) {
      applyError(error, "Couldn't save the draft.")
      return null
    }
  }

  const onSave = async () => {
    const saved = await save()
    if (saved) toast({ title: "Draft saved", description: saved.validation?.length ? "Some fields still need attention before it can be submitted." : "Ready to submit to Meta when you are." })
  }

  const onSubmit = async () => {
    const saved = await save()
    if (!saved) return
    if (saved.validation?.length) { setFieldErrors(saved.validation); setBanner({ title: "Complete the draft before submitting", variant: "destructive" }); return }
    try {
      const result = await submit.mutateAsync({ organizationId, draftId: saved.id, data: { expectedRevision: saved.revision } })
      setCurrent(result)
      invalidate()
      toast({ title: "Submitted to Meta", description: `Meta will review "${result.name}". Its status is shown as Meta reports it.` })
      onOpenChange(false)
    } catch (error) {
      const data = errorData(error)
      invalidate()
      if (data?.code === "provider_rejected" || data?.code === "credential_inactive" || data?.code === "reconcile_required" || data?.code === "attempt_in_progress" || data?.code === "provider_unavailable") {
        setBanner({ title: messageFrom(error, "Meta did not accept the template."), description: data?.attempt?.error ?? undefined, variant: "destructive" })
        // The draft state changed server-side (failed / reconcile_required): reload it into the editor.
        const fresh = (error as { data?: TemplateDraft } | null)?.data
        if (fresh && typeof fresh === "object" && "state" in fresh && "revision" in fresh) { setCurrent(fresh); setForm(formFrom(fresh)) }
      } else applyError(error, "Couldn't submit the draft.")
    }
  }

  const onPickFile = async (file: File) => {
    if (!form.wabaId || !isMediaHeader(form.content.header)) return
    setUploading(true)
    setBanner(null)
    try {
      const upload = await uploadTemplateMedia(organizationId, file, { wabaId: form.wabaId, fileName: file.name, contentType: file.type || "application/octet-stream" })
      setHeader({ kind: form.content.header.kind, mediaUploadId: upload.id })
      setUploadedName(`${upload.fileName} (${Math.round(upload.byteLength / 1024)} KB)`)
      setFieldErrors((errors) => errors.filter((e) => e.field !== "header.mediaUploadId"))
    } catch (error) {
      const data = errorData(error)
      setBanner({ title: messageFrom(error, "Couldn't upload the media example."), description: data?.code === "media_not_configured" ? "Text-only templates can still be authored and submitted." : undefined, variant: "destructive" })
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  const headerKind = form.content.header.kind

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl" data-testid="dialog-template-draft">
        <DialogHeader>
          <DialogTitle>{current ? `Draft: ${current.name}` : "New template draft"}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            {current ? <StatusChip kind="templateDraft" value={current.state} data-testid="chip-draft-state" /> : <span>Saved in Wabista until you submit it to Meta.</span>}
            {current?.state === "submitted" ? <StatusChip kind="template" value={current.providerStatus ?? "Unknown"} /> : null}
            {current ? <span className="text-xs">Revision {current.revision}</span> : null}
          </DialogDescription>
        </DialogHeader>

        {banner ? (
          <Alert variant={banner.variant ?? "default"} data-testid="alert-draft-editor">
            <AlertTitle>{banner.title}</AlertTitle>
            {banner.description ? <AlertDescription>{banner.description}</AlertDescription> : null}
          </Alert>
        ) : null}

        {isMobile ? (
          <div className="space-y-4">
            <Alert data-testid="alert-edit-on-desktop">
              <AlertTitle>Edit on desktop</AlertTitle>
              <AlertDescription>Template authoring needs a larger screen. You can review the draft here.</AlertDescription>
            </Alert>
            <TemplatePreview components={previewComponents} emptyBodyHint="No body yet." />
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5">
              {!editable && current ? (
                <Alert data-testid="alert-draft-frozen">
                  <AlertTitle>{current.state === "submitting" ? "Submission in progress" : current.state === "submitted" ? "Submitted to Meta" : "Outcome unknown"}</AlertTitle>
                  <AlertDescription>
                    {current.state === "submitted" ? "Content is frozen. Create a new draft to make changes." : current.state === "reconcile_required" ? "Reconcile with Meta from the Drafts list before editing." : "Wait for Meta's answer."}
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" errors={errorFor("name")} hint="Lowercase letters, numbers and underscores.">
                  <Input value={form.name} disabled={!editable} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="order_ready_v1" data-testid="input-draft-name" />
                </Field>
                <Field label="Business account" errors={errorFor("wabaId")}>
                  <Select value={form.wabaId === null ? "" : String(form.wabaId)} disabled={!editable} onValueChange={(value) => setForm({ ...form, wabaId: Number(value) })}>
                    <SelectTrigger data-testid="select-draft-waba"><SelectValue placeholder={wabas.isLoading ? "Loading…" : "Choose a business account"} /></SelectTrigger>
                    <SelectContent>
                      {(wabas.data ?? []).map((item) => (
                        <SelectItem key={item.id} value={String(item.id)} disabled={!item.authoringSupported} data-testid={`option-draft-waba-${item.id}`}>
                          {item.displayName}{item.authoringSupported ? "" : " — not available"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedWaba && !selectedWaba.authoringSupported ? <p className="text-xs text-destructive">{selectedWaba.reason}</p> : null}
                  {(wabas.data ?? []).some((item) => !item.authoringSupported) ? (
                    <p className="text-xs text-muted-foreground">{(wabas.data ?? []).filter((item) => !item.authoringSupported).map((item) => `${item.displayName}: ${item.reason}`).join(" ")}</p>
                  ) : null}
                </Field>
                <Field label="Language" errors={errorFor("language")} hint="Meta language code, e.g. en_US or hi.">
                  <Input value={form.language} disabled={!editable} onChange={(e) => setForm({ ...form, language: e.target.value })} data-testid="input-draft-language" />
                </Field>
                <Field label="Category" errors={errorFor("category")}>
                  <Select value={form.category} disabled={!editable} onValueChange={(value) => setForm({ ...form, category: value as Form["category"] })}>
                    <SelectTrigger data-testid="select-draft-category"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MARKETING">Marketing</SelectItem>
                      <SelectItem value="UTILITY">Utility</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <section className="space-y-3">
                <Label className="text-sm font-semibold">Header</Label>
                <Select value={headerKind} disabled={!editable} onValueChange={(value) => setHeader(value === "text" ? { kind: "text", text: "", example: "" } : value === "none" ? { kind: "none" } : { kind: value as "image" | "video" | "document", mediaUploadId: null })}>
                  <SelectTrigger className="w-56" data-testid="select-draft-header-kind"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No header</SelectItem>
                    <SelectItem value="text">Text</SelectItem>
                    <SelectItem value="image" disabled={!mediaSupported}>Image{mediaSupported ? "" : " (media uploads not available)"}</SelectItem>
                    <SelectItem value="video" disabled={!mediaSupported}>Video{mediaSupported ? "" : " (media uploads not available)"}</SelectItem>
                    <SelectItem value="document" disabled={!mediaSupported}>Document{mediaSupported ? "" : " (media uploads not available)"}</SelectItem>
                  </SelectContent>
                </Select>
                {headerKind === "text" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Header text" errors={errorFor("header.text")} counter={[form.content.header.text?.length ?? 0, HEADER_TEXT_MAX]}>
                      <Input value={form.content.header.text ?? ""} disabled={!editable} onChange={(e) => setHeader({ ...form.content.header, kind: "text", text: e.target.value })} data-testid="input-draft-header-text" />
                    </Field>
                    {headerVariables.length ? (
                      <Field label="Example for header {{1}}" errors={errorFor("header.example")}>
                        <Input value={form.content.header.example ?? ""} disabled={!editable} onChange={(e) => setHeader({ ...form.content.header, kind: "text", example: e.target.value })} data-testid="input-draft-header-example" />
                      </Field>
                    ) : null}
                  </div>
                ) : null}
                {isMediaHeader(form.content.header) ? (
                  <div className="space-y-2">
                    <input ref={fileInput} type="file" className="hidden" accept={MEDIA_ACCEPT[headerKind]} onChange={(e) => { const file = e.target.files?.[0]; if (file) void onPickFile(file) }} data-testid="input-draft-media-file" />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" size="sm" className="gap-2" disabled={!editable || !form.wabaId || !mediaSupported || uploading} onClick={() => fileInput.current?.click()} data-testid="button-draft-upload-media">
                        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        {uploading ? "Uploading…" : form.content.header.mediaUploadId ? "Replace example" : `Upload ${headerKind} example`}
                      </Button>
                      <span className="text-xs text-muted-foreground" data-testid="text-draft-media-status">
                        {uploadedName ?? (form.content.header.mediaUploadId ? `Example uploaded (#${form.content.header.mediaUploadId}).` : form.wabaId ? "Meta needs a sample file for media headers. It is uploaded to Meta through this business account's credential." : "Choose a business account first.")}
                      </span>
                    </div>
                    {errorFor("header.mediaUploadId").map((message) => <p key={message} className="text-xs text-destructive">{message}</p>)}
                  </div>
                ) : null}
              </section>

              <section className="space-y-3">
                <Field label="Body" errors={errorFor("body.text")} counter={[form.content.body.text.length, BODY_TEXT_MAX]} hint="Use {{1}}, {{2}}… for values filled per message.">
                  <Textarea rows={5} value={form.content.body.text} disabled={!editable} onChange={(e) => setContent({ body: { ...form.content.body, text: e.target.value } })} data-testid="textarea-draft-body" />
                </Field>
                {bodyVariables.length ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {bodyVariables.map((n) => (
                      <Field key={n} label={`Example for {{${n}}}`} errors={errorFor(`body.examples.${n - 1}`)}>
                        <Input value={form.content.body.examples[n - 1] ?? ""} disabled={!editable} onChange={(e) => { const examples = [...form.content.body.examples]; while (examples.length < n) examples.push(""); examples[n - 1] = e.target.value; setContent({ body: { ...form.content.body, examples } }) }} data-testid={`input-draft-body-example-${n}`} />
                      </Field>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold">Footer</Label>
                  {form.content.footer === null ? (
                    <Button type="button" variant="ghost" size="sm" disabled={!editable} onClick={() => setContent({ footer: { text: "" } })} data-testid="button-draft-add-footer">Add footer</Button>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" disabled={!editable} onClick={() => setContent({ footer: null })} data-testid="button-draft-remove-footer">Remove</Button>
                  )}
                </div>
                {form.content.footer ? (
                  <Field label="Footer text" errors={errorFor("footer.text")} counter={[form.content.footer.text.length, FOOTER_TEXT_MAX]}>
                    <Input value={form.content.footer.text} disabled={!editable} onChange={(e) => setContent({ footer: { text: e.target.value } })} data-testid="input-draft-footer" />
                  </Field>
                ) : null}
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold">Buttons</Label>
                  <div className="flex gap-1">
                    {(["quick_reply", "url", "phone"] as const).map((type) => (
                      <Button key={type} type="button" variant="ghost" size="sm" className="gap-1" disabled={!editable || form.content.buttons.length >= MAX_BUTTONS} onClick={() => setContent({ buttons: [...form.content.buttons, type === "url" ? { type, text: "", url: "", example: "" } : type === "phone" ? { type, text: "", phoneNumber: "" } : { type, text: "" }] })} data-testid={`button-draft-add-${type}`}>
                        <Plus className="h-3.5 w-3.5" />{type === "quick_reply" ? "Quick reply" : type === "url" ? "Website" : "Call"}
                      </Button>
                    ))}
                  </div>
                </div>
                {errorFor("buttons").map((message) => <p key={message} className="text-xs text-destructive">{message}</p>)}
                {form.content.buttons.map((button, index) => (
                  <div key={index} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]" data-testid={`row-draft-button-${index}`}>
                    <Field label={`${button.type === "quick_reply" ? "Quick reply" : button.type === "url" ? "Website button" : "Call button"} label`} errors={errorFor(`buttons.${index}.text`)} counter={[button.text.length, BUTTON_TEXT_MAX]}>
                      <Input value={button.text} disabled={!editable} onChange={(e) => setButton(index, { ...button, text: e.target.value })} data-testid={`input-draft-button-text-${index}`} />
                    </Field>
                    {button.type === "url" ? (
                      <div className="space-y-2">
                        <Field label="URL" errors={errorFor(`buttons.${index}.url`)} hint="Optionally end with {{1}} for a per-message value.">
                          <Input value={button.url ?? ""} disabled={!editable} onChange={(e) => setButton(index, { ...button, url: e.target.value })} data-testid={`input-draft-button-url-${index}`} />
                        </Field>
                        {variableNumbers(button.url ?? "").length ? (
                          <Field label="Example for {{1}}" errors={errorFor(`buttons.${index}.example`)}>
                            <Input value={button.example ?? ""} disabled={!editable} onChange={(e) => setButton(index, { ...button, example: e.target.value })} data-testid={`input-draft-button-example-${index}`} />
                          </Field>
                        ) : null}
                      </div>
                    ) : button.type === "phone" ? (
                      <Field label="Phone number" errors={errorFor(`buttons.${index}.phoneNumber`)} hint="International format, e.g. +15550000001">
                        <Input value={button.phoneNumber ?? ""} disabled={!editable} onChange={(e) => setButton(index, { ...button, phoneNumber: e.target.value })} data-testid={`input-draft-button-phone-${index}`} />
                      </Field>
                    ) : <div />}
                    <Button type="button" variant="ghost" size="icon" className="self-end" disabled={!editable} onClick={() => setContent({ buttons: form.content.buttons.filter((_, i) => i !== index) })} aria-label="Remove button" data-testid={`button-draft-remove-button-${index}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </section>
            </div>

            <aside className="space-y-4">
              <div>
                <Label className="text-sm font-semibold">Preview</Label>
                <p className="text-xs text-muted-foreground">As Meta will see it. Media headers show their kind only.</p>
              </div>
              <TemplatePreview components={previewComponents} emptyBodyHint="Start with the body text." data-testid="draft-preview" />
              {bodyVariables.length || headerVariables.length ? (
                <div>
                  <Label className="text-xs text-muted-foreground">With your examples</Label>
                  <TemplatePreview components={previewWithExamples} data-testid="draft-preview-examples" />
                </div>
              ) : null}
            </aside>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {current?.lastError ? <span className="text-destructive" data-testid="text-draft-last-error">{current.lastError}</span> : "Saving keeps the draft in Wabista. Submitting sends it to Meta for review."}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)} data-testid="button-draft-close">Close</Button>
            {editable && !isMobile ? (
              <>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => void onSave()} data-testid="button-draft-save">
                  {create.isPending || update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save draft
                </Button>
                <Button type="button" className="gap-2" disabled={busy || !form.wabaId} title={form.wabaId ? undefined : "Choose a business account first."} onClick={() => void onSubmit()} data-testid="button-draft-submit">
                  {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Submit to Meta
                </Button>
              </>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, errors, hint, counter, children }: { label: string; errors: string[]; hint?: string; counter?: [number, number]; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        {counter ? <span className={`text-[11px] ${counter[0] > counter[1] ? "text-destructive" : "text-muted-foreground"}`}>{counter[0]}/{counter[1]}</span> : null}
      </div>
      {children}
      {errors.map((message) => <p key={message} className="text-xs text-destructive" data-testid="text-field-error">{message}</p>)}
      {!errors.length && hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
