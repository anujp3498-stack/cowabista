import { useState } from "react"
import { Link, useLocation } from "wouter"
import { useClerk } from "@clerk/react"
import { LogOut, MoreHorizontal } from "lucide-react"
import type { OrganizationRole } from "@workspace/api-client-react"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { useGetCurrentUser } from "@workspace/api-client-react"
import { useActiveOrganization } from "@/hooks/use-active-organization"
import { isNavItemActive, MOBILE_PRIMARY_HREFS, ROLE_LABELS, visibleNavGroups, type NavItem } from "./navigation"

// Bottom tab bar for small screens: four frequent destinations plus "More",
// which opens a sheet with every other real destination and the account
// area. Replaces the squeezed desktop sidebar that used to slide in.
export function MobileNav({ role }: { role: OrganizationRole | undefined }) {
  const [location] = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const groups = visibleNavGroups(role)
  const allItems = groups.flatMap((group) => group.items)
  const primary = MOBILE_PRIMARY_HREFS.map((href) => allItems.find((item) => item.href === href)).filter(
    (item): item is NavItem => Boolean(item),
  )
  const primaryHrefs = new Set(primary.map((item) => item.href))
  const moreGroups = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !primaryHrefs.has(item.href)) }))
    .filter((group) => group.items.length > 0)
  const moreActive = moreGroups.some((group) => group.items.some((item) => isNavItemActive(item, location)))

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {primary.map((item) => {
          const active = isNavItemActive(item, location)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              data-testid={`mobile-${item.testId}`}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More navigation and account"
          aria-haspopup="dialog"
          data-testid="button-mobile-more"
          className={cn(
            "flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium",
            moreActive ? "text-primary" : "text-muted-foreground",
          )}
        >
          <MoreHorizontal className="h-5 w-5" />
          More
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-xl px-4 pb-8 pt-4">
          <SheetHeader className="text-left">
            <SheetTitle>More</SheetTitle>
            <SheetDescription className="sr-only">Other destinations and your account</SheetDescription>
          </SheetHeader>
          <div className="mt-2 space-y-5">
            {moreGroups.map((group) => (
              <div key={group.label}>
                <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {group.items.map((item) => {
                    const active = isNavItemActive(item, location)
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        aria-current={active ? "page" : undefined}
                        data-testid={`more-${item.testId}`}
                        className={cn(
                          "flex min-h-12 items-center gap-3 rounded-md border px-3 text-sm font-medium",
                          active ? "border-primary/40 bg-primary/5 text-primary" : "bg-card text-foreground",
                        )}
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        {item.label}
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
            <MobileAccount onNavigate={() => setMoreOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function MobileAccount({ onNavigate }: { onNavigate: () => void }) {
  const { data: currentUser } = useGetCurrentUser()
  const { organization, role } = useActiveOrganization()
  const { signOut } = useClerk()
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

  return (
    <div className="rounded-md border bg-card p-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Account</div>
      <div className="truncate text-sm font-medium">{currentUser?.name ?? "…"}</div>
      <div className="truncate text-xs text-muted-foreground">{currentUser?.email ?? ""}</div>
      <div className="mt-2 text-xs text-muted-foreground">
        {organization ? (
          <>
            {organization.name}
            {role ? ` · ${ROLE_LABELS[role]}` : ""}
          </>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        className="mt-3 w-full gap-2"
        data-testid="button-sign-out-mobile"
        onClick={() => {
          onNavigate()
          void signOut({ redirectUrl: basePath || "/" })
        }}
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </Button>
    </div>
  )
}
