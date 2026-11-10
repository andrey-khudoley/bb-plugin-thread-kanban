import assert from "node:assert/strict";
import test from "node:test";
import { createDraftStore } from "./panel-drafts.ts";

function browserStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("restores task fields and chat drafts independently after reopening or reloading the panel", () => {
  const storage = browserStorage();
  const openChat = () => createDraftStore("chat", { text: "" }, (value) => value, () => storage);
  const openForm = () => createDraftStore("form", { title: "", tags: "" }, (value) => value, () => storage);
  const chats = openChat();
  const forms = openForm();
  const message = { text: "Продолжение сообщения" };
  const fields = { title: "Частично заполненная задача", tags: "Test, " };
  const unsubscribe = chats("first").subscribe(() => {});
  chats("first").update(() => message);
  forms("first").update(() => fields);
  unsubscribe();

  assert.deepEqual(chats("second").get(), { text: "" });
  assert.deepEqual(forms("second").get(), { title: "", tags: "" });
  assert.deepEqual(chats("first").get(), message);
  assert.deepEqual(forms("first").get(), fields);
  assert.deepEqual(openChat()("first").get(), message);
  assert.deepEqual(openForm()("first").get(), fields);

  forms("first").clear();
  assert.deepEqual(openForm()("first").get(), { title: "", tags: "" });
  assert.deepEqual(openChat()("first").get(), message);
});

test("a delayed acknowledgement clears only the submitted revision", () => {
  const storage = browserStorage();
  const open = () => createDraftStore("chat", { text: "" }, (value) => value, () => storage);
  const chat = open()("first");
  chat.update(() => ({ text: "Отправляемый текст" }));
  const submitted = chat.get();
  chat.update(() => ({ text: "Следующее сообщение" }));
  chat.update(() => ({ text: submitted.text }));

  chat.clear(submitted);
  assert.notEqual(chat.get(), submitted);
  assert.equal(open()("first").get().text, submitted.text);

  chat.clear(chat.get());
  assert.equal(chat.get().text, "");
  assert.equal(open()("first").get().text, "");
});
