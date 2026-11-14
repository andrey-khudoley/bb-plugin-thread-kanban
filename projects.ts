import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1);
export const projectsChanged = "projects-changed";
export const projectName = z.string().trim().min(1, "Введи название раздела.");
const projectRemoval = z.object({
  mode: z.enum(["personal", "delete"]), name: z.string(), tasks: z.number().int().nonnegative(), confirmation: id,
});
export const projectRpc = defineRpcContract({
  projectOrder: { input: z.null(), output: z.array(id) },
  projectPersonalGroups: { input: z.null(), output: z.array(id) },
  projectRemovalPreview: { input: z.object({ projectId: id }), output: projectRemoval },
  projectRemove: {
    input: z.object({ projectId: id, confirmation: id }), output: z.object({ mode: z.enum(["personal", "delete"]) }),
  },
  projectRestore: { input: z.object({ projectId: id }), output: z.null() },
  projectMove: {
    input: z.object({ projectId: id, direction: z.enum(["up", "down"]), baseline: z.array(id).max(10000) }),
    output: z.array(id),
  },
  projectRename: {
    input: z.object({ projectId: id, name: projectName }), output: z.null(),
  },
});

export const personalGroupsKey = "personal-project-groups";
