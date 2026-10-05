// Render harness for the V2-04 compatibility UI, the V2-05A Audience,
// V2-05B Message, V2-06B Delivery and V2-06C Review workspaces (not shipped). Mounts the
// REAL components against a QueryClient; the Playwright script mocks the
// API routes. Used only by test/harness/render-check.mjs.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./harness.css"
import { RocketSetupDialog } from "../../src/pages/rocket-campaigns"
import { TemplatePreviewDialog } from "../../src/components/templates/template-preview-dialog"
import { CompatibilityMatrix } from "../../src/components/campaigns/compatibility-matrix"
import { AudienceWorkspace } from "../../src/pages/campaign-audience"
import { MessageWorkspace } from "../../src/pages/campaign-message"
import { DeliveryWorkspace } from "../../src/pages/campaign-delivery"
import { ReviewWorkspace } from "../../src/pages/campaign-review"
import { Toaster } from "../../src/components/ui/toaster"
import type { Campaign, Template, WhatsAppCompatibility } from "@workspace/api-client-react"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const view = new URLSearchParams(window.location.search).get("view") ?? "matrix"

const matrixFixture: WhatsAppCompatibility = {
  evaluatedAt: new Date().toISOString(),
  numbers: [
    { phoneNumberId: 1, phone: "+15550000001", displayName: "Phone X", wabaId: 10, wabaExternalId: "waba-x", transport: "workspace_credential", eligibleTemplateIds: [101], code: "eligible" },
    { phoneNumberId: 2, phone: "+15550000002", displayName: "Phone Y", wabaId: 11, wabaExternalId: "waba-y", transport: "workspace_credential", eligibleTemplateIds: [], code: "eligible" },
  ],
  templates: [
    { templateId: 101, name: "tx1", language: "en_US", wabaId: 10, wabaExternalId: "waba-x", eligiblePhoneNumberIds: [1], evidence: { source: "workspace_credential", verifiedAt: "2026-10-01T00:00:00Z" }, code: "eligible" },
    { templateId: 103, name: "tz1", language: "en_US", wabaId: 12, wabaExternalId: "waba-z", eligiblePhoneNumberIds: [], evidence: { source: "backfill", verifiedAt: "2026-09-01T00:00:00Z" }, code: "waba_mismatch" },
  ],
  incompatiblePairs: [
    { phoneNumberId: 2, templateId: 101, code: "waba_mismatch", message: "The number and the template belong to different WhatsApp Business Accounts" },
    { phoneNumberId: 1, templateId: 103, code: "waba_mismatch", message: "The number and the template belong to different WhatsApp Business Accounts" },
    { phoneNumberId: 2, templateId: 103, code: "waba_mismatch", message: "The number and the template belong to different WhatsApp Business Accounts" },
  ],
  numbersWithoutTemplate: [2],
  templatesWithoutNumber: [103],
}

const template: Template = {
  id: 101, organizationId: 1, wabaId: 10, providerTemplateId: "tpl-101", name: "tx1", category: "Marketing", language: "en_US", status: "Approved",
  body: "Hello {{1}}", components: [{ type: "BODY", text: "Hello {{1}}" }], metadata: {}, isSample: false, lastSyncedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", wabaExternalId: "waba-x", wabaDisplayName: "WABA X", source: "workspace_credential", providerStatus: "APPROVED", providerMissing: false,
} as Template

const audienceCampaign: Campaign = {
  id: 7, name: "Untitled campaign", status: "Draft", audienceSize: 0, sent: 0, delivered: 0, read: 0, failed: 0,
  schedule: "Unscheduled", routesCount: 0, isSample: false, creationKey: "k", revision: 0, audienceGeneration: 0,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
}

function Harness() {
  if (view === "review") {
    return (
      <div className="mx-auto max-w-5xl p-4">
        <ReviewWorkspace campaign={{ ...audienceCampaign, name: "Spring launch" }} organizationId={1} />
        <Toaster />
      </div>
    )
  }
  if (view === "delivery") {
    const status = new URLSearchParams(window.location.search).get("status") ?? "Draft"
    return (
      <div className="mx-auto max-w-5xl p-4">
        <DeliveryWorkspace campaign={{ ...audienceCampaign, name: "Spring launch", status: status as Campaign["status"] }} organizationId={1} />
        <Toaster />
      </div>
    )
  }
  if (view === "message") {
    const status = new URLSearchParams(window.location.search).get("status") ?? "Draft"
    return (
      <div className="mx-auto max-w-5xl p-4">
        <MessageWorkspace campaign={{ ...audienceCampaign, name: "Spring launch", status: status as Campaign["status"] }} organizationId={1} />
        <Toaster />
      </div>
    )
  }
  if (view === "audience") {
    const status = new URLSearchParams(window.location.search).get("status") ?? "Draft"
    return (
      <div className="mx-auto max-w-5xl p-4">
        <AudienceWorkspace campaign={{ ...audienceCampaign, status: status as Campaign["status"] }} organizationId={1} />
        <Toaster />
      </div>
    )
  }
  if (view === "rocket") return <RocketSetupDialog open onOpenChange={() => undefined} onSubmit={() => undefined} isSubmitting={false} />
  if (view === "template") return <TemplatePreviewDialog template={template} onOpenChange={() => undefined} />
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <section><h2 className="mb-2 text-sm font-semibold">Problems</h2><CompatibilityMatrix data={matrixFixture} isLoading={false} isError={false} /></section>
      <section><h2 className="mb-2 text-sm font-semibold">All good</h2><CompatibilityMatrix data={{ ...matrixFixture, templates: [matrixFixture.templates[0]], numbers: [matrixFixture.numbers[0]], incompatiblePairs: [], numbersWithoutTemplate: [], templatesWithoutNumber: [] }} isLoading={false} isError={false} data-testid="matrix-ok" /></section>
      <section><h2 className="mb-2 text-sm font-semibold">Loading</h2><CompatibilityMatrix data={undefined} isLoading isError={false} data-testid="matrix-loading" /></section>
      <section><h2 className="mb-2 text-sm font-semibold">Error</h2><CompatibilityMatrix data={undefined} isLoading={false} isError data-testid="matrix-error" /></section>
      <section><h2 className="mb-2 text-sm font-semibold">Empty</h2><CompatibilityMatrix data={undefined} isLoading={false} isError={false} data-testid="matrix-empty" /></section>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>
  </StrictMode>,
)
