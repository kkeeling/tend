# Life Control Plane Design Reference

These generic wireframes are the visual contract for the workspace surfaces. They intentionally
contain synthetic aliases and no runtime data.

- [`now.svg`](now.svg) shows the ordered cross-feed `Now` surface. Items are existing Tend cards;
  the workspace adds owner, reason, coverage, and optional commitment context.
- [`multi-source-card.svg`](multi-source-card.svg) shows one canonical obligation with several
  attributable source receipts, the existing card-scoped chat, an editable artifact, and an exact
  approval CTA.
- [`coverage-ledger.svg`](coverage-ledger.svg) shows honest per-source coverage beside replayable
  priority decisions. A degraded required source suppresses all-clear.

The implementation should follow the current Tend component and responsive design system rather
than pixel-copying these diagrams. The invariants are more important than decoration:

1. `Now` never creates a second work queue; every action routes to the card's owning feed.
2. An existing attention card can appear without commitment metadata.
3. One commitment can link multiple minimized source receipts without copying raw evidence.
4. Coverage states always disclose their all-clear effect and recovery action.
5. Priority explanations cite an immutable rule and evaluation version.
6. Action controls show their connector assurance level and fail closed when verification changes.

