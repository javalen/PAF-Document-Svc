// server.js (DROP-IN)
// ✅ Fixes "Missing or invalid auth collection context" by using admin auth
// ✅ One PB client per instance; admin auth cached per instance
// ✅ Multi-instance env support preserved

import PocketBase from "pocketbase";
import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { createServiceAuth } from "./lib/serviceAuth.js";
import { JsonDocumentRunStore } from "./lib/documentRunStore.js";
import { DocumentRunCoordinator } from "./lib/documentRunCoordinator.js";

/**
 * CONFIG
 *
 * Supported env patterns:
 *  - Single instance:
 *      POCKET_BASE_URL
 *
 *  - Multiple instances:
 *      POCKET_BASE_URL_1
 *      POCKET_BASE_URL_2
 *      ...
 *
 * Auth:
 *  - RGN_USER / RGN_PASS must be PocketBase admin/superuser credentials
 */

function loadInstancesFromEnv() {
  const instances = [];

  // Base (non-suffixed) pair
  if (process.env.POCKET_BASE_URL) {
    instances.push({
      name: "default",
      baseUrl: process.env.POCKET_BASE_URL,
      emailHost: process.env.EMAIL_HOST || "https://email.predictaf.com",
    });
  }

  // Numbered PocketBase instances
  for (let i = 1; i <= 20; i++) {
    const url = process.env[`POCKET_BASE_URL_${i}`];
    if (!url) continue;

    instances.push({
      name: `instance_${i}`,
      baseUrl: url,
      emailHost:
        process.env[`EMAIL_HOST_${i}`] ||
        process.env.EMAIL_HOST ||
        "https://email.predictaf.com",
    });
  }

  if (instances.length === 0) {
    console.error(
      "No PocketBase instances configured. Define POCKET_BASE_URL or at least one numbered POCKET_BASE_URL_n value."
    );
    process.exit(1);
  }

  return instances;
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const OUTBOUND_REQUEST_TIMEOUT_MS = positiveIntegerEnv(
  "OUTBOUND_REQUEST_TIMEOUT_MS",
  30_000
);

const INSTANCE_CONFIGS = loadInstancesFromEnv();
/**
 * Build runtime contexts: one PocketBase client per instance.
 */
const INSTANCE_CONTEXTS = INSTANCE_CONFIGS.map((cfg) => {
  const pb = new PocketBase(cfg.baseUrl);
  pb.autoCancellation(false);

  return {
    name: cfg.name,
    baseUrl: cfg.baseUrl,
    emailHost: cfg.emailHost.replace(/\/+$/, ""),
    pb,
  };
});

/**
 * ✅ Admin auth helper (NOT collection auth)
 * PocketBase only allows authWithPassword() on AUTH collections.
 * For server/cron jobs, use adminAuthWithPassword() once, then query/update any collection.
 */
// ✅ Admin auth helper (version-safe)
async function ensureAdminAuth(ctx) {
  const { pb, name } = ctx;

  // already authenticated
  if (pb?.authStore?.isValid) return;

  const email = process.env.RGN_USER;
  const pass = process.env.RGN_PASS;

  if (!email || !pass) {
    throw new Error(
      `[${name}] Missing RGN_USER / RGN_PASS env vars (PocketBase admin credentials required).`
    );
  }

  // ---- PocketBase JS SDK variations ----
  // Newer SDK: pb.admins.authWithPassword(email, pass)
  if (pb?.admins?.authWithPassword) {
    await pb.admins.authWithPassword(email, pass);
    return;
  }

  // Some SDKs: pb.adminAuthWithPassword(email, pass)
  if (pb?.adminAuthWithPassword) {
    await pb.adminAuthWithPassword(email, pass);
    return;
  }

  // Fallback: authenticate against the admin auth collection directly
  // (commonly "_superusers" in newer PocketBase)
  try {
    await pb.collection("_superusers").authWithPassword(email, pass);
    return;
  } catch (e) {
    // If your PB uses a different admin auth collection name, this will fail.
    // At that point we want a clear error.
    throw new Error(
      `[${name}] Could not admin-auth with this PocketBase SDK. ` +
        `Tried pb.admins.authWithPassword, pb.adminAuthWithPassword, and _superusers auth. ` +
        `Original: ${e?.message || e}`
    );
  }
}

/**
 * Email service: call external /update-document endpoint
 * (instance-aware via ctx)
 */
async function sendExpiryEmail(ctx, doc, context) {
  const baseUrl = ctx.emailHost.replace(/\/+$/, "");
  const url = `${baseUrl}/update-document`;

  const payload = {
    pbHost: ctx.baseUrl,
    record: {
      id: doc.id,
      name: doc.name,
      facility_id: doc.facility_id ?? doc.facility ?? null,
      client_id: doc.client_id ?? null,
      expire_date: doc.expire_date,
    },
    ...context,
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
    });

    if (!resp.ok) {
      let text = "";
      try {
        text = await resp.text();
      } catch {
        /* ignore */
      }
      console.error(
        `[${ctx.name}][EMAIL] /update-document responded with ${resp.status} ${resp.statusText}. Body: ${text}`
      );
    } else {
      console.log(
        `[${ctx.name}][EMAIL] Called /update-document for doc "${doc.name}" (id: ${doc.id})`
      );
    }
  } catch (err) {
    console.error(
      `[${ctx.name}][EMAIL] Failed to call /update-document for doc "${doc.name}" (id: ${doc.id}):`,
      err
    );
  }
}

/**
 * Email service for vendor doc issues (instance-aware)
 */
async function sendVendorDocsEmail(ctx, vendor, context) {
  const baseUrl = ctx.emailHost.replace(/\/+$/, "");
  const url = `${baseUrl}/vendor-docs-email`;

  const payload = {
    pbHost: ctx.baseUrl,
    record: {
      id: vendor.id,
      name: vendor.name,
      email: vendor.email,
      w9: vendor.w9 || null,
      coi: vendor.coi || null,
      coi_exp_date: vendor.coi_exp_date || null,
      client: vendor.client || vendor.client_id || null,
    },
    ...context,
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
    });

    if (!resp.ok) {
      let text = "";
      try {
        text = await resp.text();
      } catch {
        /* ignore */
      }
      console.error(
        `[${ctx.name}][EMAIL] /vendor-docs-email responded with ${resp.status} ${resp.statusText}. Body: ${text}`
      );
    } else {
      console.log(
        `[${ctx.name}][EMAIL] Called /vendor-docs-email for vendor "${vendor.name}" (id: ${vendor.id})`
      );
    }
  } catch (err) {
    console.error(
      `[${ctx.name}][EMAIL] Failed to call /vendor-docs-email for vendor "${vendor.name}" (id: ${vendor.id}):`,
      err
    );
  }
}

/**
 * Helper: difference in whole days (target - base)
 */
function diffInDays(target, base) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const utcTarget = Date.UTC(
    target.getFullYear(),
    target.getMonth(),
    target.getDate()
  );
  const utcBase = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());
  return Math.round((utcTarget - utcBase) / msPerDay);
}

/**
 * Core routine: checks facility_documents and updates flags.
 * Instance-aware via ctx.
 */
async function checkFacilityDocuments(ctx) {
  const COLLECTION_NAME = "facility_documents";
  const { pb } = ctx;
  pb.autoCancellation(false);

  // ✅ FIX: Admin auth (not collection auth)
  await ensureAdminAuth(ctx);

  const docs = await pb.collection(COLLECTION_NAME).getFullList({
    filter: `expire_date != "" && archived=false`,
    sort: "expire_date",
  });

  console.log(`[${ctx.name}] Docs processing`, docs.length);

  const now = new Date();
  let updatedCount = 0;

  for (const doc of docs) {
    const updates = {};
    if (!doc.expire_date) continue;

    const expDate = new Date(doc.expire_date);
    const daysUntil = diffInDays(expDate, now);

    const reminderDate = doc.reminder_date ? new Date(doc.reminder_date) : null;
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);

    // --- Expiration within next 60 days (0–60) ---
    if (daysUntil >= 0 && daysUntil <= 60) {
      const reminderIsOldEnough = !reminderDate || reminderDate <= sevenDaysAgo;

      if (reminderIsOldEnough) {
        await sendExpiryEmail(ctx, doc, { reason: "expires_soon", daysUntil });
        updates.reminder_date = now.toISOString();
        updates.reminder_sent = true;
      }

      if (!doc.expires_soon) updates.expires_soon = true;

      // NOTE: this block never triggers because daysUntil >= 0 here, but kept for parity
      if (daysUntil < 0 && !doc.expired) updates.expired = true;
    }
    // --- Expiration in the past ---
    else if (daysUntil < 0) {
      if (!doc.expired) updates.expired = true;
      if (doc.expires_soon) updates.expires_soon = false;
    }
    // --- Expiration NOT within 60 days (> 60 days out) ---
    else if (daysUntil > 60) {
      if (doc.expires_soon) updates.expires_soon = false;
      if (doc.reminder_sent) updates.reminder_sent = false;
      if (doc.reminder_date) updates.reminder_date = null;
    }

    if (Object.keys(updates).length > 0) {
      await pb.collection(COLLECTION_NAME).update(doc.id, updates);
      updatedCount++;
      console.log(
        `[${ctx.name}] Updated document "${doc.name}" (id: ${doc.id}) with:`,
        updates
      );
    }
  }

  return { totalDocs: docs.length, updatedCount };
}

/**
 * Core routine: checks system_documents and updates flags.
 * Instance-aware via ctx.
 */
async function checkSystemDocuments(ctx) {
  const COLLECTION_NAME = "system_documents";
  const { pb } = ctx;
  pb.autoCancellation(false);

  // ✅ FIX: Admin auth (not collection auth)
  await ensureAdminAuth(ctx);

  const docs = await pb.collection(COLLECTION_NAME).getFullList({
    filter: `expire_date != "" && archived=false`,
    sort: "expire_date",
  });

  console.log(`[${ctx.name}] System Docs processing`, docs.length);

  const now = new Date();
  let updatedCount = 0;

  for (const doc of docs) {
    const updates = {};
    if (!doc.expire_date) continue;

    const expDate = new Date(doc.expire_date);
    const daysUntil = diffInDays(expDate, now);

    const reminderDate = doc.reminder_date ? new Date(doc.reminder_date) : null;
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);

    if (daysUntil >= 0 && daysUntil <= 60) {
      const reminderIsOldEnough = !reminderDate || reminderDate <= sevenDaysAgo;

      if (reminderIsOldEnough) updates.reminder_sent = true;
      if (!doc.expires_soon) updates.expires_soon = true;

      // NOTE: same parity note as above
      if (daysUntil < 0 && !doc.expired) updates.expired = true;
    } else if (daysUntil < 0) {
      if (!doc.expired) updates.expired = true;
      if (doc.expires_soon) updates.expires_soon = false;
    } else if (daysUntil > 60) {
      if (doc.expires_soon) updates.expires_soon = false;
    }

    if (Object.keys(updates).length > 0) {
      await pb.collection(COLLECTION_NAME).update(doc.id, updates);
      updatedCount++;
      console.log(
        `[${ctx.name}] Updated document "${doc.name}" (id: ${doc.id}) with:`,
        updates
      );
    }
  }

  return { totalDocs: docs.length, updatedCount };
}

/**
 * Core routine for checking service_company vendor documents (instance-aware).
 */
async function checkVendorDocuments(ctx) {
  const COLLECTION_NAME = "service_company";
  const { pb } = ctx;

  // ✅ FIX: Admin auth (not collection auth)
  await ensureAdminAuth(ctx);

  const vendors = await pb.collection(COLLECTION_NAME).getFullList();

  const now = new Date();
  let emailedCount = 0;

  for (const vendor of vendors) {
    const reasons = [];
    let daysUntil = null;

    if (!vendor.w9) reasons.push("missing_w9");

    if (!vendor.coi) {
      reasons.push("missing_coi");
    } else {
      if (!vendor.coi_exp_date) {
        reasons.push("missing_coi_date");
      } else {
        const exp = new Date(vendor.coi_exp_date);
        if (Number.isNaN(exp.getTime())) {
          reasons.push("invalid_coi_date");
        } else {
          daysUntil = diffInDays(exp, now);
          if (daysUntil < 0) reasons.push("coi_expired");
          else if (daysUntil <= 30) reasons.push("coi_expires_soon");
        }
      }
    }

    if (reasons.length === 0) continue;

    if (!vendor.email) {
      console.warn(
        `[${ctx.name}] Vendor "${vendor.name}" (id: ${vendor.id}) has doc issues but no email on file.`
      );
      continue;
    }

    // --- Reminder throttling logic (1 week) ---
    const alreadySent = !!vendor.reminder_sent;
    let shouldSend = false;

    if (!alreadySent) {
      shouldSend = true;
    } else {
      if (!vendor.reminder_date) {
        shouldSend = true;
      } else {
        const lastReminder = new Date(vendor.reminder_date);
        if (Number.isNaN(lastReminder.getTime())) {
          shouldSend = true;
        } else {
          const daysSinceLast = diffInDays(now, lastReminder);
          if (daysSinceLast > 7) shouldSend = true;
        }
      }
    }

    if (!shouldSend) continue;

    await sendVendorDocsEmail(ctx, vendor, { reasons, daysUntil });
    emailedCount++;

    try {
      await pb.collection(COLLECTION_NAME).update(vendor.id, {
        reminder_sent: true,
        reminder_date: now.toISOString(),
      });
    } catch (e) {
      console.error(
        `[${ctx.name}] Failed to update reminder flags for vendor "${vendor.name}" (id: ${vendor.id}):`,
        e
      );
    }
  }

  return { totalVendors: vendors.length, emailedCount };
}

/**
 * Run checks for a single instance
 */
async function runChecksForInstance(ctx) {
  console.log(
    `\n[RUN][${
      ctx.name
    }] Starting document checks at ${new Date().toISOString()}`
  );

  const results = {};
  const errors = [];

  try {
    results.facilityDocuments = await checkFacilityDocuments(ctx);
    console.log(
      `[RESULT][${ctx.name}] Facility docs: total=${results.facilityDocuments.totalDocs}, updated=${results.facilityDocuments.updatedCount}`
    );
  } catch (err) {
    console.error(`[ERROR][${ctx.name}] checkFacilityDocuments failed:`, err);
    errors.push({
      scope: `${ctx.name}:facility-documents`,
      message: err?.message || String(err),
    });
  }

  try {
    results.systemDocuments = await checkSystemDocuments(ctx);
    console.log(
      `[RESULT][${ctx.name}] System docs: total=${results.systemDocuments.totalDocs}, updated=${results.systemDocuments.updatedCount}`
    );
  } catch (err) {
    console.error(`[ERROR][${ctx.name}] checkSystemDocuments failed:`, err);
    errors.push({
      scope: `${ctx.name}:system-documents`,
      message: err?.message || String(err),
    });
  }

  try {
    results.vendorDocuments = await checkVendorDocuments(ctx);
    console.log(
      `[RESULT][${ctx.name}] Vendor docs: total=${results.vendorDocuments.totalVendors}, emailed=${results.vendorDocuments.emailedCount}`
    );
  } catch (err) {
    console.error(`[ERROR][${ctx.name}] checkVendorDocuments failed:`, err);
    errors.push({
      scope: `${ctx.name}:vendor-documents`,
      message: err?.message || String(err),
    });
  }

  console.log(
    `[RUN][${ctx.name}] Finished checks at ${new Date().toISOString()}\n`
  );

  return {
    instance: ctx.name,
    status:
      errors.length === 0
        ? "completed"
        : Object.keys(results).length === 0
          ? "failed"
          : "partial",
    results,
    errors,
  };
}

/**
 * Scheduler: run for all instances once at startup, then every 24 hours.
 */
async function runAllChecks() {
  const instanceResults = [];
  for (const ctx of INSTANCE_CONTEXTS) {
    console.log("Checking docs for", ctx.baseUrl);
    instanceResults.push(await runChecksForInstance(ctx));
  }

  const counts = {
    instances_requested: INSTANCE_CONTEXTS.length,
    instances_completed: instanceResults.filter(
      (result) => result.status === "completed",
    ).length,
    instances_partial: instanceResults.filter(
      (result) => result.status === "partial",
    ).length,
    instances_failed: instanceResults.filter(
      (result) => result.status === "failed",
    ).length,
    facility_documents_scanned: 0,
    facility_documents_updated: 0,
    system_documents_scanned: 0,
    system_documents_updated: 0,
    vendors_scanned: 0,
    vendor_emails_sent: 0,
  };
  for (const result of instanceResults) {
    counts.facility_documents_scanned +=
      result.results.facilityDocuments?.totalDocs || 0;
    counts.facility_documents_updated +=
      result.results.facilityDocuments?.updatedCount || 0;
    counts.system_documents_scanned +=
      result.results.systemDocuments?.totalDocs || 0;
    counts.system_documents_updated +=
      result.results.systemDocuments?.updatedCount || 0;
    counts.vendors_scanned += result.results.vendorDocuments?.totalVendors || 0;
    counts.vendor_emails_sent += result.results.vendorDocuments?.emailedCount || 0;
  }
  const errors = instanceResults.flatMap((result) => result.errors);
  return {
    status:
      errors.length === 0
        ? "completed"
        : counts.instances_failed === counts.instances_requested
          ? "failed"
          : "partial",
    counts,
    errors,
  };
}

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

const SCHEDULER_ENABLED = envFlag("SCHEDULER_ENABLED", true);
const RUN_ON_STARTUP = envFlag("RUN_ON_STARTUP", true);
const DOCUMENT_RUN_API_KEY = String(process.env.DOCUMENT_RUN_API_KEY || "").trim();
const DOCUMENT_RUN_STORE_PATH =
  process.env.DOCUMENT_RUN_STORE_PATH ||
  path.join(process.cwd(), "data", "document-runs.json");
const runStore = new JsonDocumentRunStore({
  filePath: DOCUMENT_RUN_STORE_PATH,
  historyLimit: positiveIntegerEnv("DOCUMENT_RUN_HISTORY_LIMIT", 500),
});
const runCoordinator = new DocumentRunCoordinator({
  store: runStore,
  runBuilder: runAllChecks,
  pollMs: positiveIntegerEnv("DOCUMENT_RUN_POLL_MS", 15_000),
  leaseMs: positiveIntegerEnv("DOCUMENT_RUN_LEASE_MS", 15 * 60_000),
  heartbeatMs: positiveIntegerEnv("DOCUMENT_RUN_HEARTBEAT_MS", 30_000),
});
const triggerAuth = createServiceAuth(DOCUMENT_RUN_API_KEY);

function internalDailyTriggerId() {
  return `internal-daily:${new Date().toISOString().slice(0, 10)}`;
}

async function enqueueScheduledChecks(source) {
  const { record, duplicate } = await runCoordinator.enqueue({
    triggerId: internalDailyTriggerId(),
    source,
  });
  console.log(
    `[SCHEDULER] ${duplicate ? "Reused" : "Queued"} run ${record.id} (${source}).`,
  );
}

function startScheduler() {
  if (!SCHEDULER_ENABLED) {
    console.log("[SCHEDULER] Disabled by SCHEDULER_ENABLED.");
    return;
  }

  if (RUN_ON_STARTUP) {
    enqueueScheduledChecks("internal-startup").catch((err) => {
      console.error("[SCHEDULER] Initial enqueue failed:", err);
    });
  } else {
    console.log("[SCHEDULER] Initial run skipped by RUN_ON_STARTUP.");
  }

  const timer = setInterval(() => {
    enqueueScheduledChecks("internal-interval").catch((err) => {
      console.error("[SCHEDULER] Interval enqueue failed:", err);
    });
  }, INTERVAL_MS);
  timer.unref?.();
}

const app = express();
app.use(express.json({ limit: "64kb" }));

function validTriggerId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(String(value || ""));
}

function publicRun(record) {
  return {
    id: record.id,
    trigger_id: record.trigger_id,
    source: record.source,
    status: record.status,
    requested_at: record.requested_at,
    started_at: record.started_at || null,
    completed_at: record.completed_at || null,
    duration_ms: record.duration_ms || 0,
    counts: record.counts || {},
    errors: record.errors || [],
  };
}

app.post("/document-runs", triggerAuth, async (req, res) => {
  const triggerId = String(
    req.get("x-trigger-id") || req.body?.trigger_id || crypto.randomUUID(),
  ).trim();
  if (!validTriggerId(triggerId)) {
    return res.status(400).json({
      status: "error",
      code: "invalid_trigger_id",
      message: "X-Trigger-Id must be 8-128 safe identifier characters.",
    });
  }

  try {
    const { record, duplicate } = await runCoordinator.enqueue({
      triggerId,
      source: req.body?.source || "api",
    });
    return res.status(202).json({
      ...publicRun(record),
      duplicate,
      status_url: `/document-runs/${record.id}`,
    });
  } catch (error) {
    console.error("[document-runs:enqueue]", error);
    return res.status(500).json({
      status: "error",
      code: "document_run_enqueue_failed",
      message: "The document run could not be queued.",
    });
  }
});

app.get("/document-runs/:id", triggerAuth, async (req, res) => {
  try {
    const record = await runCoordinator.getRun(req.params.id);
    if (!record) {
      return res.status(404).json({
        status: "error",
        code: "document_run_not_found",
        message: "Run not found.",
      });
    }
    return res.json(publicRun(record));
  } catch (error) {
    console.error("[document-runs:status]", error);
    return res.status(500).json({
      status: "error",
      code: "document_run_read_failed",
      message: "The document run status could not be read.",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "PAF-Document-Svc",
    configuredInstances: INSTANCE_CONTEXTS.length,
    schedulerEnabled: SCHEDULER_ENABLED,
    runOnStartup: RUN_ON_STARTUP,
    runQueueConfigured: Boolean(DOCUMENT_RUN_API_KEY),
    runWorkerStarted: runCoordinator.started,
    runInProgress: runCoordinator.draining,
    outboundRequestTimeoutMs: OUTBOUND_REQUEST_TIMEOUT_MS,
    checkedAt: new Date().toISOString(),
  });
});

let server = null;

runStore
  .initialize()
  .then(() => {
    server = app.listen(PORT, HOST, () => {
      console.log(`[HTTP] PAF-Document-Svc listening on ${HOST}:${PORT}`);
      runCoordinator.start();
      startScheduler();
    });
  })
  .catch((error) => {
    console.error("[FATAL] Could not initialize the document run store:", error);
    process.exit(1);
  });

function gracefulShutdown(signal) {
  console.log(`[HTTP] Received ${signal}; shutting down.`);
  runCoordinator.stop();
  if (!server) return process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
