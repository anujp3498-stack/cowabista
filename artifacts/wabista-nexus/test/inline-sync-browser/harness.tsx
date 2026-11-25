import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InlineMetaTemplateSync } from '../../src/components/templates/inline-meta-template-sync'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

function Harness() {
  const [refreshed, setRefreshed] = useState(0)
  return (
    <QueryClientProvider client={queryClient}>
      <main>
        <h1>V2-383 isolated inline sync browser check</h1>
        <div data-testid="campaign-refresh-count">{refreshed}</div>
        <InlineMetaTemplateSync onSynced={async () => { setRefreshed(n => n + 1) }} />
        <div data-testid="explicitly-disabled-control"><InlineMetaTemplateSync disabled /></div>
      </main>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
