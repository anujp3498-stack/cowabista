// Client-side half of replay-safe Draft creation (V2-05A). The server
// replays a create that reuses an organization's `creationKey`; this module
// decides which key a visit to /campaigns/new sends and when it is retired.
//
// The key is retired only once the stable /campaigns/:id/audience route has
// mounted for the campaign that key created. Clearing it right after a
// successful create left a window: if the tab reloaded or crashed after the
// API answered but before navigation finished, /campaigns/new minted a new
// key and created a second Draft. Now a reload in that window resends the
// same key and the server returns the same Draft.
//
// Dependency-free on purpose (storage and id generator are injected) so it
// runs under Node's test runner without a browser.

export type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export const NEW_CAMPAIGN_KEY_STORAGE = "wabista:new-campaign-key"

type Stored = { key: string; campaignId: number | null }

function parse(raw: string | null): Stored | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<Stored>
    if (typeof value.key === "string" && value.key) {
      return { key: value.key, campaignId: typeof value.campaignId === "number" ? value.campaignId : null }
    }
  } catch {
    // Older builds stored the bare key string.
    return { key: raw, campaignId: null }
  }
  return null
}

export function createNewCampaignKeyStore(storage: () => KeyStorage | null, newId: () => string) {
  const read = (): Stored | null => {
    try { return parse(storage()?.getItem(NEW_CAMPAIGN_KEY_STORAGE) ?? null) } catch { return null }
  }
  const write = (value: Stored) => {
    try { storage()?.setItem(NEW_CAMPAIGN_KEY_STORAGE, JSON.stringify(value)) } catch { /* storage unavailable */ }
  }
  return {
    /** The key for this /campaigns/new visit: the pending one if any, else a fresh one (persisted first). */
    keyForCreate(): string {
      const existing = read()
      if (existing) return existing.key
      const created = { key: newId(), campaignId: null }
      write(created)
      return created.key
    },
    /** The server answered with this campaign; keep the key until its Audience route mounts. */
    recordCreated(key: string, campaignId: number) {
      const existing = read()
      if (existing && existing.key !== key) return
      write({ key, campaignId })
    },
    /** Called when /campaigns/:id/audience has mounted for a loaded campaign. Retires the key it created. */
    settleOnAudienceMounted(campaignId: number): boolean {
      const existing = read()
      if (!existing || existing.campaignId !== campaignId) return false
      try { storage()?.removeItem(NEW_CAMPAIGN_KEY_STORAGE) } catch { /* storage unavailable */ }
      return true
    },
    pending(): Stored | null {
      return read()
    },
  }
}

export const newCampaignKeys = createNewCampaignKeyStore(
  () => (typeof sessionStorage === "undefined" ? null : sessionStorage),
  () => crypto.randomUUID(),
)
