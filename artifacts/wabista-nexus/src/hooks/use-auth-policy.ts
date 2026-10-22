import { useQuery } from "@tanstack/react-query"
import { fetchAuthPolicy } from "@/lib/auth-policy"

/** True only once the API has said public sign-up is open; false while loading, on error, and when closed. */
export function usePublicSignUp(): boolean {
  const { data } = useQuery({ queryKey: ["auth-policy"], queryFn: fetchAuthPolicy, staleTime: 5 * 60_000, retry: 1 })
  return data?.publicSignUp === true
}
