import crypto from "node:crypto";

export function readBearerToken(value) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value || "").trim());
  return match ? match[1].trim() : "";
}

export function tokensMatch(provided, expected) {
  if (!provided || !expected) return false;
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

export function createServiceAuth(expectedToken) {
  const configuredToken = String(expectedToken || "").trim();

  return function serviceAuth(req, res, next) {
    if (!configuredToken) {
      return res.status(503).json({
        status: "error",
        code: "document_run_auth_not_configured",
        message: "The document-run trigger is not configured.",
      });
    }

    const providedToken = readBearerToken(req.get("authorization"));
    if (!tokensMatch(providedToken, configuredToken)) {
      res.set("WWW-Authenticate", "Bearer");
      return res.status(401).json({
        status: "error",
        code: "invalid_trigger_credentials",
        message: "Valid trigger credentials are required.",
      });
    }

    return next();
  };
}
