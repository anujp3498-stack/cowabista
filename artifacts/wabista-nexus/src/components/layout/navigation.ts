import type { ComponentType } from "react"
import {
  BarChart3,
  Building2,
  FileText,
  Home,
  Phone,
  Plug,
  Send,
  ShieldCheck,
  ShieldOff,
  Users,
} from "lucide-react"
import type { OrganizationRole } from "@workspace/api-client-react"

// V2 information architecture for the shell. Only destinations that are
// real today are listed; future areas (Smart Inbox, Automations, Flows,
// Segments, Meta Health, Exports, API & Webhooks, Billing, White Label) are
// intentionally absent until their milestones make them real. Labels are the
// V2 names; hrefs stay on the existing routes so nothing is migrated yet.

export type NavItem = {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  /** Roles that can meaningfully use the destination. Omit for everyone. */
  roles?: OrganizationRole[]
  /** Extra paths that should mark this item active. */
  matchPaths?: string[]
  testId: string
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

const ADMIN_ROLES: OrganizationRole[] = ["owner", "admin"]

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Home",
    items: [{ label: "Home", href: "/overview", icon: Home, matchPaths: ["/"], testId: "link-nav-home" }],
  },
  {
    label: "Messaging",
    items: [
      { label: "Campaigns", href: "/campaigns", icon: Send, matchPaths: ["/rocket-campaigns"], testId: "link-nav-campaigns" },
      { label: "Contacts", href: "/contacts", icon: Users, matchPaths: ["/suppressions"], testId: "link-nav-contacts" },
      { label: "Do not contact", href: "/suppressions", icon: ShieldOff, testId: "link-nav-do-not-contact" },
    ],
  },
  {
    label: "WhatsApp",
    items: [
      { label: "Numbers", href: "/phone-numbers", icon: Phone, testId: "link-nav-numbers" },
      { label: "Templates", href: "/templates", icon: FileText, testId: "link-nav-templates" },
      // The connection page is admin-gated on the backend (403 otherwise).
      { label: "Connection", href: "/integrations", icon: Plug, roles: ADMIN_ROLES, testId: "link-nav-connection" },
    ],
  },
  {
    label: "Insights",
    items: [{ label: "Analytics", href: "/analytics", icon: BarChart3, testId: "link-nav-analytics" }],
  },
  {
    label: "Settings",
    items: [
      { label: "Workspace", href: "/settings", icon: Building2, testId: "link-nav-workspace" },
      { label: "Team & Roles", href: "/team-roles", icon: ShieldCheck, testId: "link-nav-team-roles" },
    ],
  },
]

// Bottom tab bar on small screens: a few frequent destinations plus "More".
export const MOBILE_PRIMARY_HREFS = ["/overview", "/campaigns", "/contacts", "/phone-numbers"]

export function canSeeNavItem(item: NavItem, role: OrganizationRole | undefined): boolean {
  if (!item.roles) return true
  return role !== undefined && item.roles.includes(role)
}

export function visibleNavGroups(role: OrganizationRole | undefined): NavGroup[] {
  return NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => canSeeNavItem(item, role)) })).filter(
    (group) => group.items.length > 0,
  )
}

export function isNavItemActive(item: NavItem, location: string): boolean {
  if (location === item.href) return true
  return (item.matchPaths ?? []).some((path) => location === path)
}

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  agent: "Agent",
}
