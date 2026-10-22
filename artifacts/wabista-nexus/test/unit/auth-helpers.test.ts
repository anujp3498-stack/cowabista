// Better Auth sign-in helpers: `?next=` stays inside the app, auth errors become readable copy, the sign-up
// policy fails closed, and the change-password form checks what the server will check.
// Run: node --experimental-strip-types --test test/unit/auth-helpers.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { safeNextPath } from "../../src/lib/safe-next.ts"
import { authErrorMessage, changePasswordProblem, MIN_PASSWORD_LENGTH } from "../../src/lib/auth-errors.ts"
import { parseAuthPolicy } from "../../src/lib/auth-policy.ts"

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

test("authErrorMessage covers change-password and closed sign-up", () => {
  assert.equal(authErrorMessage({ status: 400, code: "INVALID_PASSWORD" }), "Your current password is incorrect.")
  assert.match(authErrorMessage({ status: 400, code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" }), /administrator/)
  assert.match(authErrorMessage({ status: 404, code: "NOT_FOUND" }), /Something went wrong/)
})

test("parseAuthPolicy fails closed: only an explicit { publicSignUp: true } opens sign-up", () => {
  assert.deepEqual(parseAuthPolicy({ publicSignUp: true }), { publicSignUp: true })
  for (const closed of [{ publicSignUp: false }, { publicSignUp: "true" }, { publicSignUp: 1 }, {}, null, undefined, "open", [true]]) {
    assert.deepEqual(parseAuthPolicy(closed), { publicSignUp: false }, JSON.stringify(closed))
  }
})

test("changePasswordProblem: 12 to 128 characters, confirmed, different from the current one", () => {
  const current = "current-password-1"
  const next = "brand-new-password"
  assert.equal(changePasswordProblem({ current, next, confirm: next }), null)
  assert.match(changePasswordProblem({ current: "", next, confirm: next }) ?? "", /current password/)
  assert.match(changePasswordProblem({ current, next: "a1b2c3d4e5f", confirm: "a1b2c3d4e5f" }) ?? "", new RegExp(`${MIN_PASSWORD_LENGTH} characters`))
  assert.match(changePasswordProblem({ current, next: "x".repeat(129), confirm: "x".repeat(129) }) ?? "", /128/)
  assert.match(changePasswordProblem({ current, next, confirm: `${next}x` }) ?? "", /do not match/)
  assert.match(changePasswordProblem({ current, next: current, confirm: current }) ?? "", /different/)
})
