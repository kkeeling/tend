import { expect, test } from "bun:test";
import { COMPOSE_CARD_PROMPT, EXECUTE_WORK_PROMPT, providerSourceRecipe } from "../server/templates";

test("card composition prompt distinguishes local dismissal from source cleanup", () => {
  expect(COMPOSE_CARD_PROMPT).toContain("`dismiss_card`");
  expect(COMPOSE_CARD_PROMPT).toContain("without creating work or mutating its source");
  expect(COMPOSE_CARD_PROMPT).toContain("explicit source cleanup");
  expect(COMPOSE_CARD_PROMPT).toContain("routine “clear this card” control");
});

test("connector prompts name the host assurance boundary and never grant mutation from collection", () => {
  expect(EXECUTE_WORK_PROMPT).toContain("agent_host_observed");
  expect(EXECUTE_WORK_PROMPT).toContain("prepare_only");
  const granola = providerSourceRecipe({
    id: "meeting-notes",
    name: "Meeting notes",
    summary: "Collect attended meeting notes.",
    profile: {
      provider: "granola",
      expectedIdentity: { account: "account-alias" },
      required: true,
      cadenceMinutes: 15,
      freshnessMinutes: 30,
      lookbackDays: 30,
      onboardingState: "connected",
      actionCapabilities: ["read"],
    },
  });
  expect(granola.markdown).toContain("official Granola connector");
  expect(granola.markdown).toContain("macOS Keychain");
  expect(granola.markdown).toContain("automation as an authentication fallback");
  expect(granola.markdown).toContain("Record one source-attempt receipt on every exit");
  expect(granola.markdown).toContain("Collection grants read authority only");
});
