import { useState, type ReactNode } from "react"
import { Link, useLocation } from "wouter"
import { useClerk } from "@clerk/react"
import { useQueryClient } from "@tanstack/react-query"
import {
  LayoutDashboard,
  Send,
  Rocket,
  Users,
  Phone,
  FileText,
  Inbox as InboxIcon,
  Zap,
  BarChart3,
  Code,
  CreditCard,
  ShieldCheck,
  Settings,
  Bell,
  Search,
  ChevronDown,
  Menu,
  Check,
  LogOut,
  Plus,
  Plug,
  ShieldOff,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  useActivateOrganization,
  useGetCurrentUser,
  useListOrganizations,
} from "@workspace/api-client-react"
import { useToast } from "@/hooks/use-toast"

const navItems = [
  { name: "Overview", href: "/overview", icon: LayoutDashboard },
  { name: "Campaigns", href: "/campaigns", icon: Send },
  { name: "Rocket Engine", href: "/rocket-campaigns", icon: Rocket, isFeature: true },
  { name: "Contacts", href: "/contacts", icon: Users },
  { name: "Do-Not-Contact", href: "/suppressions", icon: ShieldOff },
  { name: "Phone Numbers", href: "/phone-numbers", icon: Phone },
  { name: "Templates", href: "/templates", icon: FileText },
  { name: "Inbox", href: "/inbox", icon: InboxIcon },
  { name: "Automations", href: "/automations", icon: Zap },
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
]

const adminItems = [
  { name: "API & Webhooks", href: "/api-developers", icon: Code },
  { name: "Integrations", href: "/integrations", icon: Plug },
  { name: "Billing", href: "/billing", icon: CreditCard },
  { name: "Team Roles", href: "/team-roles", icon: ShieldCheck },
  { name: "Settings", href: "/settings", icon: Settings },
]

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation()

  return (
    <>
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-foreground">
            <Rocket className="h-4 w-4" />
          </div>
          Wabista Nexus
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        <nav className="grid gap-1 px-2">
          <div className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Operations
          </div>
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href === "/overview" && location === "/")
            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={onNavigate}
                data-testid={`link-nav-${item.name.toLowerCase().replace(/\s+/g, "-")}`}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <item.icon className={cn("h-4 w-4", item.isFeature && "text-primary")} />
                {item.name}
                {item.isFeature && (
                  <span className="ml-auto flex h-5 items-center rounded-full bg-primary/20 px-2 text-[10px] font-bold text-primary">
                    PRO
                  </span>
                )}
              </Link>
            )
          })}

          <div className="mt-6 px-2 py-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Administration
          </div>
          {adminItems.map((item) => {
            const isActive = location === item.href
            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={onNavigate}
                data-testid={`link-nav-${item.name.toLowerCase().replace(/\s+/g, "-")}`}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </Link>
            )
          })}
        </nav>
      </div>

      <UserCard />
    </>
  )
}

function UserCard() {
  const { data: currentUser } = useGetCurrentUser()
  const { signOut } = useClerk()
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

  const displayName = currentUser?.name ?? "Loading..."
  const initials = currentUser ? getInitials(currentUser.name) : "…"

  return (
    <div className="border-t border-sidebar-border p-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            data-testid="button-user-menu"
            className="flex w-full items-center gap-3 rounded-lg bg-sidebar-accent/30 p-3 text-left hover:bg-sidebar-accent/50 transition-colors"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary font-bold">
              {initials}
            </div>
            <div className="flex flex-col overflow-hidden">
              <span className="truncate text-sm font-medium">{displayName}</span>
              <span className="truncate text-xs text-sidebar-foreground/50">
                {currentUser?.email ?? ""}
              </span>
            </div>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Signed in as {currentUser?.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="button-sign-out"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function WorkspaceSwitcher() {
  const { data: organizations } = useListOrganizations()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const activateOrganization = useActivateOrganization()
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

  const activeOrg = organizations?.find((org) => org.isActive) ?? organizations?.[0]

  const handleSwitch = (organizationId: number) => {
    if (organizationId === activeOrg?.id) return
    activateOrganization.mutate(
      { organizationId },
      {
        onSuccess: () => {
          // Every page's data (members, contacts, campaigns, overview
          // stats, ...) is scoped server-side to the active-org cookie.
          // Clearing the React Query cache alone isn't reliably enough to
          // force every mounted query to re-fetch with the new context, so
          // do a full reload to guarantee a clean state for the whole app.
          queryClient.clear()
          window.location.href = `${basePath || ""}/overview`
        },
        onError: () => {
          toast({
            title: "Couldn't switch workspace",
            description: "Please try again.",
            variant: "destructive",
          })
        },
      }
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-testid="button-workspace-switcher"
          className="flex shrink-0 items-center gap-2 cursor-pointer rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted transition-colors sm:px-3"
        >
          <span className="hidden font-semibold sm:inline">
            {activeOrg?.name ?? "Loading..."}
          </span>
          <span className="font-semibold sm:hidden">
            {activeOrg?.name?.slice(0, 5) ?? "…"}
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {organizations?.map((org) => (
          <DropdownMenuItem
            key={org.id}
            data-testid={`option-workspace-${org.id}`}
            onClick={() => handleSwitch(org.id)}
            className="flex items-center justify-between gap-2"
          >
            <div className="flex flex-col overflow-hidden">
              <span className="truncate text-sm font-medium">{org.name}</span>
              <span className="truncate text-xs text-muted-foreground capitalize">
                {org.role}
              </span>
            </div>
            {org.isActive && <Check className="h-4 w-4 text-primary shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        <NavContent />
      </aside>

      {/* Mobile sidebar (slide-in sheet) */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="flex w-64 max-w-[80vw] flex-col border-sidebar-border bg-sidebar p-0 text-sidebar-foreground [&>button]:text-sidebar-foreground"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <NavContent onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-64">
        {/* Header */}
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur sm:gap-4 sm:px-6">
          <button
            onClick={() => setMobileNavOpen(true)}
            data-testid="button-open-mobile-nav"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-muted transition-colors md:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>

          <WorkspaceSwitcher />

          <div className="ml-auto flex items-center gap-2 sm:gap-4">
            <div className="relative hidden w-40 sm:block md:w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search..."
                data-testid="input-search"
                className="flex h-9 w-full rounded-md border border-input bg-muted/50 px-3 py-1 pl-9 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <button
              data-testid="button-notifications"
              className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-muted transition-colors"
            >
              <Bell className="h-4 w-4" />
              <span className="absolute right-2 top-2 flex h-2 w-2 rounded-full bg-primary"></span>
            </button>
          </div>
        </header>

        {/* Page Content */}
        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-6xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
