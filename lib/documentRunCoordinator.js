import crypto from "node:crypto";

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

function messageOf(error) {
  return error?.message || String(error || "Unknown error");
}

export function normalizeOutcome(result) {
  const requested = String(result?.status || "completed").toLowerCase();
  return {
    status: TERMINAL_STATUSES.has(requested) ? requested : "completed",
    counts: result?.counts || {},
    errors: Array.isArray(result?.errors) ? result.errors : [],
  };
}

export class DocumentRunCoordinator {
  constructor({
    store,
    runBuilder,
    pollMs = 15_000,
    leaseMs = 15 * 60_000,
    heartbeatMs = 30_000,
    logger = console,
  }) {
    this.store = store;
    this.runBuilder = runBuilder;
    this.pollMs = Math.max(1_000, Number(pollMs) || 15_000);
    this.leaseMs = Math.max(60_000, Number(leaseMs) || 15 * 60_000);
    this.heartbeatMs = Math.max(5_000, Number(heartbeatMs) || 30_000);
    this.logger = logger;
    this.workerId = `${process.pid}-${crypto.randomUUID()}`;
    this.draining = false;
    this.pendingDrain = false;
    this.started = false;
    this.timer = null;
  }

  async enqueue({ triggerId, source = "api" }) {
    const result = await this.store.enqueue({ triggerId, source });
    this.wake();
    return result;
  }

  async getRun(id) {
    return this.store.get(id);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.wake();
    this.timer = setInterval(() => this.wake(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  wake() {
    if (this.draining) {
      this.pendingDrain = true;
      return;
    }
    setImmediate(() => {
      this.drain().catch((error) =>
        this.logger.error("[document-run-worker:drain]", messageOf(error)),
      );
    });
  }

  async drain() {
    if (this.draining) {
      this.pendingDrain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.pendingDrain = false;
        const run = await this.store.claimNext({
          workerId: this.workerId,
          leaseMs: this.leaseMs,
        });
        if (!run) break;
        await this.execute(run);
      } while (true);
    } finally {
      this.draining = false;
      if (this.pendingDrain) this.wake();
    }
  }

  async execute(run) {
    const heartbeat = setInterval(() => {
      this.store
        .heartbeat(run.id, this.workerId, this.leaseMs)
        .catch((error) =>
          this.logger.error("[document-run-worker:heartbeat]", messageOf(error)),
        );
    }, this.heartbeatMs);
    heartbeat.unref?.();

    try {
      const outcome = normalizeOutcome(await this.runBuilder({ runId: run.id }));
      await this.store.complete(run.id, this.workerId, outcome);
    } catch (error) {
      await this.store.complete(run.id, this.workerId, {
        status: "failed",
        counts: {},
        errors: [{ scope: "document-service", message: messageOf(error) }],
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
