import { clerkSetup } from '@clerk/testing/playwright';

// Fetches a Clerk testing token (via CLERK_SECRET_KEY / VITE_CLERK_PUBLISHABLE_KEY,
// already present as environment secrets) so tests can bypass Clerk's bot
// protection and sign in programmatically -- never through the Clerk UI.
export default async function globalSetup(): Promise<void> {
  await clerkSetup();
}
