import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { JsonDocumentRunStore } from "../lib/documentRunStore.js";
import { DocumentRunCoordinator } from "../lib/documentRunCoordinator.js";

async function withStore(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paf-document-runs-"));
  try {
    const filePath = path.join(directory, "runs.json");
    await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("enqueue is idempotent by trigger id", async () => {
  await withStore(async (filePath) => {
    const store = new JsonDocumentRunStore({ filePath });
    const first = await store.enqueue({ triggerId: "trigger-0001", source: "test" });
    const second = await store.enqueue({ triggerId: "trigger-0001", source: "test" });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.record.id, first.record.id);
  });
});

test("two Passenger-style workers execute a queued run only once", async () => {
  await withStore(async (filePath) => {
    const storeA = new JsonDocumentRunStore({ filePath });
    const storeB = new JsonDocumentRunStore({ filePath });
    let executions = 0;
    const runBuilder = async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "completed", counts: { instances_completed: 5 } };
    };
    const workerA = new DocumentRunCoordinator({ store: storeA, runBuilder });
    const workerB = new DocumentRunCoordinator({ store: storeB, runBuilder });
    const { record } = await storeA.enqueue({
      triggerId: "trigger-0002",
      source: "test",
    });

    await Promise.all([workerA.drain(), workerB.drain()]);

    const completed = await storeA.get(record.id);
    assert.equal(executions, 1);
    assert.equal(completed.status, "completed");
    assert.equal(completed.counts.instances_completed, 5);
  });
});
