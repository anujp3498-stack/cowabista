import { clerkSetup } from '@clerk/testing/playwright';

// Fetches a Clerk testing token (via CLERK_SECRET_KEY / VITE_CLERK_PUBLISHABLE_KEY,
// read from the untracked repository .env or a CI secret, development-instance
// keys only) so tests can bypass Clerk's bot protection and sign in
// programmatically -- never through the Clerk UI. Clerk is replaced by Better
// Auth in a later phase.
export default async function globalSetup(): Promise<void> {
  await clerkSetup();
}
