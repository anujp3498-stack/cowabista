// Turns a Better Auth client error ({ status, code, message }) into copy a business user can act on. Codes
// come from better-auth 1.7.10 plus this app's own sign-up hook (INVALID_NAME); anything unknown gets a
// generic line, never a raw server message about origins or internals. changePasswordProblem checks the
// change-password form the way the server will.
export type AuthClientError = { status?: number; code?: string; message?: string } | null | undefined

export const MIN_PASSWORD_LENGTH = 12

export function authErrorMessage(error: AuthClientError, fallback = "Something went wrong. Please try again."): string {
  if (!error) return fallback
  if (error.status === 429) return "Too many attempts. Wait a few seconds and try again."
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "Email or password is incorrect."
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
    case "USER_ALREADY_EXISTS":
      return "An account with this email already exists. Sign in instead."
    case "PASSWORD_TOO_SHORT":
      return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`
    case "PASSWORD_TOO_LONG":
      return `Use at most ${MAX_PASSWORD_LENGTH} characters for your password.`
    case "INVALID_EMAIL":
      return "Enter a valid email address."
    case "INVALID_NAME":
      return "Enter your name (1 to 100 characters)."
    case "INVALID_PASSWORD":
      return "Your current password is incorrect."
    case "EMAIL_PASSWORD_SIGN_UP_DISABLED":
      return "New accounts are created by your administrator. Ask them for an account."
    default:
      return fallback
  }
}

export const MAX_PASSWORD_LENGTH = 128

/** The first problem with a change-password form, or null when it can be sent. */
export function changePasswordProblem({ current, next, confirm }: { current: string; next: string; confirm: string }): string | null {
  if (!current) return "Enter your current password."
  if (next.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters for your new password.`
  if (next.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters for your new password.`
  if (next !== confirm) return "The new passwords do not match."
  if (next === current) return "Choose a password different from your current one."
  return null
}
