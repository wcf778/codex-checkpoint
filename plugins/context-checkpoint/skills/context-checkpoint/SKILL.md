---
name: context-checkpoint
description: Refresh or inspect a structured task checkpoint for a long Codex task before handoff, phase change, resume, or repeated compaction. Use only when semantic state recovery is worth an extra model pass; routine compaction is handled by deterministic hooks and native compaction.
---

# Context Checkpoint

Use this skill only for a semantic refresh. The hooks already capture transcript deltas and workspace state without model tokens.

1. Resolve this skill directory, then set the runner to `../../hooks/context-checkpoint.cjs`.
2. Run `node <runner> sessions`. With one session, continue. With multiple sessions, identify the current one and pass `--session-id <id>` to every following command; if the current session cannot be identified, stop rather than updating the latest session by guess.
3. Run `node <runner> status [--session-id <id>]`. Stop when it reports no checkpoint.
4. Run `node <runner> show [--session-id <id>]` and inspect only the unseen delta paths named by the status when current semantics are insufficient.
5. Reconcile the live task into this exact JSON shape:
   - `goal`: the current goal, not an earlier formulation; maximum 200 characters.
   - `acceptance_criteria`, `constraints`, `decisions`, `current_progress`, `negative_knowledge`, `open_questions`, `next_actions`: at most three concise strings each, maximum 50 characters per string.
   - Preserve failed approaches only as `negative_knowledge`; drop raw logs, repetition, superseded plans, and resolved questions.
6. Save the JSON to a temporary file and run `node <runner> semantic --input <file> [--session-id <id>]`.
7. Run `node <runner> show [--session-id <id>]`. Completion requires the displayed checkpoint to match the live goal, constraints, progress, unresolved work, and exact next action.

Native compact remains the default semantic recovery path. Empty mechanical checkpoints are not reinjected. The optional sidecar is disabled by default; enable it only for measured long-task recovery with `CONTEXT_CHECKPOINT_SIDECAR_EVERY=N`. It runs before every Nth completed compaction, reads all deltas unseen by the last semantic checkpoint, and only runs when the current delta meets the byte threshold.
