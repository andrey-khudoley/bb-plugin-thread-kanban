import assert from "node:assert/strict";
import test from "node:test";
import { preferenceFor, resolvePreference } from "./settings-catalog.ts";

function model(id, defaultReasoningEffort, efforts, isDefault = false) {
  return {
    model: id,
    isDefault,
    defaultReasoningEffort,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
  };
}

const primary = model("primary", "low", ["low", "high"], true);
const alternate = model("alternate", "medium", ["medium", "high"]);
const simple = model("simple", "", []);
const current = { providerId: "fallback", model: "fallback-model", reasoningLevel: "high" };

function provider(id, available = true, serviceTiers = []) {
  return { id, available, serviceTiers, capabilities: { supportsServiceTier: serviceTiers.length > 0 } };
}

function resolve(saved, models, available = true, serviceTiers = []) {
  return resolvePreference({
    async models({ providerId }) {
      return providerId === "preferred"
        ? { providers: [provider("preferred", available, serviceTiers)], models }
        : { providers: [provider("fallback")], models: [primary] };
    },
  }, current, { providerId: "preferred", ...saved }, new AbortController().signal);
}

test("uses saved reasoning only if the selected model supports it", async () => {
  assert.deepEqual(await resolve({ model: "alternate", reasoningLevel: "high" }, [primary, alternate]),
    { providerId: "preferred", model: "alternate", reasoningLevel: "high" });
  assert.deepEqual(await resolve({ model: "alternate", reasoningLevel: "low" }, [primary, alternate]),
    { providerId: "preferred", model: "alternate", reasoningLevel: "medium" });
});

test("uses the replacement model's own default even if it supports the old effort", async () => {
  assert.deepEqual(await resolve({ model: "removed", reasoningLevel: "high" }, [alternate, primary]),
    { providerId: "preferred", model: "primary", reasoningLevel: "low" });
});

test("falls back to an available provider when the saved one is unavailable", async () => {
  assert.deepEqual(await resolve({ model: "alternate", reasoningLevel: "high" }, [], false),
    { providerId: "fallback", model: "primary", reasoningLevel: "low" });
});

test("omits effort for models with no selectable levels", () => {
  assert.deepEqual(preferenceFor(provider("preferred"), simple, { reasoningLevel: "high" }),
    { providerId: "preferred", model: "simple" });
});

test("resolves saved speed against provider and model tiers", async () => {
  const tiers = [{ id: "fast", label: "Fast" }, { id: "ultrafast", label: "Ultrafast" }];
  const fastModel = { ...primary, supportedServiceTiers: [tiers[0]] };
  const compatible = await resolve({ model: primary.model, serviceTier: "fast" }, [fastModel], true, tiers);
  const unsupported = await resolve({ model: primary.model, serviceTier: "ultrafast" }, [fastModel], true, tiers);
  const replaced = await resolve({ model: "removed", serviceTier: "fast" }, [fastModel], true, tiers);
  const inherited = await resolve({ model: primary.model, serviceTier: "fast" }, [primary], true, tiers);
  const legacy = await resolve({ model: primary.model }, [fastModel], true, tiers);
  assert.equal(compatible.serviceTier, "fast");
  assert.equal(unsupported.serviceTier, "default");
  assert.equal(replaced.serviceTier, "default");
  assert.equal(inherited.serviceTier, "fast");
  assert.equal(legacy.serviceTier, undefined);
  assert.equal(preferenceFor(provider("preferred"), fastModel, { serviceTier: "fast" }).serviceTier, undefined);
});
