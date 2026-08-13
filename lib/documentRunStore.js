import crypto from "node:crypto";
import path from "node:path";
import {
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error) {
  return error?.message || String(error || "Unknown error");
}

export class JsonDocumentRunStore {
  constructor({
    filePath,
    historyLimit = 500,
    lockWaitMs = 10_000,
    staleLockMs = 30_000,
    logger = console,
  }) {
    if (!filePath) throw new Error("A document run-store path is required.");
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.historyLimit = Math.max(25, Number(historyLimit) || 500);
    this.lockWaitMs = Math.max(1_000, Number(lockWaitMs) || 10_000);
    this.staleLockMs = Math.max(5_000, Number(staleLockMs) || 30_000);
    this.logger = logger;
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const handle = await open(this.filePath, "wx");
      await handle.writeFile(JSON.stringify({ version: 1, runs: [] }, null, 2));
      await handle.close();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  async acquireLock() {
    const deadline = Date.now() + this.lockWaitMs;
    while (Date.now() < deadline) {
      try {
        await mkdir(this.lockPath);
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const details = await stat(this.lockPath);
          if (Date.now() - details.mtimeMs > this.staleLockMs) {
            await rmdir(this.lockPath);
            continue;
          }
        } catch (statError) {
          if (!["ENOENT", "ENOTEMPTY"].includes(statError?.code)) throw statError;
        }
        await sleep(25 + Math.floor(Math.random() * 50));
      }
    }
    throw new Error("Timed out waiting for the document run-store lock.");
  }

  async releaseLock() {
    try {
      await rmdir(this.lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.error("[document-run-store:unlock]", messageOf(error));
      }
    }
  }

  async withLock(callback) {
    await this.initialize();
    await this.acquireLock();
    try {
      const state = await this.readState();
      const result = await callback(state);
      if (result?.write) await this.writeState(state);
      return result?.value;
    } finally {
      await this.releaseLock();
    }
  }

  async readState() {
    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return {
      version: 1,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  }

  async writeState(state) {
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async enqueue({ triggerId, source }) {
    return this.withLock(async (state) => {
      const existing = state.runs.find((run) => run.trigger_id === triggerId);
      if (existing) return { value: { record: existing, duplicate: true } };

      const record = {
        id: crypto.randomUUID(),
        trigger_id: triggerId,
        source: String(source || "api").slice(0, 100),
        status: "queued",
        requested_at: iso(),
        started_at: null,
        completed_at: null,
        duration_ms: 0,
        worker_id: "",
        lease_expires_at: null,
        counts: {},
        errors: [],
      };
      state.runs.push(record);
      if (state.runs.length > this.historyLimit) {
        state.runs.splice(0, state.runs.length - this.historyLimit);
      }
      return { value: { record, duplicate: false }, write: true };
    });
  }

  async get(id) {
    return this.withLock(async (state) => ({
      value: state.runs.find((run) => run.id === id) || null,
    }));
  }

  async claimNext({ workerId, leaseMs }) {
    return this.withLock(async (state) => {
      const now = Date.now();
      let changed = false;
      for (const run of state.runs) {
        if (
          run.status === "running" &&
          (!run.lease_expires_at || Date.parse(run.lease_expires_at) <= now)
        ) {
          run.status = "queued";
          run.worker_id = "";
          run.lease_expires_at = null;
          run.errors = [
            ...(Array.isArray(run.errors) ? run.errors : []),
            {
              scope: "worker",
              message: "Recovered after the previous worker lease expired.",
            },
          ];
          changed = true;
        }
      }

      const run = state.runs.find((item) => item.status === "queued");
      if (!run) return { value: null, write: changed };

      run.status = "running";
      run.worker_id = workerId;
      run.started_at = run.started_at || iso(now);
      run.completed_at = null;
      run.lease_expires_at = iso(now + leaseMs);
      return { value: { ...run }, write: true };
    });
  }

  async heartbeat(id, workerId, leaseMs) {
    return this.withLock(async (state) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run || run.status !== "running" || run.worker_id !== workerId) {
        return { value: false };
      }
      run.lease_expires_at = iso(Date.now() + leaseMs);
      return { value: true, write: true };
    });
  }

  async complete(id, workerId, outcome) {
    return this.withLock(async (state) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run) throw new Error("Document run not found.");
      if (run.worker_id !== workerId || run.status !== "running") {
        throw new Error("Document run ownership was lost before completion.");
      }
      const started = Date.parse(run.started_at || run.requested_at);
      run.status = outcome.status;
      run.completed_at = iso();
      run.duration_ms = Math.max(0, Date.now() - started);
      run.lease_expires_at = null;
      run.counts = outcome.counts || {};
      run.errors = outcome.errors || [];
      return { value: { ...run }, write: true };
    });
  }
}
