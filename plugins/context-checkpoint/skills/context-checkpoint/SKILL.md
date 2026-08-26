---
name: context-checkpoint
description: Refresh or inspect a structured task checkpoint for a long Codex task before handoff, phase change, resume, or repeated compaction. Use only when semantic state recovery is worth an extra model pass; routine compaction is handled by deterministic hooks and native compaction.
---

# Context Checkpoint

Use this skill only for a semantic refresh. The hooks already capture transcript deltas and workspace state without model tokens.

1. Resolve this skill directory, then set the runner to `../../hooks/context-checkpoint.cjs`.
2. Run `node <runner> sessions`. Use its `selector` for the current root task or agent and pass `--thread-id <selector>` to every following command; if the current thread cannot be identified, stop rather than guessing.
3. Run `node <runner> status --thread-id <selector>`. Stop when it reports no complete checkpoint. If `semantic_backlog_complete` is false, stop for missing/corrupt history or delta evidence and report the reason. For `delta_skipped-too-large` only, report the explicit mechanical gap and continue only to establish a manual baseline from the live task; do not claim the missing bytes were reviewed.
4. Run `node <runner> show --thread-id <selector>`. When the backlog is complete and current semantics are insufficient, inspect only the `unseen_delta_paths` named by `status`; reset deltas supersede older paths, and retention preserves every generation newer than the current `semantic_generation`.
5. Reconcile the live task into this exact JSON shape:
   - `goal`: the current goal, not an earlier formulation; maximum 200 characters.
   - `acceptance_criteria`, `constraints`, `decisions`, `current_progress`, `negative_knowledge`, `open_questions`, `next_actions`: at most three concise strings each, maximum 50 characters per string.
   - Keep the complete restore payload within 2,500 UTF-8 bytes; shorten the semantic record if validation rejects it.
   - Preserve failed approaches only as `negative_knowledge`; drop raw logs, repetition, superseded plans, and resolved questions.
6. Save the JSON to a temporary file and run `node <runner> semantic --input <file> --thread-id <selector>`.
7. Run `node <runner> status --thread-id <selector>`. Completion requires `semantic_source=manual`, `semantic_generation` equal to the current generation, non-null `semantic_transcript`, `restore_eligible=true`, and semantic fields matching the live goal, constraints, progress, unresolved work, and exact next action.
8. If this refresh is for an upcoming compact, compact before submitting another normal user prompt; a later prompt intentionally invalidates the pending manual carry-forward.

Native compact remains the primary semantic compressor. Default hooks create only mechanical checkpoints, and empty semantic state is not reinjected. This Skill is explicit-only. The optional sidecar is disabled by default; enable it only for measured long-task recovery with `CONTEXT_CHECKPOINT_SIDECAR_EVERY=N`. It runs before every Nth completed compaction only when the reset-aware unseen backlog is complete, reads that backlog, and uses its accumulated file size for the threshold.
