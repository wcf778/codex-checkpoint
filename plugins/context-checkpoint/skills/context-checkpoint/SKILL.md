---
name: context-checkpoint
description: Refresh or inspect a structured task checkpoint for a long Codex task before handoff, phase change, resume, or repeated compaction. Use only when semantic state recovery is worth an extra model pass; routine compaction is handled by deterministic hooks and native compaction.
---

# Context Checkpoint

Use this skill only for a semantic refresh. The hooks already capture transcript deltas and workspace state without model tokens.

1. Resolve this skill directory, then set the runner to `../../hooks/context-checkpoint.cjs`.
2. Run `node <runner> sessions`. Use its `selector` for the current root task or agent and pass `--thread-id <selector>` to every following command; if the current thread cannot be identified, stop rather than guessing.
3. Run `node <runner> status --thread-id <selector>`. Stop when it reports no checkpoint.
4. Run `node <runner> show --thread-id <selector>`. When current semantics are insufficient, inspect only the `unseen_delta_paths` named by `status`; retention preserves every generation newer than the current `semantic_generation`.
5. Reconcile the live task into this exact JSON shape:
   - `goal`: the current goal, not an earlier formulation; maximum 200 characters.
   - `acceptance_criteria`, `constraints`, `decisions`, `current_progress`, `negative_knowledge`, `open_questions`, `next_actions`: at most three concise strings each, maximum 50 characters per string.
   - Preserve failed approaches only as `negative_knowledge`; drop raw logs, repetition, superseded plans, and resolved questions.
6. Save the JSON to a temporary file and run `node <runner> semantic --input <file> --thread-id <selector>`.
7. Run `node <runner> show --thread-id <selector>`. Completion requires the displayed checkpoint to match the live goal, constraints, progress, unresolved work, and exact next action.

Native compact remains the default semantic recovery path. Empty mechanical checkpoints are not reinjected. The optional sidecar is disabled by default; enable it only for measured long-task recovery with `CONTEXT_CHECKPOINT_SIDECAR_EVERY=N`. It runs before every Nth completed compaction, reads all retained deltas unseen by the last semantic checkpoint, and uses their accumulated byte size for the threshold.
