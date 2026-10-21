import { createAuthClient } from "better-auth/react"

// Better Auth (email and password). The API, and Better Auth under it, always live at /api on the SPA's own
// origin (the reverse proxy in production, the Vite /api proxy in development), even when BASE_PATH is not
// "/". Cookies are first-party and HttpOnly; nothing here needs a VITE_* variable.
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
})
