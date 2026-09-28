import { Link } from "wouter"
import { Workflow } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader } from "@/components/app"

// Honest placeholder: this area is not implemented in the current V2
// milestone. It shows no sample records and no controls that do nothing.
export default function Automations() {
  return (
    <div className="space-y-6">
      <PageHeader title="Automations" description="Not available in this release." />
      <EmptyState
        size="page"
        icon={Workflow}
        title="Automations will appear here once the real workflow engine is connected."
        description="This release does not include a workflow engine, so no rules are shown."
        primaryAction={
          <Button asChild variant="outline">
            <Link href="/campaigns" data-testid="link-automations-campaigns">Go to campaigns</Link>
          </Button>
        }
        data-testid="empty-automations"
      />
    </div>
  )
}
