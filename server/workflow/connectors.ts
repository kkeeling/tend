import type {
  ActionExecutionPolicy,
  ConnectorAssurance,
  ConnectorExecutionGrant,
  ConnectorExecutionRequirement,
  ConnectorVerificationObservation,
  ConnectorVerificationReceipt,
  SourceIdentity,
  SourceProfile,
  SourceProvider,
} from "../../shared/types";
import { digest, isoNow, makeToken } from "../util";

const ASSURANCE_RANK: Record<ConnectorAssurance, number> = {
  prepare_only: 0,
  agent_host_observed: 1,
  trusted_adapter: 2,
};

const PROVIDER_MINIMUM_ASSURANCE: Record<SourceProvider, ConnectorAssurance> = {
  gmail: "agent_host_observed",
  outlook_email: "agent_host_observed",
  google_calendar: "agent_host_observed",
  outlook_calendar: "agent_host_observed",
  slack: "agent_host_observed",
  teams: "agent_host_observed",
  granola: "prepare_only",
  imessage: "prepare_only",
  custom: "trusted_adapter",
};
const SAFE_IDENTITY_KEY = /^[a-z][a-z0-9_-]{0,63}$/i;
export const CONNECTOR_VERIFICATION_MAX_AGE_MS = 5 * 60_000;

export type TrustedAdapterVerifier = (input: {
  grant: ConnectorExecutionGrant;
  observation: ConnectorVerificationObservation;
}) => boolean;

export function providerMinimumAssurance(provider: SourceProvider): ConnectorAssurance {
  return PROVIDER_MINIMUM_ASSURANCE[provider];
}

export function requirementFromPolicy(
  policy: ActionExecutionPolicy,
  profile?: SourceProfile,
): ConnectorExecutionRequirement {
  if (profile && profile.provider !== policy.provider) {
    throw new Error(`Connector provider mismatch: action requires ${policy.provider}, source profile is ${profile.provider}.`);
  }
  const expectedIdentity = policy.expectedIdentity ?? profile?.expectedIdentity;
  if (!expectedIdentity || !Object.values(expectedIdentity).some((value) => Boolean(value?.trim()))) {
    throw new Error("External connector action requires an exact expected account, tenant, workspace, calendar, or device identity.");
  }
  const capability = policy.operation === "send_reply" ? "send_reply" : "write";
  const providerMinimum = providerMinimumAssurance(policy.provider);
  const profileAllowsAction = !profile || profile.actionCapabilities.includes(capability);
  const requestedMinimum = policy.minimumAssurance ?? providerMinimum;
  const minimumAssurance = profileAllowsAction
    ? strongerAssurance(providerMinimum, requestedMinimum)
    : "prepare_only";
  return {
    provider: policy.provider,
    operation: policy.operation,
    ...(policy.sourceId ? { sourceId: policy.sourceId } : {}),
    expectedIdentity: normalizeIdentity(expectedIdentity),
    minimumAssurance,
  };
}

export function issueExecutionGrant(requirement: ConnectorExecutionRequirement): ConnectorExecutionGrant {
  return {
    ...requirement,
    nonce: makeToken(),
    issuedAt: isoNow(),
  };
}

export function executionRequirementDigest(requirement: ConnectorExecutionRequirement): string {
  return digest({
    provider: requirement.provider,
    operation: requirement.operation,
    sourceId: requirement.sourceId ?? null,
    expectedIdentity: normalizeIdentity(requirement.expectedIdentity),
    minimumAssurance: requirement.minimumAssurance,
  });
}

export function verifyConnectorObservation(
  grant: ConnectorExecutionGrant,
  observation: ConnectorVerificationObservation,
  options: { now?: Date; trustedAdapterVerifier?: TrustedAdapterVerifier } = {},
): ConnectorVerificationReceipt {
  if (grant.minimumAssurance === "prepare_only") {
    throw new Error(`${grant.provider} is prepare-only for ${grant.operation}; no external mutation is authorized.`);
  }
  if (observation.provider !== grant.provider || observation.operation !== grant.operation) {
    throw new Error(`Connector execution context mismatch: expected ${grant.provider}/${grant.operation}.`);
  }
  if (observation.nonce !== grant.nonce) {
    throw new Error("Connector verification nonce does not match the claimed execution grant.");
  }
  const observedAt = new Date(observation.observedAt);
  const now = options.now ?? new Date();
  if (Number.isNaN(observedAt.getTime())) throw new Error("Connector profile observation timestamp is invalid.");
  if (observedAt.getTime() > now.getTime() + 60_000 || now.getTime() - observedAt.getTime() > CONNECTOR_VERIFICATION_MAX_AGE_MS) {
    throw new Error("Connector profile observation is not fresh; observe the connector identity again immediately before mutation.");
  }
  if (ASSURANCE_RANK[observation.assurance] < ASSURANCE_RANK[grant.minimumAssurance]) {
    throw new Error(`Connector assurance ${observation.assurance} does not satisfy required ${grant.minimumAssurance}.`);
  }
  if (!sourceIdentityMatches(grant.expectedIdentity, observation.observedIdentity)) {
    throw new Error(`Connector identity mismatch: expected ${identitySummary(grant.expectedIdentity)}, got ${identitySummary(observation.observedIdentity)}.`);
  }
  if (observation.assurance === "trusted_adapter") {
    if (!observation.adapterReceipt || !options.trustedAdapterVerifier?.({ grant, observation })) {
      throw new Error("Trusted-adapter assurance requires a valid nonce-bound adapter receipt.");
    }
  }
  return {
    provider: grant.provider,
    operation: grant.operation,
    ...(grant.sourceId ? { sourceId: grant.sourceId } : {}),
    expectedIdentity: normalizeIdentity(grant.expectedIdentity),
    minimumAssurance: grant.minimumAssurance,
    observedIdentity: normalizeIdentity(observation.observedIdentity),
    assurance: observation.assurance,
    observedAt: observedAt.toISOString(),
    verifiedAt: now.toISOString(),
    nonce: grant.nonce,
    grantDigest: executionRequirementDigest(grant),
    ...(observation.adapterReceipt ? { adapterReceiptDigest: digest(observation.adapterReceipt) } : {}),
  };
}

export function assertConnectorVerificationFresh(
  receipt: ConnectorVerificationReceipt,
  now = new Date(),
): void {
  const verifiedAt = new Date(receipt.verifiedAt);
  const observedAt = new Date(receipt.observedAt);
  if (
    Number.isNaN(verifiedAt.getTime())
    || Number.isNaN(observedAt.getTime())
    || verifiedAt.getTime() > now.getTime() + 60_000
    || observedAt.getTime() > now.getTime() + 60_000
    || now.getTime() - verifiedAt.getTime() > CONNECTOR_VERIFICATION_MAX_AGE_MS
    || now.getTime() - observedAt.getTime() > CONNECTOR_VERIFICATION_MAX_AGE_MS
  ) {
    throw new Error("Connector verification is stale; observe the live connector identity again immediately before mutation.");
  }
}

export function sourceIdentityMatches(expected: SourceIdentity, observed: SourceIdentity): boolean {
  const normalizedExpected = normalizeIdentity(expected);
  const normalizedObserved = normalizeIdentity(observed);
  return Object.entries(normalizedExpected).every(([key, value]) =>
    value === undefined || normalizedObserved[key as keyof SourceIdentity] === value);
}

export function normalizeIdentity(identity: SourceIdentity): SourceIdentity {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("Connector identity must be an object.");
  if (Object.keys(identity).length > 32) throw new Error("Connector identity contains too many fields.");
  for (const [key, value] of Object.entries(identity)) {
    if (!SAFE_IDENTITY_KEY.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new Error(`Connector identity contains an unsafe field: ${key}.`);
    }
    if (value !== undefined && typeof value !== "string") throw new Error(`Connector identity ${key} must be a string.`);
  }
  return Object.fromEntries(
    Object.entries(identity)
      .filter(([, value]) => Boolean(value?.trim()))
      .map(([key, value]) => [key, value!.trim().toLowerCase()]),
  ) as SourceIdentity;
}

function strongerAssurance(left: ConnectorAssurance, right: ConnectorAssurance): ConnectorAssurance {
  return ASSURANCE_RANK[left] >= ASSURANCE_RANK[right] ? left : right;
}

function identitySummary(identity: SourceIdentity): string {
  const entries = Object.entries(normalizeIdentity(identity));
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(", ") : "no identity";
}
