import test from "node:test";
import assert from "node:assert/strict";
import {
  createServiceAuth,
  readBearerToken,
  tokensMatch,
} from "../lib/serviceAuth.js";

test("reads and validates bearer tokens", () => {
  assert.equal(readBearerToken("bearer document-key"), "document-key");
  assert.equal(readBearerToken("Basic abc"), "");
  assert.equal(tokensMatch("same", "same"), true);
  assert.equal(tokensMatch("wrong", "same"), false);
});

test("rejects invalid trigger credentials", () => {
  let statusCode = 0;
  let payload;
  const req = { get: () => "Bearer wrong" };
  const res = {
    set() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  createServiceAuth("expected")(req, res, () => assert.fail("called next"));
  assert.equal(statusCode, 401);
  assert.equal(payload.code, "invalid_trigger_credentials");
});
