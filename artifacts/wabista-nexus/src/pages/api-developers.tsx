import { Link } from "wouter"
import { Code } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader } from "@/components/app"

// Honest placeholder: this area is not implemented in the current V2
// milestone. It shows no sample records and no controls that do nothing.
export default function ApiDevelopers() {
  return (
    <div className="space-y-6">
      <PageHeader title="API & Webhooks" description="Not available in this release." />
      <EmptyState
        size="page"
        icon={Code}
        title="Developer API management is not available in this release yet."
        description="API keys and outbound webhooks will be managed here in a later release."
        primaryAction={
          <Button asChild variant="outline">
            <Link href="/settings" data-testid="link-api-settings">Workspace settings</Link>
          </Button>
        }
        data-testid="empty-api-developers"
      />
    </div>
  )
}
