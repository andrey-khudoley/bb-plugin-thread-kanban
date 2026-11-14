# Changelog

## Unreleased

- Kept card positions fixed when extraction drop targets appear, preventing native drags from being cancelled near the top of a card.
- Restored native card dragging from title buttons on the board and in lists, with the whole card as the drag preview and accidental clicks suppressed after dragging.
- Restored keyboard focus after dismissing compact project and transfer drawers, including when their owner unmounts immediately.
- Separated drag intent: project targets preserve card stage, columns preserve project membership, and extraction requires the explicit ungroup target or menu action. Empty-project drops reveal the card at its retained stage.
- Unified project, stage and position changes in atomic card transfers with guarded undo, including batch moves and list reordering that preserves stages.
- Added direct project/card menu actions, destination dialogs, explicit extraction targets, drag previews and automatic destination disclosure.
- Reworked project membership into searchable members/additions with batch actions, stage editing and an undo action inside the project window.
- Added keyboard tab navigation, focus restoration, explicit chat-to-project conversion and retryable card creation failures.
- Redesigned project groups with a clear heading, visible/total counts, compact timer and direct assistant/materials/cards menu.
- Preserved standalone card width, typography and surfaces inside projects; removed nested scrolling and added empty, focus and drag target states.
- Replaced boxed project headings with flat group headings and raised the minimum column width to keep card titles readable in split panes.
- Allowed deleting nonempty project folders while returning all cards to their existing section stages without changing chats, history or order.
- Clarified the confirmation for removing project materials and assistant conversation while preserving cards.

## 0.4.0

- Renamed native BB projects to sections in Kanban while preserving IDs, workspaces, links and data.
- Added optional project folders, card assignment and extraction, grouped board/list display and narrow layouts.
- Added durable cumulative project activity timers with pause/resume when membership or stages change.
- Added a project assistant, shared UTF-8 text materials, extraction states and local FTS5 RAG with versioned sources.
- Scoped agent retrieval to current card membership and invalidated obsolete material chunks on updates and deletion.
- Added controlled-clock, migration, retrieval-isolation, assistant and folder-interface checks.

- Move task cards to review after successful turns even when the agent's final reply is empty.
- Recover missed completion transitions on startup from bounded lifecycle reads, preserving manual statuses, active work, queued messages, interruptions and errors.

## 0.3.0

- Integrated the complete status bar, bell, notification popups and sound into the Kanban plugin.
- Migrated the former status-bar history, read and hidden states, event cursors and sound settings once, retaining its source database for rollback.
- Kept completion and structured input events deduplicated across recovery, concurrent agents and interface reloads.
- Added manual-view acknowledgement, popup and bell dismissal, clear-all and notification navigation that follows the current Kanban or chat mode.
- Namespaced notification RPC methods to preserve the existing Kanban settings API.
- Included notification behavior and migration checks in the unified package tests.

## 0.2.1

- Prepare a standalone public Git release with installation instructions and catalog metadata.
- Keep the extracted status-bar integration optional for independent installation.
- Include the latest fixes for card materials and task-activity notifications.

## 0.2.0

- Include Kanban settings and new-chat defaults in the Kanban plugin.
- Migrate existing chat-defaults preferences, panel placement and headers once, without deleting the old storage.
- Resolve launch settings locally and refresh launch controls when integrated settings change.
- Remove the separate settings plugin from the developer deployment manifest.
- Use standard BB updates in the distributed settings UI; workspace-deploy remains optional.
- Add installation instructions, package contents validation and a release archive without private BB data or local paths.

## 0.1.0

- Project-based task and chat board, task planning assistant, hierarchy, workspaces and Git workflows.
