# Changelog

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
