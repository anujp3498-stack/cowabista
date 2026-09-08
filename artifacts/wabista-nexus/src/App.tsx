import { type ReactNode, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Redirect, Router as WouterRouter } from 'wouter';

import { Shell } from '@/components/layout/shell';
import Home from '@/pages/home';
import { SignInPage, SignUpPage } from '@/pages/auth';
import Overview from '@/pages/overview';
import Campaigns from '@/pages/campaigns';
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

const queryClient = new QueryClient();

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains. Do not inline the env var, leave
// publishableKey undefined, or replace publishableKeyFromHost with anything else.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — copy verbatim. Empty in dev (Clerk hits dev FAPI directly), auto-set
// in prod. Do NOT gate on import.meta.env.PROD / NODE_ENV — the empty dev value
// is intentional, and any branching breaks the prod proxy.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#3B82F6',
    colorForeground: '#0F172A',
    colorMutedForeground: '#64748B',
    colorDanger: '#DC2626',
    colorBackground: '#FFFFFF',
    colorInput: '#F1F5F9',
    colorInputForeground: '#0F172A',
    colorNeutral: '#CBD5E1',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    borderRadius: '0.5rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-2xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-slate-900 font-bold',
    headerSubtitle: 'text-slate-500',
    socialButtonsBlockButtonText: 'text-slate-700 font-medium',
    formFieldLabel: 'text-slate-700 font-medium',
    footerActionLink: 'text-primary font-semibold hover:text-primary/80',
    footerActionText: 'text-slate-500',
    dividerText: 'text-slate-400',
    identityPreviewEditButton: 'text-primary',
    formFieldSuccessText: 'text-emerald-600',
    alertText: 'text-slate-700',
    logoBox: 'mb-2',
    logoImage: 'h-10 w-10 rounded-lg',
    socialButtonsBlockButton: 'border-slate-200 hover:bg-slate-50',
    formButtonPrimary: 'bg-primary hover:bg-primary/90 text-white',
    formFieldInput: 'border-slate-200 focus:border-primary',
    footerAction: 'text-slate-500',
    dividerLine: 'bg-slate-200',
    alert: 'bg-red-50 border-red-200',
    otpCodeFieldInput: 'border-slate-200',
    formFieldRow: '',
    main: '',
  },
};

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/overview" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

function DashboardGate() {
  return (
    <>
      <Show when="signed-in">
        <DashboardRouter />
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function DashboardRouter() {
  return (
    <RoutedErrorBoundary>
      <Shell>
        <Switch>
          <Route path="/overview" component={Overview} />
          <Route path="/campaigns" component={Campaigns} />
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

// Helps user's webview stay up-to-date when the signed-in user changes by
// invalidating the QueryClient cache (e.g. switching accounts).
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: 'Welcome back',
            subtitle: 'Sign in to your Wabista Nexus workspace',
          },
        },
        signUp: {
          start: {
            title: 'Create your workspace',
            subtitle: 'Get started with Wabista Nexus in seconds',
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkQueryClientCacheInvalidator />
      <Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/invite/:token" component={InvitePage} />
        <Route component={DashboardGate} />
      </Switch>
    </ClerkProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <ClerkProviderWithRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
