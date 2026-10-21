import { type ReactNode, useEffect, useRef } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Redirect, Router as WouterRouter } from 'wouter';
import { authClient } from '@/lib/auth-client';
import { errorStatusFrom } from '@/lib/api-errors';
import { sessionView } from '@/lib/session-view';

import { Shell } from '@/components/layout/shell';
import Home from '@/pages/home';
import { SignInPage, SignUpPage } from '@/pages/auth';
import Overview from '@/pages/overview';
import Campaigns from '@/pages/campaigns';
import CampaignDetail from '@/pages/campaign-detail';
import CampaignAudiencePage, { NewCampaignPage } from '@/pages/campaign-audience';
import CampaignMessagePage from '@/pages/campaign-message';
import CampaignDeliveryPage from '@/pages/campaign-delivery';
import CampaignReviewPage from '@/pages/campaign-review';
import RocketCampaigns from '@/pages/rocket-campaigns';
import Contacts from '@/pages/contacts';
import Suppressions from '@/pages/suppressions';
import PhoneNumbers from '@/pages/phone-numbers';
import Templates from '@/pages/templates';
import Inbox from '@/pages/inbox';
import Automations from '@/pages/automations';
import Analytics from '@/pages/analytics';
import ApiDevelopers from '@/pages/api-developers';
import Billing from '@/pages/billing';
import TeamRoles from '@/pages/team-roles';
import Integrations from '@/pages/integrations';
import Settings from '@/pages/settings';
import InvitePage from '@/pages/invite';

// A 401 from the API means the session is gone (expired, signed out in another tab, revoked): refresh the
// session state so the gates below send the user to sign-in instead of leaving pages loading forever.
function onApiError(error: unknown) {
  if (errorStatusFrom(error) === 401) authClient.$store.notify('$sessionSignal');
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function FullPageLoader() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center" data-testid="session-loading">
      <p className="text-muted-foreground animate-pulse">Loading…</p>
    </div>
  );
}

// The session check itself failed (server or network trouble, not "signed out"): offer a retry instead of
// sending a signed-in user to the sign-in page.
function SessionUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 px-4 text-center" data-testid="session-unavailable">
      <p className="text-muted-foreground">Wabista Nexus could not check your sign-in right now.</p>
      <button type="button" className="text-sm font-semibold text-primary underline-offset-4 hover:underline" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function useSessionGate() {
  const { data: session, isPending, error, refetch } = authClient.useSession();
  return { view: sessionView({ hasSession: !!session, isPending, error }), retry: () => void refetch() };
}

function HomeRedirect() {
  const { view } = useSessionGate();
  if (view === 'loading') return <FullPageLoader />;
  // The public landing page also shows when the session check failed: it needs no API.
  return view === 'signed-in' ? <Redirect to="/overview" /> : <Home />;
}

function DashboardGate() {
  const { view, retry } = useSessionGate();
  const [location] = useLocation();
  if (view === 'loading') return <FullPageLoader />;
  if (view === 'unavailable') return <SessionUnavailable onRetry={retry} />;
  if (view === 'signed-out') return <Redirect to={`/sign-in?next=${encodeURIComponent(location)}`} />;
  return <DashboardRouter />;
}

function DashboardRouter() {
  return (
    <RoutedErrorBoundary>
      <Shell>
        <Switch>
          <Route path="/overview" component={Overview} />
          <Route path="/campaigns" component={Campaigns} />
          {/* Specific campaign routes first: "new" must never parse as a campaign id. */}
          <Route path="/campaigns/new" component={NewCampaignPage} />
          <Route path="/campaigns/:campaignId/audience" component={CampaignAudiencePage} />
          <Route path="/campaigns/:campaignId/message" component={CampaignMessagePage} />
          <Route path="/campaigns/:campaignId/delivery" component={CampaignDeliveryPage} />
          <Route path="/campaigns/:campaignId/review" component={CampaignReviewPage} />
          <Route path="/campaigns/:campaignId" component={CampaignDetail} />
          <Route path="/rocket-campaigns" component={RocketCampaigns} />
          <Route path="/contacts" component={Contacts} />
          <Route path="/suppressions" component={Suppressions} />
          <Route path="/phone-numbers" component={PhoneNumbers} />
          <Route path="/templates" component={Templates} />
          <Route path="/inbox" component={Inbox} />
          <Route path="/automations" component={Automations} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/api-developers" component={ApiDevelopers} />
          <Route path="/billing" component={Billing} />
          <Route path="/team-roles" component={TeamRoles} />
          <Route path="/integrations" component={Integrations} />
          <Route path="/settings" component={Settings} />
          <Route component={NotFound} />
        </Switch>
      </Shell>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

// Clears every cached query when the signed-in user changes (sign-out, another account), so one user's
// data is never shown to the next.
function SessionCacheGuard() {
  const { data: session, isPending } = authClient.useSession();
  const queryClient = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (isPending) return;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      queryClient.clear();
    }
    previousUserId.current = userId;
  }, [isPending, userId, queryClient]);

  return null;
}

function AppRoutes() {
  return (
    <>
      <SessionCacheGuard />
      <Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/invite/:token" component={InvitePage} />
        <Route component={DashboardGate} />
      </Switch>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <AppRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
