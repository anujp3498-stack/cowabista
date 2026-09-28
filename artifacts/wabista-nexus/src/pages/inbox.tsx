import { Link } from "wouter"
import { MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader } from "@/components/app"

// Honest placeholder: this area is not implemented in the current V2
// milestone. It shows no sample records and no controls that do nothing.
export default function Inbox() {
  return (
    <div className="space-y-6">
      <PageHeader title="Smart Inbox" description="Not available in this release." />
      <EmptyState
        size="page"
        icon={MessageSquare}
        title="Smart Inbox is being rebuilt around real WhatsApp conversations. No sample chats are shown."
        description="Conversations from your connected numbers will appear here once the real inbox is connected in a later release."
        primaryAction={
          <Button asChild variant="outline">
            <Link href="/phone-numbers" data-testid="link-inbox-numbers">View numbers</Link>
          </Button>
        }
        data-testid="empty-inbox"
      />
    </div>
  )
}
