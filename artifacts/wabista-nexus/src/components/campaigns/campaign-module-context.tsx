import { createContext, useContext, type ComponentType, type ReactNode } from "react"
import { Redirect } from "wouter"
import {
  CAMPAIGN_MODULES,
  moduleRedirect,
  type CampaignModule,
  type CampaignModuleInfo,
  type CampaignStepKey,
} from "@/lib/campaign-module"

// The module (Normal or Rocket) a campaign page was opened under. App.tsx
// mounts every shared campaign page once per module; pages read the module
// from here to build their links, and CampaignModuleGuard sends a campaign
// opened under the wrong module (or at a step its module does not have) to
// its own page.

const CampaignModuleContext = createContext<CampaignModule>("standard")

export function CampaignModuleProvider({ module, children }: { module: CampaignModule; children: ReactNode }) {
  return <CampaignModuleContext.Provider value={module}>{children}</CampaignModuleContext.Provider>
}

export function useCampaignModule(): CampaignModuleInfo {
  return CAMPAIGN_MODULES[useContext(CampaignModuleContext)]
}

/** A route component that renders `Page` under `module`. */
export function inCampaignModule<P extends object>(module: CampaignModule, Page: ComponentType<P>) {
  function ModulePage(props: P) {
    return (
      <CampaignModuleProvider module={module}>
        <Page {...props} />
      </CampaignModuleProvider>
    )
  }
  ModulePage.displayName = `${module}(${Page.displayName ?? Page.name ?? "Page"})`
  return ModulePage
}

/** Renders children only when the campaign belongs to this page's module and step; otherwise redirects there. */
export function CampaignModuleGuard({ campaign, step, children }: { campaign: { id: number; campaignType?: string | null }; step: CampaignStepKey | null; children: ReactNode }) {
  const { module } = useCampaignModule()
  const target = moduleRedirect(module, campaign, step)
  if (target) return <Redirect to={target} replace />
  return <>{children}</>
}
