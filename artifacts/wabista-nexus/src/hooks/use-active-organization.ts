import { useListOrganizations, type Organization } from "@workspace/api-client-react"

// Single source of truth for "which workspace is active" on the client.
//
// The server resolves the active organization from the
// `wabista_active_org_id` cookie on every request, so this hook only mirrors
// that decision for display and for passing `organizationId` to org-scoped
// endpoints. It deliberately keeps the exact lookup rule every page used
// before (`isActive`, falling back to the first membership) so behaviour is
// unchanged. Switching workspaces must still do a full page reload after
// activation (see .agents/memory/org-switch-stale-cache.md); this hook does
// not attempt to keep cached data fresh across a switch.
export function useActiveOrganization() {
  const query = useListOrganizations()
  const organizations = query.data
  const organization: Organization | undefined =
    organizations?.find((org) => org.isActive) ?? organizations?.[0]

  return {
    organization,
    organizationId: organization?.id,
    role: organization?.role,
    organizations,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  }
}
