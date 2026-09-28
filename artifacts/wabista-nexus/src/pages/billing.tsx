import { Link } from "wouter"
import { CreditCard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader } from "@/components/app"

// Honest placeholder: this area is not implemented in the current V2
// milestone. It shows no sample records and no controls that do nothing.
export default function Billing() {
  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Not available in this release." />
      <EmptyState
        size="page"
        icon={CreditCard}
        title="Billing is not available in this release yet."
        description="Plans, usage and invoices will be shown here once billing is connected."
        primaryAction={
          <Button asChild variant="outline">
            <Link href="/settings" data-testid="link-billing-settings">Workspace settings</Link>
          </Button>
        }
        data-testid="empty-billing"
      />
    </div>
  )
}
