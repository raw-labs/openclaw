Related: #196643

## What Problem This Solves

Template authors can describe an agent, but users have no way to choose a first task during installation. New chats also show generic suggestions for purpose-built agents.

## User Impact

Agent authors can set an optional description and up to three recommended prompts. Users can select a prompt when adding a Template or in a new chat with the installed agent.

## Why This Change Was Made

Template Add carries the selection through the existing consent flow. The Gateway finishes installation, seeds `BOOTSTRAP.md`, and starts an opening turn before releasing the chat. The opening turn instructs the agent to ask any setup questions and wait for answers before addressing the selected task. The model handles that sequence through instructions in the opening turn. If the opening fails, the user keeps the installed agent and can continue in its chat.

## Evidence

- Recorded on commit `f40feacd8` with the built Control UI, an isolated Gateway, and a local Qwen3 4B model. A synthetic Template supplied the prompt and bootstrap file. The model asked for the repository, waited for the user's reply, then drafted the selected update.
- Gateway regression tests cover chat readiness after the opening reply and retention when the opening fails. All 27 Control UI Template Add tests pass.
- The PR wrapper inventory check passes. The cold-provisioning suite passed 17 tests, skipped one platform-specific case, and timed out in the full cold/warm sibling case.
- Core and Control UI typechecks, generated config and Gateway validator checks, and the test-line budget pass.
- The Control UI asset budget remains over its limits.

https://github.com/user-attachments/assets/6d740f07-5212-4dab-8b4c-0895e6f270d1

| Before | After |
| --- | --- |
| ![Template install before prompt choices](https://github.com/user-attachments/assets/2b195383-359b-42ab-aa36-e84892833b8f?raw=1) | ![Template install with recommended prompts](https://github.com/user-attachments/assets/b4c7302c-5bbb-4e11-acc4-0a1a778b173c?raw=1) |

[Phone layout](https://github.com/user-attachments/assets/9b3602f7-49d7-48ea-ba3e-e1363ed3bcdb?raw=1)

Contributor credit: Miguel Branco.
