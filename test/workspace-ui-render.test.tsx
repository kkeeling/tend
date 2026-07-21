import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverageView } from "../src/workspace/CoverageView";
import { NowView } from "../src/workspace/NowView";
import { PriorityLedgerView } from "../src/workspace/PriorityLedgerView";
import type { Card, WorkspaceControlPlane } from "../shared/types";

const card: Card = {
  id: "reply-card",
  feedId: "mailbox-work-a",
  kind: "attention",
  status: "to_review_new",
  title: "Reply to the contract thread",
  eyebrow: "Mailbox work A",
  why: "A reply is due today.",
  sourceMailbox: "mailbox-work-a",
  blocks: [{ id: "draft", type: "editable_text", label: "Suggested reply", value: "Thanks — I’ll review this today.", editable: true }],
  actions: [{ id: "send", label: "Send reply", behavior: "approve_action", instruction: "Send the exact reply.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source", variant: "primary" }],
  readyForPass: 1,
  createdAt: "2026-07-21T17:00:00.000Z",
  updatedAt: "2026-07-21T17:00:00.000Z",
  history: [],
};

const control: WorkspaceControlPlane = {
  now: {
    asOf: "2026-07-21T18:00:00.000Z",
    allClear: false,
    message: "1 item needs attention.",
    items: [{
      id: "mailbox-work-a:reply-card",
      cardRef: { feedId: "mailbox-work-a", cardId: "reply-card" },
      card,
      priority: { rank: 1, score: 900, explanation: "Due today and high consequence.", ruleSetId: "rules-1", ruleVersion: 1, judgmentPolicyVersion: "judgment-v1" },
    }],
  },
  coverage: {
    asOf: "2026-07-21T18:00:00.000Z",
    allClear: false,
    requiredSources: 2,
    freshRequiredSources: 1,
    caveat: "1 required source is not coverage-complete.",
    sources: [{
      id: "mailbox-work-a:mail",
      feedId: "mailbox-work-a",
      sourceId: "mail",
      name: "Mailbox work A",
      provider: "outlook_email",
      expectedIdentity: { account: "mailbox-work-a" },
      observedIdentity: { account: "mailbox-work-a" },
      required: true,
      state: "permission_denied",
      allClearEligible: false,
      lastAttemptAt: "2026-07-21T17:55:00.000Z",
      lastGoodAt: "2026-07-21T17:40:00.000Z",
      ageMinutes: 20,
      remediation: "Grant the required read permission.",
      detail: "Consent is missing.",
    }],
  },
  priority: {
    activeRules: null,
    proposals: [],
    ledger: [{ id: "ledger-1", type: "evaluation", at: "2026-07-21T18:00:00.000Z", commitmentId: "commitment-1", ruleVersion: 1, detail: { rank: 1, explanation: "Due today." } }],
  },
};

const handlers = { onActivate: () => {}, onAction: () => {}, onChanged: () => {}, onReturnToReview: () => {} };

test("Now renders the existing editable card and exact CTA with composite identity", () => {
  const html = renderToStaticMarkup(<NowView control={control} activeId="mailbox-work-a:reply-card" {...handlers} />);
  expect(html).toContain("What needs you now");
  expect(html).toContain('data-card-id="mailbox-work-a:reply-card"');
  expect(html).toContain("Suggested reply");
  expect(html).toContain("Send reply");
  expect(html).toContain("Connector host identity checked before action");
  expect(html).toContain("Due today and high consequence.");
});

test("Coverage names the blind spot and never renders all-clear copy while degraded", () => {
  const html = renderToStaticMarkup(<CoverageView coverage={control.coverage} />);
  expect(html).toContain("Permission denied");
  expect(html).toContain("Grant the required read permission");
  expect(html).not.toContain("All required sources are fresh");
});

test("Priority ledger exposes immutable versions and explanations", () => {
  const html = renderToStaticMarkup(<PriorityLedgerView priority={control.priority} onApprove={() => {}} />);
  expect(html).toContain("Priority Ledger");
  expect(html).toContain("Rule v1");
  expect(html).toContain("Due today.");
});
