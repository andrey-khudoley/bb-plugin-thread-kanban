// Additive migration: native BB project IDs, issue payloads, workspaces and links stay intact.
export const projectFoldersMigration = `
CREATE TABLE IF NOT EXISTS kanban_project_folders (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kanban_project_materials (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS kanban_project_material_folder ON kanban_project_materials(folder_id);
CREATE VIRTUAL TABLE IF NOT EXISTS kanban_project_chunks USING fts5(folder_id UNINDEXED, material_id UNINDEXED,
  version UNINDEXED, chunk UNINDEXED, title, text, tokenize='unicode61 remove_diacritics 2');`;
