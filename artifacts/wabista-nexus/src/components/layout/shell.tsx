import type { ReactNode } from "react"
import { Link, useLocation } from "wouter"
import { useClerk } from "@clerk/react"
import { useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, LogOut, MessageCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useActivateOrganization, useGetCurrentUser } from "@workspace/api-client-react"
import { useToast } from "@/hooks/use-toast"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { MobileNav } from "./mobile-nav"
import { isNavItemActive, ROLE_LABELS, visibleNavGroups } from "./navigation"

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function Brand() {
  return (
    <div className="flex items-center gap-2 font-semibold tracking-tight">
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <MessageCircle className="h-4 w-4" aria-hidden="true" />
      </div>
      <span>Wabista</span>
    </div>
  )
}

function SidebarNav() {
  const [location] = useLocation()
  const { role } = useActiveOrganization()
  const groups = visibleNavGroups(role)

  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
      {groups.map((group) => (
        <div key={group.label} className="mb-5">
          {group.label !== "Home" ? (
            <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
          ) : null}
          <ul className="grid gap-0.5">
            {group.items.map((item) => {
              const active = isNavItemActive(item, location)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    data-testid={item.testId}
                    className={cn(
                      "flex min-h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function UserCard() {
  const { data: currentUser } = useGetCurrentUser()
  const { organization, role } = useActiveOrganization()
  const { signOut } = useClerk()
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

  const displayName = currentUser?.name ?? "Loading..."
  const initials = currentUser ? getInitials(currentUser.name) : "…"

  return (
    <div className="border-t p-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="button-user-menu"
            aria-label="Account menu"
            className="flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-muted"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {initials}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">
                {role ? ROLE_LABELS[role] : ""}
                {role && organization ? " · " : ""}
                {organization?.name ?? ""}
              </span>
            </div>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="font-normal">
            <div className="truncate text-sm font-medium">{currentUser?.name}</div>
            <div className="truncate text-xs text-muted-foreground">{currentUser?.email}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="button-sign-out" onClick={() => signOut({ redirectUrl: basePath || "/" })}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function WorkspaceSwitcher() {
  const { organizations, organization: activeOrg } = useActiveOrganization()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const activateOrganization = useActivateOrganization()
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

  const handleSwitch = (organizationId: number) => {
    if (organizationId === activeOrg?.id) return
    activateOrganization.mutate(
      { organizationId },
      {
        onSuccess: () => {
          // Every page's data is scoped server-side to the active-org cookie.
          // Clearing the React Query cache alone isn't reliably enough to
          // force every mounted query to re-fetch with the new context, so
          // do a full reload to guarantee a clean state for the whole app.
          // See .agents/memory/org-switch-stale-cache.md.
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
      },
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="button-workspace-switcher"
          aria-label="Switch workspace"
          className="flex h-9 max-w-[60vw] shrink-0 items-center gap-2 rounded-md border bg-card px-3 text-sm transition-colors hover:bg-muted sm:max-w-xs"
        >
          <span className="truncate font-medium">{activeOrg?.name ?? "Loading..."}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{org.name}</span>
              <span className="truncate text-xs text-muted-foreground">{ROLE_LABELS[org.role]}</span>
            </div>
            {org.isActive && <Check className="h-4 w-4 shrink-0 text-primary" aria-label="Active workspace" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const { role } = useActiveOrganization()

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r bg-card md:flex">
        <div className="flex h-14 items-center border-b px-4">
          <Brand />
        </div>
        <SidebarNav />
        <UserCard />
      </aside>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
          <div className="md:hidden">
            <Brand />
          </div>
          <div className="ml-auto md:ml-0">
            <WorkspaceSwitcher />
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 pb-24 sm:p-6 md:pb-8 lg:p-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>

      <MobileNav role={role} />
    </div>
  )
}
