import { useCallback, useEffect, useMemo, useState } from "react";
import { containsFullEmail } from "../../shared/emailThread";
import { post } from "../app/api";
import type { Card, CardAction, CardBlock, WorkItemView } from "../types";
import { DetachedLink } from "../ui/DetachedLink";
import { FormattedText } from "../ui/FormattedText";
import { visibleCardActions } from "./selectors";
import {
  defaultWorkspaceContinuityStore,
  type ArtifactDraftState,
  type WorkspaceContinuityStore,
} from "../workspace/continuityStore";

function useConflictAwareValue(
  editorKey: string,
  serverValue: string,
  continuityStore: WorkspaceContinuityStore,
) {
  const [draft, setDraft] = useState<ArtifactDraftState>(() => continuityStore.artifactDrafts.get(editorKey) ?? {
    value: serverValue,
    baseValue: serverValue,
    conflictingServerValue: null,
  });
  const updateDraft = useCallback((update: (current: ArtifactDraftState) => ArtifactDraftState) => {
    setDraft((current) => {
      const next = update(current);
      if (next.value === next.baseValue && next.baseValue === serverValue && next.conflictingServerValue === null) {
        continuityStore.artifactDrafts.delete(editorKey);
      } else {
        continuityStore.setArtifactDraft(editorKey, next);
      }
      return next;
    });
  }, [continuityStore, editorKey, serverValue]);

  useEffect(() => {
    updateDraft((current) => {
      if (serverValue === current.baseValue) return current;
      if (current.value === current.baseValue || current.value === serverValue) {
        return {
          value: serverValue,
          baseValue: serverValue,
          conflictingServerValue: null,
        };
      }
      return { ...current, conflictingServerValue: serverValue };
    });
  }, [serverValue, updateDraft]);

  return {
    value: draft.value,
    setValue(nextValue: string) {
      updateDraft((current) => ({ ...current, value: nextValue }));
    },
    conflictingServerValue: draft.conflictingServerValue,
    markSaved(nextValue: string) {
      updateDraft(() => ({
        value: nextValue,
        baseValue: nextValue,
        conflictingServerValue: null,
      }));
    },
    keepLocalValue() {
      updateDraft((current) => current.conflictingServerValue === null ? current : ({
        ...current,
        baseValue: current.conflictingServerValue,
        conflictingServerValue: null,
      }));
    },
    useServerValue() {
      updateDraft((current) => current.conflictingServerValue === null ? current : ({
        value: current.conflictingServerValue,
        baseValue: current.conflictingServerValue,
        conflictingServerValue: null,
      }));
    },
  };
}

type ReadableHistoryEntry = { at: string; label: string; detail: string; tone?: "attention" };

function readableHistoryEntry(entry: Card["history"][number]): ReadableHistoryEntry | null {
    if (entry.type === "user.scoped_instruction" || entry.type === "user.instruction") {
      return { at: entry.at, label: "You asked", detail: entry.detail ?? "Handle this card." };
    }
    if (entry.type === "user.approved_action") {
      return { at: entry.at, label: "You approved", detail: "The previous next step." };
    }
    if (entry.type === "user.default_cleanup_approved") {
      return { at: entry.at, label: "You approved", detail: "Archive this thread." };
    }
    if (entry.type === "user.default_cleanup_undone") {
      return { at: entry.at, label: "You undid", detail: "The archive instruction." };
    }
    if (entry.type === "user.edited_artifact") {
      return { at: entry.at, label: "You edited", detail: "The proposed artifact." };
    }
    if (entry.type === "user.cancelled_queued_work") {
      return { at: entry.at, label: "You cancelled", detail: "The queued instruction." };
    }
    if (entry.type === "user.edited_queued_instruction") {
      return { at: entry.at, label: "You corrected", detail: entry.detail ?? "The queued note." };
    }
    if (entry.type === "user.card_dismissed") {
      return { at: entry.at, label: "You dismissed", detail: "Removed this card from review. The source was not changed." };
    }
    if (entry.type === "user.returned_to_review") {
      return { at: entry.at, label: "Back for review", detail: "You moved this card back into the sweep." };
    }
    if (entry.type === "codex.completed") {
      return { at: entry.at, label: "Codex did", detail: entry.detail ?? "Finished the requested work." };
    }
    if (entry.type === "codex.stale_approval") {
      return { at: entry.at, label: "Needs review", detail: "The previous approval expired because the card changed. Review the current next step.", tone: "attention" as const };
    }
    if (entry.type === "codex.failed") {
      return { at: entry.at, label: "Codex could not finish", detail: entry.detail ?? "The attempted work needs another look.", tone: "attention" as const };
    }
    if (entry.type === "codex.approved_action_blocked") {
      return { at: entry.at, label: "Still approved", detail: entry.detail ?? "Codex needs to retry the approved action.", tone: "attention" as const };
    }
    if (entry.type === "codex.approved_action_retry_queued") {
      return { at: entry.at, label: "Codex retrying", detail: "Your existing approval is still bound to the unchanged artifact." };
    }
    if (entry.type === "codex.approved_action_reconciled") {
      return { at: entry.at, label: "Codex did", detail: entry.detail ?? "Recorded the approved action as completed after the connector succeeded." };
    }
    if (entry.type === "routine_action.completed") {
      return { at: entry.at, label: "Codex did", detail: "Completed the approved routine cleanup." };
    }
    return null;
}

function CardHistory({ card }: { card: Card }) {
  const [expanded, setExpanded] = useState(false);
  const { count, visible } = useMemo(() => {
    if (expanded) {
      const all = card.history
        .map(readableHistoryEntry)
        .filter((entry): entry is ReadableHistoryEntry => entry !== null);
      return { count: all.length, visible: all };
    }
    const latest: ReadableHistoryEntry[] = [];
    let count = 0;
    for (let index = card.history.length - 1; index >= 0; index -= 1) {
      const entry = readableHistoryEntry(card.history[index] as Card["history"][number]);
      if (!entry) continue;
      count += 1;
      if (latest.length < 3) latest.push(entry);
    }
    latest.reverse();
    return { count, visible: latest };
  }, [card.history, expanded]);
  if (!count) return null;
  return (
    <section className="card-history">
      <header>
        <span className="action-label">History</span>
        {count > 3 && <button className="history-toggle" onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}>{expanded ? "Show less" : `Show all ${count}`}</button>}
      </header>
      <ol>
        {visible.map((entry, index) => (
          <li className={entry.tone === "attention" ? "needs-attention" : ""} key={`${entry.at}-${index}`}>
            <b>{entry.label}</b>
            <span>{entry.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Block({
  feedId,
  cardId,
  block,
  onChanged,
  editorId,
  onConflictChanged,
  mutationsDisabled,
  continuityStore,
}: {
  feedId: string;
  cardId: string;
  block: CardBlock;
  onChanged: () => void;
  editorId: string;
  onConflictChanged: (editorId: string, conflicting: boolean) => void;
  mutationsDisabled: boolean;
  continuityStore: WorkspaceContinuityStore;
}) {
  const draft = useConflictAwareValue(
    `${feedId}\u0000${cardId}\u0000block:${block.id}`,
    block.value ?? "",
    continuityStore,
  );
  const [saveError, setSaveError] = useState("");
  useEffect(
    () => onConflictChanged(editorId, draft.conflictingServerValue !== null),
    [draft.conflictingServerValue, editorId, onConflictChanged],
  );
  useEffect(() => () => onConflictChanged(editorId, false), [editorId, onConflictChanged]);

  const save = async () => {
    if (mutationsDisabled || draft.conflictingServerValue !== null || draft.value === (block.value ?? "")) return;
    try {
      setSaveError("");
      await post(`/api/feeds/${feedId}/cards/${cardId}/blocks/${block.id}`, { value: draft.value });
      draft.markSaved(draft.value);
      onChanged();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  if (block.type === "editable_text") {
    return (
      <section className="block block-editor">
        {block.label && <h3>{block.label}</h3>}
        <textarea
          aria-label={block.label ?? "Editable card content"}
          data-block-id={block.id}
          readOnly={mutationsDisabled}
          aria-disabled={mutationsDisabled}
          value={draft.value}
          onInput={(event) => draft.setValue(event.currentTarget.value)}
          onBlur={() => void save()}
          rows={Math.max(4, draft.value.split("\n").length + 1)}
        />
        {draft.conflictingServerValue !== null && (
          <div className="edit-conflict" role="alert">
            <b>Tend received a newer version while you were editing.</b>
            <p>Your edit is preserved. Choose which version to continue with before acting.</p>
            <div className="action-buttons">
              <button className="button ghost" type="button" onClick={draft.useServerValue}>Use Tend version</button>
              <button className="button primary" type="button" onClick={draft.keepLocalValue}>Keep my edit</button>
            </div>
          </div>
        )}
        {saveError && <p className="edit-error" role="alert">Draft could not be saved: {saveError}</p>}
      </section>
    );
  }
  if (block.type === "profile" && block.profile) {
    return (
      <section className="block block-profile">
        <DetachedLink className="profile-portrait" href={block.profile.href} aria-label={`Open ${block.profile.name} profile`}>
          <img
            src={block.profile.imageUrl}
            alt=""
            onError={(event) => {
              if (block.profile?.fallbackImageUrl && event.currentTarget.src !== block.profile.fallbackImageUrl) {
                event.currentTarget.src = block.profile.fallbackImageUrl;
              }
            }}
          />
        </DetachedLink>
        <div className="profile-copy">
          <DetachedLink className="profile-name" href={block.profile.href}>{block.profile.name}</DetachedLink>
          {block.profile.subtitle && <span className="profile-subtitle">{block.profile.subtitle}</span>}
          {block.profile.links && (
            <div className="profile-links">
              {block.profile.links.map((link) => <DetachedLink key={link.href} href={link.href}>{link.label}</DetachedLink>)}
            </div>
          )}
        </div>
      </section>
    );
  }
  if (block.type === "evidence") {
    return (
      <section className="block block-evidence">
        {block.label && <h3>{block.label}</h3>}
        <ul>{block.items?.map((item, index) => (
          <li key={index}>
            {typeof item === "string"
              ? <FormattedText text={item} />
              : item.href
                ? <DetachedLink href={item.href}>{item.label}</DetachedLink>
                : <FormattedText text={item.label} />}
          </li>
        ))}</ul>
      </section>
    );
  }
  if (block.type === "checklist") {
    return (
      <section className="block block-checklist">
        {block.label && <h3>{block.label}</h3>}
        <ul>{block.items?.map((item, index) => <li key={index}><span className="checkmark">○</span>{typeof item === "string" ? item : item.label}</li>)}</ul>
      </section>
    );
  }
  if (block.type === "options") {
    return (
      <section className="block block-options">
        {block.label && <h3>{block.label}</h3>}
        {block.items?.map((item, index) => typeof item === "string"
          ? <div className="option" key={index}>{item}</div>
          : <div className="option" key={index}><b>{item.label}</b>{item.detail && <span>{item.detail}</span>}</div>)}
      </section>
    );
  }
  if (block.type === "chart" && block.chart) {
    const unit = block.chart.unit ?? "";
    return (
      <section className="block block-chart">
        {block.label && <h3>{block.label}</h3>}
        <div className="chart-legend">
          {block.chart.series.map((series, index) => <span key={series.label}><i className={`chart-swatch chart-series-${index + 1}`} />{series.label}</span>)}
        </div>
        <div className="chart-rows">
          {block.chart.rows.map((row) => (
            <div className="chart-row" key={row.label}>
              <div className="chart-row-label"><b>{row.label}</b>{row.detail && <span>{row.detail}</span>}</div>
              {row.values.map((value, index) => (
                <div className="chart-metric" key={`${row.label}-${index}`} aria-label={`${row.label}: ${block.chart?.series[index].label} ${value}${unit}`}>
                  <span className="chart-value">{value}{unit}</span>
                  <span className="chart-track"><i className={`chart-bar chart-series-${index + 1}`} style={{ width: `${value / block.chart!.max * 100}%` }} /></span>
                </div>
              ))}
            </div>
          ))}
        </div>
        {block.chart.note && <p className="chart-note">{block.chart.note}</p>}
      </section>
    );
  }
  if (block.type === "diff") {
    return (
      <section className="block block-diff">
        {block.label && <h3>{block.label}</h3>}
        <div className="diff-before">{block.before}</div>
        <div className="diff-after">{block.after}</div>
      </section>
    );
  }
  if (block.type === "clarification") {
    return <section className="block block-clarification"><h3>{block.label ?? "Needs your input"}</h3><p><FormattedText text={block.text} /></p></section>;
  }
  if (block.type === "receipt") {
    return <section className="block block-receipt"><h3>{block.label ?? "Done"}</h3><p><FormattedText text={block.text} /></p></section>;
  }
  if (block.type === "email_thread") {
    const fullEmail = containsFullEmail(block.text);
    return (
      <details className="block email-thread">
        <summary>{fullEmail ? "Read full email" : "Email details"} <kbd>O</kbd></summary>
        <div className="email-thread-body"><FormattedText text={block.text} /></div>
      </details>
    );
  }
  return <section className={`block block-${block.type}`}>{block.label && <h3>{block.label}</h3>}<p><FormattedText text={block.text} /></p></section>;
}

function QueuedNoteEditor({
  work,
  onChanged,
  editorId,
  onConflictChanged,
  mutationsDisabled,
  continuityStore,
}: {
  work: WorkItemView;
  onChanged: () => void;
  editorId: string;
  onConflictChanged: (editorId: string, conflicting: boolean) => void;
  mutationsDisabled: boolean;
  continuityStore: WorkspaceContinuityStore;
}) {
  const draft = useConflictAwareValue(
    `${work.feedId}\u0000${work.cardId}\u0000work:${work.id}`,
    work.instruction,
    continuityStore,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(
    () => onConflictChanged(editorId, draft.conflictingServerValue !== null),
    [draft.conflictingServerValue, editorId, onConflictChanged],
  );
  useEffect(() => () => onConflictChanged(editorId, false), [editorId, onConflictChanged]);
  const save = async () => {
    const next = draft.value.trim();
    if (mutationsDisabled || draft.conflictingServerValue !== null || !next || next === work.instruction) return;
    setSaving(true);
    try {
      setSaveError("");
      await post(`/api/feeds/${work.feedId}/work/${work.id}/instruction`, { instruction: next });
      draft.markSaved(next);
      onChanged();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="queued-note">
      <span className="action-label">Queued note</span>
      <textarea aria-label="Queued note" aria-disabled={mutationsDisabled} readOnly={mutationsDisabled} value={draft.value} onInput={(event) => draft.setValue(event.currentTarget.value)} onBlur={() => void save()} rows={Math.max(2, draft.value.split("\n").length)} />
      {draft.conflictingServerValue !== null && (
        <div className="edit-conflict" role="alert">
          <b>The queued note changed while you were editing.</b>
          <p>Your edit is preserved until you choose a version.</p>
          <div className="action-buttons">
            <button className="button ghost" type="button" onClick={draft.useServerValue}>Use Tend version</button>
            <button className="button primary" type="button" onClick={draft.keepLocalValue}>Keep my edit</button>
          </div>
        </div>
      )}
      {saveError && <p className="edit-error" role="alert">Queued note could not be saved: {saveError}</p>}
      <small>{saving ? "Saving..." : "Edit before Codex claims it."}</small>
    </section>
  );
}

function ContextInfluenceReceipt({ card }: { card: Card }) {
  const influence = card.contextInfluence;
  if (!influence) return null;
  const sourceCount = influence.sourceCount ?? 0;
  const signalId = influence.signalIds[0];
  return (
    <section className={`context-influence context-influence-${influence.mode}`}>
      <div className="context-influence-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
      </div>
      <div>
        <span className="context-influence-label">{influence.mode === "research" ? "Prompted by On Your Mind" : "On your mind"}</span>
        <p>{influence.summary}</p>
        {influence.researchQuestion && <small>{influence.researchQuestion}</small>}
        <a href={`/mind/${encodeURIComponent(influence.updateId)}#signal-${encodeURIComponent(signalId)}`} onClick={(event) => event.stopPropagation()}>
          View context and {sourceCount} {sourceCount === 1 ? "source" : "sources"} <span aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  );
}

function connectorAssuranceLabel(card: Card, actions: CardAction[]): string | null {
  const external = actions.find((action) => action.behavior === "approve_action" && action.externalMutation);
  if (!external) return null;
  if (external.execution?.provider === "granola" || external.execution?.provider === "imessage") return "Prepare only · no outbound access";
  if (external.execution?.minimumAssurance === "trusted_adapter" || external.execution?.provider === "custom") {
    return "Trusted adapter receipt required";
  }
  if (external.execution || card.sourceMailbox) return "Connector host identity checked before action";
  return null;
}

export function CardView({
  card,
  queuedNote,
  active,
  onActivate,
  onChanged,
  onAction,
  onReturnToReview,
  isActionPending = () => false,
  mutationsDisabled = false,
  continuityStore = defaultWorkspaceContinuityStore,
  queuedFor,
  domId = card.id,
}: {
  card: Card;
  queuedNote?: WorkItemView;
  active: boolean;
  onActivate: () => void;
  onChanged: () => void;
  onAction: (action: CardAction) => void;
  onReturnToReview: () => void;
  isActionPending?: (action: CardAction) => boolean;
  mutationsDisabled?: boolean;
  continuityStore?: WorkspaceContinuityStore;
  queuedFor?: string;
  domId?: string;
}) {
  const actions = visibleCardActions(card);
  const [conflictingEditors, setConflictingEditors] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setConflictingEditors(new Set()), [card.id]);
  const trackConflict = useCallback((editorId: string, conflicting: boolean) => {
    setConflictingEditors((current) => {
      const next = new Set(current);
      if (conflicting) next.add(editorId);
      else next.delete(editorId);
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, []);
  const editorConflict = conflictingEditors.size > 0;
  const cardMutationsDisabled = mutationsDisabled || editorConflict;
  const nextThing = card.proposedAction?.label === "Decide disposition"
    ? "Dismiss, or tell Codex what to do"
    : card.proposedAction?.label ?? actions.find((action) => action.variant === "primary")?.label ?? actions[0]?.label;
  const assuranceLabel = connectorAssuranceLabel(card, actions);
  return (
    <article className={`attention-card ${card.contextInfluence ? "has-context-influence" : ""} ${active ? "is-active" : ""}`} data-card-id={domId} onClick={onActivate} onMouseEnter={onActivate}>
      <div className="card-rule" />
      <header className="card-head">
        <span className={`kind-dot ${card.kind === "feed_improvement" ? "proposal" : ""}`} />
        <div>
          <div className="eyebrow">{card.eyebrow}</div>
          <h2>{card.title}</h2>
        </div>
      </header>
      <p className="why"><FormattedText text={card.why} /></p>
      <ContextInfluenceReceipt card={card} />
      <div className="blocks">
        {card.blocks.map((block) => (
          <Block
            key={block.id}
            feedId={card.feedId}
            cardId={card.id}
            block={block}
            onChanged={onChanged}
            editorId={`block:${block.id}`}
            onConflictChanged={trackConflict}
            mutationsDisabled={mutationsDisabled}
            continuityStore={continuityStore}
          />
        ))}
      </div>
      {queuedNote && (
        <QueuedNoteEditor
          work={queuedNote}
          onChanged={onChanged}
          editorId="queued-note"
          onConflictChanged={trackConflict}
          mutationsDisabled={mutationsDisabled}
          continuityStore={continuityStore}
        />
      )}
      <CardHistory card={card} />
      {card.status === "approved_blocked" && (
        <footer className="card-action">
          <div>
            <span className="action-label">Already approved</span>
            <b>Waiting for Codex to retry</b>
            {card.sourceMailbox && <small className="reply-mailbox">Reply from {card.sourceMailbox}</small>}
          </div>
        </footer>
      )}
      {actions.length > 0 && (card.status === "to_review_new" || card.status === "to_review_updated") && (
        <footer className="card-action">
          <div>
            <span className="action-label">Next thing</span>
            {nextThing && <b>{nextThing}</b>}
            {card.sourceMailbox && <small className="reply-mailbox">Reply from {card.sourceMailbox}</small>}
            {assuranceLabel && <small className="action-assurance">{assuranceLabel}</small>}
          </div>
          <div className="action-buttons">
            {actions.map((action) => {
              const pending = cardMutationsDisabled || isActionPending(action);
              return (
                <button
                  aria-keyshortcuts={action.shortcut}
                  aria-label={action.label}
                  aria-busy={pending}
                  className={`button ${action.variant === "primary" ? "primary" : "ghost"}`}
                  disabled={pending}
                  key={action.id}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => { event.stopPropagation(); onAction(action); }}
                >
                  {pending ? `${action.label}…` : action.label}
                  {!pending && action.shortcut && <kbd aria-hidden="true">{action.shortcut.toUpperCase()}</kbd>}
                </button>
              );
            })}
          </div>
        </footer>
      )}
      {(card.status === "queued" || card.status === "done") && (
        <footer className="card-action">
          <div>
            <span className="action-label">{card.status === "queued" ? `Queued for ${queuedFor ?? "Codex"}` : "Done"}</span>
            <b>{card.status === "queued" ? `Waiting for ${queuedFor ?? "the feed thread"}` : card.completionDisposition === "dismissed" ? "Dismissed" : "Completed"}</b>
          </div>
          <div className="action-buttons">
            <button disabled={cardMutationsDisabled} className="button ghost" onClick={(event) => { event.stopPropagation(); onReturnToReview(); }}>
              {card.status === "queued" ? "Move back to review" : "Review again"}
            </button>
          </div>
        </footer>
      )}
    </article>
  );
}
