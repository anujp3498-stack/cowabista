// Session gate decisions (src/lib/session-view.ts).
// Run: node --experimental-strip-types --test test/unit/session-view.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { sessionView } from "../../src/lib/session-view.ts"

test("a session wins; pending is loading; a 401 or no error is signed out; any other failure is unavailable", () => {
  assert.equal(sessionView({ hasSession: true, isPending: false, error: null }), "signed-in")
  assert.equal(sessionView({ hasSession: true, isPending: false, error: { status: 500 } }), "signed-in", "a refetch failure keeps the known session")
  assert.equal(sessionView({ hasSession: false, isPending: true, error: null }), "loading")
  assert.equal(sessionView({ hasSession: false, isPending: false, error: null }), "signed-out")
  assert.equal(sessionView({ hasSession: false, isPending: false, error: { status: 401 } }), "signed-out")
  for (const status of [500, 502, 503, 429, undefined]) {
    assert.equal(sessionView({ hasSession: false, isPending: false, error: { status } }), "unavailable", String(status))
  }
})
