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
   - `goal`: one non-empty current goal, not an earlier formulation; maximum 200 characters.
   - `next_actions`: one to three executable next actions; maximum 80 characters per item.
   - `acceptance_criteria`, `constraints`, `decisions`, `current_progress`, `negative_knowledge`, and `open_questions`: zero to three concise strings each; maximum 80 characters per item. Leave constraints or acceptance criteria empty when none are known.
   - Every stored string is single-line and contains non-whitespace text.
   - Keep every field within the limits above; do not apply a separate aggregate byte limit.
   - **Unknown stays unknown.** Preserve continuation-critical uncertainty in `open_questions`; never infer missing facts, requirements, results, paths, identifiers, thresholds, or acceptance criteria.
   - **Literals stay literal.** Within the schema bounds, copy execution-critical paths, symbols, commands, IDs, versions, numeric thresholds, limits, hashes, error codes, and explicit negations verbatim.
   - **Polarity stays intact.** Preserve the scope of `negative_knowledge`; keep `do not`, `must not`, `failed`, `not run`, `not verified`, `not validated`, and `unsupported` negative.
   - Keep runtime completion separate from result validation. Record `passed`, `accepted`, or `verified` only when the live evidence establishes it.
   - Preserve failed approaches only as `negative_knowledge`; drop raw logs and exact repetition. Omit a decision, error, plan, assumption, or question only when later evidence explicitly marks it superseded, obsolete, or resolved; never infer that from similar wording.
6. Save the JSON to a temporary file and run `node <runner> semantic --input <file> --thread-id <selector>`.
7. Run `node <runner> status --thread-id <selector>`, then `node <runner> show-context --thread-id <selector>`. Completion requires `semantic_source=manual`, `semantic_generation` equal to the current generation, non-null `semantic_transcript`, `restore_eligible=true`, and the displayed payload matching the live goal, constraints, acceptance criteria, progress, unknowns, negative knowledge, and exact next action. Report `Checkpoint refreshed` with its Goal, Constraints, and Next action; do not add an approval prompt.
8. If this refresh is for an upcoming compact, compact before submitting another normal user prompt; a later prompt intentionally invalidates the pending manual carry-forward.

Native compact remains the primary semantic compressor. Default hooks create only mechanical checkpoints, and empty semantic state is not reinjected. This Skill is explicit-only. The optional sidecar is disabled by default; enable it only for measured long-task recovery with `CONTEXT_CHECKPOINT_SIDECAR_EVERY=N`. It runs before every Nth completed compaction only when the reset-aware unseen backlog is complete, reads that backlog, and uses its accumulated file size for the threshold.
