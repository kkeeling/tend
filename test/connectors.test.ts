import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { AttentionStore } from "../server/store";
import {
  issueExecutionGrant,
  providerMinimumAssurance,
  requirementFromPolicy,
  verifyConnectorObservation,
} from "../server/workflow/connectors";
import type { SourceProfile, SourceProvider, WorkItem } from "../shared/types";

const roots: string[] = [];

function profile(provider: SourceProvider, identity: SourceProfile["expectedIdentity"], capabilities: SourceProfile["actionCapabilities"] = ["read", "write"]): SourceProfile {
  return {
    provider,
    expectedIdentity: identity,
    required: true,
    cadenceMinutes: 15,
    freshnessMinutes: 20,
    lookbackDays: 30,
    onboardingState: "connected",
    actionCapabilities: capabilities,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider-neutral connector verification", () => {
  test("requires exact fresh identities for mail, calendars, Slack, and Teams", () => {
    const cases: Array<{ provider: SourceProvider; identity: SourceProfile["expectedIdentity"] }> = [
      { provider: "gmail", identity: { account: "mailbox-personal" } },
      { provider: "outlook_email", identity: { account: "mailbox-work-a", tenant: "tenant-a" } },
      { provider: "google_calendar", identity: { account: "mailbox-personal", calendar: "primary" } },
      { provider: "outlook_calendar", identity: { account: "mailbox-work-a", tenant: "tenant-a", calendar: "default" } },
      { provider: "slack", identity: { account: "user-a", workspace: "workspace-a" } },
      { provider: "teams", identity: { account: "user-a", tenant: "tenant-a" } },
    ];
    const observedAt = new Date().toISOString();
    for (const item of cases) {
      expect(providerMinimumAssurance(item.provider)).toBe("agent_host_observed");
      const grant = issueExecutionGrant(requirementFromPolicy(
        { provider: item.provider, operation: "write", sourceId: `${item.provider}-source` },
        profile(item.provider, item.identity),
      ));
      expect(verifyConnectorObservation(grant, {
        provider: item.provider,
        operation: "write",
        observedIdentity: item.identity,
        assurance: "agent_host_observed",
        observedAt,
        nonce: grant.nonce,
      })).toMatchObject({ provider: item.provider, assurance: "agent_host_observed", expectedIdentity: item.identity });
      expect(() => verifyConnectorObservation(grant, {
        provider: item.provider,
        operation: "write",
        observedIdentity: { ...item.identity, account: "wrong-account" },
        assurance: "agent_host_observed",
        observedAt,
        nonce: grant.nonce,
      })).toThrow("identity mismatch");
    }
  });

  test("fails closed for stale observations, wrong nonces, prepare-only providers, and unverified trusted adapters", () => {
    const gmail = issueExecutionGrant(requirementFromPolicy(
      { provider: "gmail", operation: "send_reply" },
      profile("gmail", { account: "mailbox-personal" }, ["read", "prepare_reply", "send_reply"]),
    ));
    expect(() => verifyConnectorObservation(gmail, {
      provider: "gmail",
      operation: "send_reply",
      observedIdentity: { account: "mailbox-personal" },
      assurance: "agent_host_observed",
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      nonce: gmail.nonce,
    })).toThrow("not fresh");
    expect(() => verifyConnectorObservation(gmail, {
      provider: "gmail",
      operation: "send_reply",
      observedIdentity: { account: "mailbox-personal" },
      assurance: "agent_host_observed",
      observedAt: new Date().toISOString(),
      nonce: "wrong-nonce",
    })).toThrow("nonce");

    for (const provider of ["granola", "imessage"] as const) {
      const grant = issueExecutionGrant(requirementFromPolicy(
        { provider, operation: "write" },
        profile(provider, { account: `${provider}-account` }, ["read"]),
      ));
      expect(grant.minimumAssurance).toBe("prepare_only");
      expect(() => verifyConnectorObservation(grant, {
        provider,
        operation: "write",
        observedIdentity: grant.expectedIdentity,
        assurance: "agent_host_observed",
        observedAt: new Date().toISOString(),
        nonce: grant.nonce,
      })).toThrow("prepare-only");
    }

    const custom = issueExecutionGrant(requirementFromPolicy({
      provider: "custom",
      operation: "write",
      expectedIdentity: { account: "custom-account" },
    }));
    expect(() => verifyConnectorObservation(custom, {
      provider: "custom",
      operation: "write",
      observedIdentity: { account: "custom-account" },
      assurance: "trusted_adapter",
      observedAt: new Date().toISOString(),
      nonce: custom.nonce,
      adapterReceipt: "unverified-receipt",
    })).toThrow("valid nonce-bound adapter receipt");
  });

  test("persists source profiles while enforcing read-only provider capabilities", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-connectors-"));
    roots.push(root);
    const store = new AttentionStore(root);
    await store.init();
    const domain = new AttentionDomain(store);
    const source = await domain.addSourceFromBrief("inbox", "Workspace message source");
    const configured = await domain.configureSourceProfile("inbox", source.id, profile("slack", { account: "user-a", workspace: "workspace-a" }));
    expect(configured.profile).toMatchObject({ provider: "slack", expectedIdentity: { account: "user-a", workspace: "workspace-a" } });
    await expect(domain.configureSourceProfile("inbox", source.id, profile("granola", { account: "user-a" }, ["read", "write"]))).rejects.toThrow("read-only");
    await domain.configureSourceProfile("inbox", source.id, profile("granola", { account: "user-a" }, ["read"]));
    await expect(domain.upsertCard("inbox", {
      id: "invalid-granola-write",
      title: "Do not post from meeting notes",
      why: "Read authority cannot imply write authority.",
      blocks: [{ id: "summary", type: "memo", text: "Evidence only." }],
      actions: [{
        id: "write",
        label: "Write",
        behavior: "approve_action",
        instruction: "Write externally.",
        externalMutation: true,
        execution: { provider: "granola", operation: "write", sourceId: source.id },
      }],
    })).rejects.toThrow("offer preparation instead of an outbound CTA");
  });

  test("binds an Outlook send to the claimed nonce and freshly current owning evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-connector-action-"));
    roots.push(root);
    const store = new AttentionStore(root);
    await store.init();
    const domain = new AttentionDomain(store);
    await domain.bindFeed("inbox", "thread-inbox");
    const source = await domain.addSourceFromBrief("inbox", "Mailbox work A");
    await domain.configureSourceProfile("inbox", source.id, profile(
      "outlook_email",
      { account: "mailbox-work-a", tenant: "tenant-a" },
      ["read", "prepare_reply", "send_reply"],
    ));
    const completeness = {
      identityVerified: true,
      scopeVerified: true,
      permissionsComplete: true,
      paginationComplete: true,
      backfillComplete: true,
    };
    const firstRun = await domain.recordSourceRun("inbox", source.id, [{ id: "message-1" }], [], { cursor: "message-1" }, undefined, undefined, {
      outcome: "success",
      observedIdentity: { account: "mailbox-work-a", tenant: "tenant-a" },
      completeness,
    });
    await domain.recordSweepBatch("inbox", [firstRun]);
    await domain.upsertCard("inbox", {
      id: "outlook-reply",
      title: "Reply from the owning Outlook account",
      why: "The exact connector identity and evidence must remain current.",
      sourceMailbox: "mailbox-work-a",
      sourceRunIds: [firstRun],
      blocks: [{ id: "draft", type: "editable_text", label: "Suggested reply", value: "Approved reply.", editable: true }],
      actions: [{
        id: "send-reply",
        label: "Send reply",
        behavior: "approve_action",
        instruction: "Send the exact reply.",
        artifactBlockId: "draft",
        externalMutation: true,
        mailboxPolicy: "reply_from_source",
        execution: { provider: "outlook_email", operation: "send_reply", sourceId: source.id },
      }],
    });
    const approved = await domain.runCardAction("inbox", "outlook-reply", "send-reply");
    const claimed = await domain.claimWork("inbox", "thread-inbox") as WorkItem;
    expect(claimed.id).toBe(approved.id);
    const grant = claimed.executionGrant!;
    const verified = await domain.verifyApprovedAction("inbox", claimed.id, claimed.capabilityToken, {
      provider: "outlook_email",
      operation: "send_reply",
      observedIdentity: { account: "mailbox-work-a", tenant: "tenant-a" },
      assurance: "agent_host_observed",
      observedAt: new Date().toISOString(),
      nonce: grant.nonce,
    });
    expect(verified.connectorVerification).toMatchObject({ provider: "outlook_email", assurance: "agent_host_observed" });

    const secondRun = await domain.recordSourceRun("inbox", source.id, [{ id: "message-2" }], [], { cursor: "message-2" }, undefined, undefined, {
      outcome: "success",
      observedIdentity: { account: "mailbox-work-a", tenant: "tenant-a" },
      completeness,
    });
    await domain.recordSweepBatch("inbox", [secondRun]);
    await expect(domain.verifyApprovedAction("inbox", claimed.id, claimed.capabilityToken, {
      provider: "outlook_email",
      operation: "send_reply",
      observedIdentity: { account: "mailbox-work-a", tenant: "tenant-a" },
      assurance: "agent_host_observed",
      observedAt: new Date().toISOString(),
      nonce: grant.nonce,
    })).rejects.toThrow("source evidence is stale");
  });
});
