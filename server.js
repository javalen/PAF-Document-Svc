// server.js (DROP-IN)
// ✅ Fixes "Missing or invalid auth collection context" by using admin auth
// ✅ One PB client per instance; admin auth cached per instance
// ✅ Multi-instance env support preserved

import PocketBase from "pocketbase";
import "dotenv/config";

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
    });
  }

  // Numbered PocketBase instances
  for (let i = 1; i <= 20; i++) {
    const url = process.env[`POCKET_BASE_URL_${i}`];
    if (!url) continue;

    instances.push({
      name: `instance_${i}`,
      baseUrl: url,
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

const INSTANCE_CONFIGS = loadInstancesFromEnv();
const EMAIL_HOST = (process.env.EMAIL_HOST || "https://email.predictaf.com").replace(
  /\/+$/,
  ""
);

/**
 * Build runtime contexts: one PocketBase client per instance.
 */
const INSTANCE_CONTEXTS = INSTANCE_CONFIGS.map((cfg) => {
  const pb = new PocketBase(cfg.baseUrl);
  pb.autoCancellation(false);

  return {
    name: cfg.name,
    baseUrl: cfg.baseUrl,
    emailHost: EMAIL_HOST,
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

  try {
    const facResult = await checkFacilityDocuments(ctx);
    console.log(
      `[RESULT][${ctx.name}] Facility docs: total=${facResult.totalDocs}, updated=${facResult.updatedCount}`
    );
  } catch (err) {
    console.error(`[ERROR][${ctx.name}] checkFacilityDocuments failed:`, err);
  }

  try {
    const sysResult = await checkSystemDocuments(ctx);
    console.log(
      `[RESULT][${ctx.name}] System docs: total=${sysResult.totalDocs}, updated=${sysResult.updatedCount}`
    );
  } catch (err) {
    console.error(`[ERROR][${ctx.name}] checkSystemDocuments failed:`, err);
  }

  try {
    const vendorResult = await checkVendorDocuments(ctx);
    console.log(
      `[RESULT][${ctx.name}] Vendor docs: total=${vendorResult.totalVendors}, emailed=${vendorResult.emailedCount}`
    );
  } catch (err) {
    console.error(`[ERROR][${ctx.name}] checkVendorDocuments failed:`, err);
  }

  console.log(
    `[RUN][${ctx.name}] Finished checks at ${new Date().toISOString()}\n`
  );
}

/**
 * Scheduler: run for all instances once at startup, then every 24 hours.
 */
async function runAllChecks() {
  for (const ctx of INSTANCE_CONTEXTS) {
    console.log("Checking docs for", ctx.baseUrl);
    await runChecksForInstance(ctx);
  }
}

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

(async () => {
  await runAllChecks();

  setInterval(() => {
    runAllChecks().catch((err) => {
      console.error("[FATAL] Unhandled error in scheduled run:", err);
    });
  }, INTERVAL_MS);
})().catch((err) => {
  console.error("[FATAL] Initial run failed:", err);
  process.exit(1);
});
