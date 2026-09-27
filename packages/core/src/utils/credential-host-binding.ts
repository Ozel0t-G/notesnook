import hosts from "./constants.js";

type HostPair = { api: string; auth: string };

// Access tokens can outlive an awaited operation that obtained them. Keep the
// hosts they were verified against so a later Database.host() call cannot
// redirect a request holding that token to a different service.
const bindings = new Map<string, HostPair>();

function canonicalHost(host: string) {
  const parsed = new URL(host);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function sameConfiguredHost(left: string, right: string) {
  return canonicalHost(left) === canonicalHost(right);
}

export function bindCredential(token: string, expected: HostPair) {
  if (!token) return;
  const prior = bindings.get(token);
  if (
    prior &&
    (!sameConfiguredHost(prior.api, expected.api) ||
      !sameConfiguredHost(prior.auth, expected.auth))
  )
    throw new Error("Account credential is already bound to another server.");
  bindings.set(token, expected);
}

function within(url: string, host: string) {
  const destination = new URL(url);
  const base = new URL(host);
  const prefix = base.pathname.replace(/\/+$/, "");
  return (
    destination.origin === base.origin &&
    (destination.pathname === prefix ||
      destination.pathname.startsWith(`${prefix}/`))
  );
}

export function assertCredentialDestination(
  token: string | undefined,
  url: string
) {
  if (!token) return;
  const expected = bindings.get(token);
  if (!expected)
    throw new Error("Account credential has no verified server binding.");
  if (
    !sameConfiguredHost(hosts.API_HOST, expected.api) ||
    !sameConfiguredHost(hosts.AUTH_HOST, expected.auth) ||
    (!within(url, expected.api) && !within(url, expected.auth))
  )
    throw new Error(
      "Server settings changed while using account credentials. Start again."
    );
}

/** Guard a platform adapter request that carries the Core-issued bearer. */
export function assertBearerDestination(
  headers: { Authorization?: string; authorization?: string } | undefined,
  url: string
) {
  const authorization = headers?.Authorization ?? headers?.authorization;
  const token = /^Bearer (\S+)$/i.exec(authorization || "")?.[1];
  if (!token)
    throw new Error("File request has no verified account credential.");
  assertCredentialDestination(token, url);
}
