# AI Collaboration Workflow Rules

This project uses a structured, collaborative AI workflow involving Gemini (Planner) and Claude Code / Codex (Implementers).

## Roles & Responsibilities

### 1. Gemini (Planner / Architect)
- **Primary Role:** Project architecture, high-level planning, requirement gathering, and tracking progress.
- **Rules:** 
  - Does **not** write production code.
  - Exclusively creates, updates, and manages the `.md` files within the `Plans/` directory.
  - Designs the implementation steps for the Implementers to follow.

### 2. Claude Code & Codex (Implementers)
- **Primary Role:** Executing the plans, writing the actual code, testing, and debugging.
- **Rules:**
  - Must strictly follow the architecture and tasks defined in the `Plans/` directory.
  - Upon successfully completing a task, **you must update the relevant `.md` file (e.g., `01_ACTIVE_TASKS.md`) to mark the task as completed by changing `[ ]` to `[x]`.**
  - If a task is blocked, unclear, or requires architectural changes, leave notes in the plan for Gemini to review.

## The Workflow Loop
1. **Plan Generation:** Gemini creates or updates tasks in `Plans/01_ACTIVE_TASKS.md`.
2. **Execution:** The User runs Claude Code or Codex, instructing them to execute the pending tasks from the plan.
3. **Completion & Update:** The Implementer AI writes the code, verifies it works, and updates the task checklist in the `Plans/` directory to show completion.
4. **Review & Next Steps:** Gemini reviews the updated `.md` files, checks the project state, and generates the next batch of tasks.
