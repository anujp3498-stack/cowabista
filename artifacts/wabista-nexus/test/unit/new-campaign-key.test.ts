// Regression for the V2-05A creation window: a reload after the create
// succeeded but before the Audience route mounted must replay the same
// Draft; once that route mounts, a later /campaigns/new must create a new one.
// Run: node --experimental-strip-types --test test/unit/new-campaign-key.test.ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { createNewCampaignKeyStore, type KeyStorage } from "../../src/lib/new-campaign-key.ts"

function memoryStorage(): KeyStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
  }
}

// Mirrors the server contract: (organization, creationKey) is unique and a
// repeated key returns the existing Draft.
function fakeServer() {
  const byKey = new Map<string, number>()
  let nextId = 100
  return {
    create(key: string): { id: number; replayed: boolean } {
      const existing = byKey.get(key)
      if (existing) return { id: existing, replayed: true }
      const id = nextId++
      byKey.set(key, id)
      return { id, replayed: false }
    },
    drafts: () => byKey.size,
  }
}

test("a reload between a successful create and the Audience mount replays the same Draft; the mount retires the key", () => {
  const storage = memoryStorage()
  let ids = 0
  const server = fakeServer()
  // Each "page load" builds its own store over the same tab storage.
  const load = () => createNewCampaignKeyStore(() => storage, () => `key-${++ids}`)

  // 1-2. /campaigns/new, the create succeeds.
  const first = load()
  const key = first.keyForCreate()
  const created = server.create(key)
  first.recordCreated(key, created.id)
  // 3-4. Navigation never completes: the tab reloads on /campaigns/new.
  const reloaded = load()
  // 5. The same key is reused...
  assert.equal(reloaded.keyForCreate(), key)
  // 6. ...so the server returns the same Draft.
  const replay = server.create(reloaded.keyForCreate())
  assert.equal(replay.id, created.id)
  assert.equal(replay.replayed, true)
  assert.equal(server.drafts(), 1)
  // An unrelated campaign's Audience page does not retire this key.
  assert.equal(reloaded.settleOnAudienceMounted(999), false)
  assert.equal(reloaded.pending()?.key, key)
  // 7-8. The stable Audience route mounts for that Draft: key cleared.
  const audience = load()
  assert.equal(audience.settleOnAudienceMounted(created.id), true)
  assert.equal(audience.pending(), null)
  // 9. A later, intentional /campaigns/new gets a new key and a new Draft.
  const later = load()
  const laterKey = later.keyForCreate()
  assert.notEqual(laterKey, key)
  const second = server.create(laterKey)
  assert.notEqual(second.id, created.id)
  assert.equal(server.drafts(), 2)
})

test("a failed create keeps the key for the retry; a legacy bare-string key is still honoured", () => {
  const storage = memoryStorage()
  const store = createNewCampaignKeyStore(() => storage, () => "fresh")
  const key = store.keyForCreate()
  // The request failed before an answer: nothing recorded, retry reuses it.
  assert.equal(store.keyForCreate(), key)
  storage.setItem("wabista:new-campaign-key", "legacy-key")
  assert.equal(store.keyForCreate(), "legacy-key")
})

test("without storage every visit gets a fresh key and nothing throws", () => {
  let n = 0
  const store = createNewCampaignKeyStore(() => null, () => `k${++n}`)
  assert.equal(store.keyForCreate(), "k1")
  assert.equal(store.keyForCreate(), "k2")
  assert.equal(store.settleOnAudienceMounted(1), false)
})
