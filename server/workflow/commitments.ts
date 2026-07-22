import type { CommitmentLifecycle } from "../../shared/types";

const ALLOWED_TRANSITIONS: Record<CommitmentLifecycle, CommitmentLifecycle[]> = {
  open: ["waiting", "scheduled", "completion_pending", "fulfilled", "withdrawn", "superseded"],
  waiting: ["open", "scheduled", "completion_pending", "fulfilled", "withdrawn", "superseded"],
  scheduled: ["open", "waiting", "completion_pending", "fulfilled", "withdrawn", "superseded"],
  completion_pending: ["open", "fulfilled", "withdrawn", "reopened"],
  fulfilled: ["reopened"],
  withdrawn: ["reopened"],
  superseded: ["reopened"],
  reopened: ["open", "waiting", "scheduled", "completion_pending", "fulfilled", "withdrawn", "superseded"],
};

export function assertCommitmentTransition(from: CommitmentLifecycle, to: CommitmentLifecycle): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new Error(`Commitment cannot transition from ${from} to ${to}.`);
}
