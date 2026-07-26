import type { QueryClient } from "@tanstack/react-query";

export type ArtifactDraftState = {
  value: string;
  baseValue: string;
  conflictingServerValue: string | null;
};

export type WorkspaceContinuityStore = {
  artifactDrafts: Map<string, ArtifactDraftState>;
  instructionDrafts: Map<string, string>;
  setArtifactDraft(key: string, value: ArtifactDraftState): void;
  setInstructionDraft(key: string, value: string): void;
};

const storesByQueryClient = new WeakMap<QueryClient, WorkspaceContinuityStore>();

export function createWorkspaceContinuityStore(): WorkspaceContinuityStore {
  const artifactDrafts = new Map<string, ArtifactDraftState>();
  const instructionDrafts = new Map<string, string>();
  return {
    artifactDrafts,
    instructionDrafts,
    setArtifactDraft(key, value) {
      artifactDrafts.set(key, value);
    },
    setInstructionDraft(key, value) {
      instructionDrafts.set(key, value);
    },
  };
}

export const defaultWorkspaceContinuityStore = createWorkspaceContinuityStore();

export function workspaceContinuityFor(queryClient: QueryClient): WorkspaceContinuityStore {
  const existing = storesByQueryClient.get(queryClient);
  if (existing) return existing;
  const created = createWorkspaceContinuityStore();
  storesByQueryClient.set(queryClient, created);
  return created;
}
