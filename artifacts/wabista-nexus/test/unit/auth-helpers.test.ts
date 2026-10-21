// Better Auth sign-in helpers: `?next=` stays inside the app, and auth errors become readable copy.
// Run: node --experimental-strip-types --test test/unit/auth-helpers.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { safeNextPath } from "../../src/lib/safe-next.ts"
import { authErrorMessage, MIN_PASSWORD_LENGTH } from "../../src/lib/auth-errors.ts"

test("safeNextPath keeps in-app paths and drops everything that could leave the app", () => {
  for (const ok of ["/overview", "/campaigns/12/review", "/campaigns?status=Running", "/"]) assert.equal(safeNextPath(ok), ok)
  for (const bad of [null, undefined, "", "overview", "//evil.example", "/\\evil.example", "https://evil.example/x", "javascript:alert(1)", "/a\nb", "/a\\b", `/${"x".repeat(2048)}`]) {
    assert.equal(safeNextPath(bad), null, String(bad))
  }
})

test("authErrorMessage maps Better Auth codes and rate limiting to plain copy, unknown codes to a generic line", () => {
  assert.equal(authErrorMessage({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }), "Email or password is incorrect.")
  assert.match(authErrorMessage({ status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" }), /already exists/)
  assert.match(authErrorMessage({ status: 400, code: "PASSWORD_TOO_SHORT" }), new RegExp(`${MIN_PASSWORD_LENGTH} characters`))
  assert.match(authErrorMessage({ status: 429 }), /Too many attempts/)
  assert.equal(authErrorMessage({ status: 403, code: "INVALID_ORIGIN", message: "Invalid origin" }), "Something went wrong. Please try again.")
  assert.equal(authErrorMessage(null, "fallback"), "fallback")
  assert.equal(MIN_PASSWORD_LENGTH, 12)
})
