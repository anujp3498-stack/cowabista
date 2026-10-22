import { randomBytes } from "node:crypto";
import type { createAuth } from "./auth";

// Operator account management while public sign-up is closed (decision U2, Option 2a), used by the operator
// command src/auth-admin.ts. It goes through Better Auth's own internal adapter and password hasher, exactly
// the sequence its sign-up endpoint runs, so no SQL ever carries a password: the temporary password is random,
// returned to the caller once, and stored only as Better Auth's scrypt hash. Accounts are created unverified
// (verified accounts get direct team adds and automatic invitation acceptance; the operator's identity check
// is out of band). The internal adapter skips the sign-up endpoint's own email and length checks, so they are
// repeated here.

type Auth = ReturnType<typeof createAuth>;
type AuthContext = Awaited<Auth["$context"]>;

/** A refusal caused by the input or the stored data (duplicate, unknown or malformed email, bad name). */
export class AuthAdminError extends Error {}

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 100;
// One local part and a domain with at least one dot; no whitespace and no second "@" anywhere.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** 18 random bytes as 24 base64url characters (144 bits), inside Better Auth's 12 to 128 character rule. */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) throw new AuthAdminError("Enter a valid email address");
  return email;
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) throw new AuthAdminError(`Name must be 1 to ${MAX_NAME_LENGTH} characters`);
  return name;
}

async function existingUser(context: AuthContext, email: string) {
  const found = await context.internalAdapter.findUserByEmail(email);
  if (!found) throw new AuthAdminError("There is no account with this email");
  return found.user;
}

/** Creates an unverified account with a credential (password) login; nobody is signed in. */
export async function createOperatorAccount(auth: Auth, input: { email: string; name: string }) {
  const email = normalizeEmail(input.email);
  const name = normalizeName(input.name);
  const context = await auth.$context;
  if (await context.internalAdapter.findUserByEmail(email)) throw new AuthAdminError("An account with this email already exists");
  const temporaryPassword = generateTemporaryPassword();
  const hash = await context.password.hash(temporaryPassword);
  let user: Awaited<ReturnType<AuthContext["internalAdapter"]["createUser"]>>;
  try {
    user = await context.internalAdapter.createUser({ email, name, emailVerified: false }, { method: "email-password" });
  } catch (error) {
    // Lost a race with another create for the same email (unique index on auth_users.email).
    if (await context.internalAdapter.findUserByEmail(email)) throw new AuthAdminError("An account with this email already exists");
    throw error;
  }
  try {
    await context.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  } catch (error) {
    // Never leave a user without a login; deleting it cascades to anything created with it.
    await context.internalAdapter.deleteUser(user.id);
    throw error;
  }
  return { authUserId: user.id, email: user.email, temporaryPassword };
}

/** Replaces the password with a new temporary one, then ends every session (none survives on the old one). */
export async function resetOperatorPassword(auth: Auth, input: { email: string }) {
  const email = normalizeEmail(input.email);
  const context = await auth.$context;
  const user = await existingUser(context, email);
  const temporaryPassword = generateTemporaryPassword();
  const hash = await context.password.hash(temporaryPassword);
  const account = await context.internalAdapter.findCredentialAccount(user.id);
  if (account) await context.internalAdapter.updateAccount(account.id, { password: hash });
  else await context.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  await context.internalAdapter.deleteUserSessions(user.id);
  return { authUserId: user.id, email: user.email, temporaryPassword };
}

/** Ends every session of the account; the password is unchanged. */
export async function revokeAllSessions(auth: Auth, input: { email: string }) {
  const email = normalizeEmail(input.email);
  const context = await auth.$context;
  const user = await existingUser(context, email);
  await context.internalAdapter.deleteUserSessions(user.id);
  return { authUserId: user.id, email: user.email };
}
