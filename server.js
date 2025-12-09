import PocketBase from "pocketbase";
import "dotenv/config";

/**
 * CONFIG
 * Env vars required:
 *  - POCKET_BASE_URL
 *  - EMAIL_HOST
 */
const { POCKET_BASE_URL, EMAIL_HOST } = process.env;

if (!POCKET_BASE_URL || !EMAIL_HOST) {
  console.error("Missing env vars. Required: POCKET_BASE_URL, EMAIL_HOST");
  process.exit(1);
}

// Create shared PocketBase client
const pb = new PocketBase(POCKET_BASE_URL);
pb.autoCancellation(false);

/**
 * Email service: call external /update-document endpoint
 * This will be responsible for sending the email with a link that
 * ultimately points to /document-update/:id.
 */
async function sendExpiryEmail(doc, context) {
  // Normalize EMAIL_HOST to avoid trailing slash issues
  const baseUrl = EMAIL_HOST.replace(/\/+$/, "");
  const url = `${baseUrl}/update-document`;

  // Match the pattern your email server uses: req.body?.record || req.body
  const payload = {
    record: {
      // REQUIRED: id of the original document so /document-update/:id can be built
      id: doc.id,

      // Extra context if you want it on the email side
      name: doc.name,
      facility_id: doc.facility_id ?? doc.facility ?? null,
      client_id: doc.client_id ?? null,
      expire_date: doc.expire_date,
    },

    // extra context (e.g. { reason: "expires_soon", daysUntil })
    ...context,
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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
        `[EMAIL] /update-document responded with ${resp.status} ${resp.statusText}. Body: ${text}`
      );
    } else {
      console.log(
        `[EMAIL] Called /update-document for doc "${doc.name}" (id: ${doc.id})`
      );
    }
  } catch (err) {
    console.error(
      `[EMAIL] Failed to call /update-document for doc "${doc.name}" (id: ${doc.id}):`,
      err
    );
  }
}

/**
 * Email service for vendor doc issues
 * Calls external /vendor-docs-email on the email server.
 */
async function sendVendorDocsEmail(vendor, context) {
  const baseUrl = EMAIL_HOST.replace(/\/+$/, "");
  const url = `${baseUrl}/vendor-docs-email`;

  const payload = {
    record: {
      id: vendor.id,
      name: vendor.name,
      email: vendor.email,
      w9: vendor.w9 || null,
      coi: vendor.coi || null,
      coi_exp_date: vendor.coi_exp_date || null,
      client: vendor.client || vendor.client_id || null,
    },
    ...context, // e.g. { reasons: [...], daysUntil }
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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
        `[EMAIL] /vendor-docs-email responded with ${resp.status} ${resp.statusText}. Body: ${text}`
      );
    } else {
      console.log(
        `[EMAIL] Called /vendor-docs-email for vendor "${vendor.name}" (id: ${vendor.id})`
      );
    }
  } catch (err) {
    console.error(
      `[EMAIL] Failed to call /vendor-docs-email for vendor "${vendor.name}" (id: ${vendor.id}):`,
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
 * Returns { totalDocs, updatedCount }.
 */
async function checkFacilityDocuments() {
  const COLLECTION_NAME = "facility_documents";

  // Load all docs that have an expire_date
  const docs = await pb.collection(COLLECTION_NAME).getFullList({
    filter: `expire_date != "" && archived=false && send_reminder=true`,
    sort: "expire_date",
  });

  const now = new Date();
  let updatedCount = 0;

  for (const doc of docs) {
    const updates = {};

    if (!doc.expire_date) continue;

    const expDate = new Date(doc.expire_date);
    const daysUntil = diffInDays(expDate, now); // future = positive, past = negative

    const reminderDate = doc.reminder_date ? new Date(doc.reminder_date) : null;
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);

    // --- Expiration within next 60 days (0–60) ---
    if (daysUntil >= 0 && daysUntil <= 60) {
      const reminderIsOldEnough = !reminderDate || reminderDate <= sevenDaysAgo;

      if (reminderIsOldEnough) {
        // Call the real email/mini-console endpoint
        await sendExpiryEmail(doc, {
          reason: "expires_soon",
          daysUntil,
        });

        updates.reminder_date = now.toISOString();
        updates.reminder_sent = true;
      }

      // in 60-day window ⇒ expires_soon true
      if (!doc.expires_soon) {
        updates.expires_soon = true;
      }

      // if somehow already past in same run, mark expired (guard)
      if (daysUntil < 0 && !doc.expired) {
        updates.expired = true;
      }
    }
    // --- Expiration in the past ---
    else if (daysUntil < 0) {
      if (!doc.expired) {
        updates.expired = true;
      }
      if (doc.expires_soon) {
        updates.expires_soon = false;
      }
    }
    // --- Expiration NOT within 60 days (> 60 days out) ---
    else if (daysUntil > 60) {
      if (doc.expires_soon) {
        updates.expires_soon = false;
      }
      if (doc.reminder_sent) {
        updates.reminder_sent = false;
      }
      if (doc.reminder_date) {
        updates.reminder_date = null;
      }
    }

    if (Object.keys(updates).length > 0) {
      await pb.collection(COLLECTION_NAME).update(doc.id, updates);
      updatedCount++;
      console.log(
        `Updated document "${doc.name}" (id: ${doc.id}) with:`,
        updates
      );
    }
  }

  return { totalDocs: docs.length, updatedCount };
}

/**
 * Core routine for checking service_company vendor documents.
 *
 * Rules:
 *  1) w9 is required (no expiry).
 *  2) coi is required and has a coi_exp_date.
 *     - If coi_exp_date is 30 days or less in the future, or in the past,
 *       send an email.
 *  3) If any requirement is not met, email service_company.email.
 *
 * Returns { totalVendors, emailedCount }.
 */
async function checkVendorDocuments() {
  const COLLECTION_NAME = "service_company";

  const vendors = await pb.collection(COLLECTION_NAME).getFullList();

  const now = new Date();
  let emailedCount = 0;

  for (const vendor of vendors) {
    const reasons = [];
    let daysUntil = null;

    // 1) W9 required
    if (!vendor.w9) {
      reasons.push("missing_w9");
    }

    // 2) COI required + expiry
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
          // future = positive, past = negative
          daysUntil = diffInDays(exp, now);
          if (daysUntil < 0) {
            reasons.push("coi_expired");
          } else if (daysUntil <= 30) {
            reasons.push("coi_expires_soon");
          }
        }
      }
    }

    // Fully compliant → no email
    if (reasons.length === 0) continue;

    if (!vendor.email) {
      console.warn(
        `Vendor "${vendor.name}" (id: ${vendor.id}) has doc issues but no email on file.`
      );
      continue;
    }

    // --- Reminder throttling logic (1 week) ---
    const alreadySent = !!vendor.reminder_sent;
    let shouldSend = false;

    if (!alreadySent) {
      // No previous reminder → send now
      shouldSend = true;
    } else {
      // Has a previous reminder → only send again if reminder_date is > 7 days ago
      if (!vendor.reminder_date) {
        // Flag set but no date → treat as "send again"
        shouldSend = true;
      } else {
        const lastReminder = new Date(vendor.reminder_date);
        if (Number.isNaN(lastReminder.getTime())) {
          // Invalid date → send again
          shouldSend = true;
        } else {
          // diffInDays(target, base) – how many days since last reminder
          const daysSinceLast = diffInDays(now, lastReminder);
          if (daysSinceLast > 7) {
            shouldSend = true;
          }
        }
      }
    }

    if (!shouldSend) {
      // Still within 1-week cooldown window
      continue;
    }

    // Send the reminder email
    await sendVendorDocsEmail(vendor, { reasons, daysUntil });
    emailedCount++;

    // Update reminder flags
    try {
      await pb.collection(COLLECTION_NAME).update(vendor.id, {
        reminder_sent: true,
        reminder_date: now.toISOString(),
      });
    } catch (e) {
      console.error(
        `Failed to update reminder flags for vendor "${vendor.name}" (id: ${vendor.id}):`,
        e
      );
    }
  }

  return { totalVendors: vendors.length, emailedCount };
}

/**
 * Scheduler: run both checkers once at startup, then every 24 hours.
 */
async function runAllChecks() {
  console.log(
    `\n[RUN] Starting document checks at ${new Date().toISOString()}`
  );

  try {
    const facResult = await checkFacilityDocuments();
    console.log(
      `[RESULT] Facility docs: total=${facResult.totalDocs}, updated=${facResult.updatedCount}`
    );
  } catch (err) {
    console.error("[ERROR] checkFacilityDocuments failed:", err);
  }

  try {
    const vendorResult = await checkVendorDocuments();
    console.log(
      `[RESULT] Vendor docs: total=${vendorResult.totalVendors}, emailed=${vendorResult.emailedCount}`
    );
  } catch (err) {
    console.error("[ERROR] checkVendorDocuments failed:", err);
  }

  console.log(`[RUN] Finished checks at ${new Date().toISOString()}\n`);
}

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Immediately run once, then schedule every 24 hours
(async () => {
  await runAllChecks();

  // If you prefer to trigger via external cron and exit afterward,
  // comment out the setInterval below.
  setInterval(() => {
    runAllChecks().catch((err) => {
      console.error("[FATAL] Unhandled error in scheduled run:", err);
    });
  }, INTERVAL_MS);
})().catch((err) => {
  console.error("[FATAL] Initial run failed:", err);
  process.exit(1);
});
