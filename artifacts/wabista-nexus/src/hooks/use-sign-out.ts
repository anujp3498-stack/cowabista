import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { authClient } from "@/lib/auth-client"

/**
 * Signs out (the server deletes the session and expires the session and active-workspace cookies), then
 * forgets everything cached for this user in the tab and reloads at `redirectTo` (an app path, default the
 * app root). Local state is cleared
 * even if the request fails, so a shared computer never keeps the previous user's data on screen.
 */
export function useSignOut() {
  const queryClient = useQueryClient()
  return useCallback(async (redirectTo?: string) => {
    try {
      await authClient.signOut()
    } finally {
      queryClient.clear()
      try {
        for (const key of Object.keys(window.sessionStorage)) {
          if (key.startsWith("wabista:")) window.sessionStorage.removeItem(key)
        }
      } catch {
        // Storage can be unavailable (privacy mode); nothing to clear then.
      }
      const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")
      window.location.assign(`${basePath}${redirectTo ?? ""}` || "/")
    }
  }, [queryClient])
}
