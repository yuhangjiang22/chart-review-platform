import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  issueViewerToken,
  resolveViewerToken,
  revokeViewerToken,
  _resetViewerTokensForTest,
} from "../auth.js";

let TMP: string;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vt-test-"));
  process.env.CHART_REVIEW_REVIEWS_ROOT = TMP;
  _resetViewerTokensForTest();
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.CHART_REVIEW_REVIEWS_ROOT;
});

// ---------------------------------------------------------------------------
// Integration tests for methodologist HTTP routes
// ---------------------------------------------------------------------------
import http from "http";
import express from "express";
import { methodologistRouter } from "../methodologist.js";

function makeMethodologistApp() {
  const app = express();
  app.use(express.json());
  app.use(methodologistRouter());
  return app;
}

/** Start a throw-away HTTP server; returns { url, close }. */
function startServer(app: express.Express): { url: string; close: () => Promise<void> } {
  const server = http.createServer(app);
  return {
    url: (() => {
      server.listen(0);
      const addr = server.address() as import("net").AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    })(),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("methodologist routes — auth guards", () => {
  it("returns 401 without a token", async () => {
    const { url, close } = startServer(makeMethodologistApp());
    try {
      const res = await fetch(`${url}/api/methodologist/t1`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("returns 401 with an invalid token", async () => {
    const { url, close } = startServer(makeMethodologistApp());
    try {
      const res = await fetch(`${url}/api/methodologist/t1?viewer=invalid-token`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("returns 403 if URL task_id mismatches token task_id", async () => {
    // Issue a valid token bound to "t1", then use it on the "t2" route.
    const v = issueViewerToken("t1", 30, "alice");
    const { url, close } = startServer(makeMethodologistApp());
    try {
      const res = await fetch(`${url}/api/methodologist/t2?viewer=${v.token}`);
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });
});

describe("viewer tokens", () => {
  it("issues a token bound to a task and validates resolve", () => {
    const v = issueViewerToken("t1", 30, "alice");
    expect(v.token).toMatch(/^[a-f0-9]+$/);
    expect(v.task_id).toBe("t1");
    expect(resolveViewerToken(v.token)).toMatchObject({
      task_id: "t1",
      issued_by: "alice",
    });
  });

  it("revokes a token", () => {
    const v = issueViewerToken("t1", 30, "alice");
    expect(revokeViewerToken(v.token)).toBe(true);
    expect(resolveViewerToken(v.token)).toBe(null);
  });

  it("expires after expires_in_days", () => {
    const v = issueViewerToken("t1", 0.0000001, "alice"); // ~9 ms
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(resolveViewerToken(v.token)).toBe(null);
        resolve();
      }, 50),
    );
  });
});
