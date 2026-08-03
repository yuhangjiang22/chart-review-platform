// packages/deploy-runner/src/enumerate-patients.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enumeratePatients } from "./enumerate-patients.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function patient(id: string, notes: string[]) {
  const nd = path.join(dir, id, "notes");
  fs.mkdirSync(nd, { recursive: true });
  for (const n of notes) fs.writeFileSync(path.join(nd, n), "x");
}

describe("enumeratePatients", () => {
  it("returns patient dirs that have notes/*.txt, sorted", () => {
    patient("p_b", ["a.txt"]);
    patient("p_a", ["x.txt", "y.txt"]);
    expect(enumeratePatients(dir)).toEqual(["p_a", "p_b"]);
  });

  it("skips dirs with an empty or missing notes folder", () => {
    patient("p_ok", ["a.txt"]);
    fs.mkdirSync(path.join(dir, "p_empty", "notes"), { recursive: true });
    fs.mkdirSync(path.join(dir, "p_nonotes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "stray.txt"), "x");
    expect(enumeratePatients(dir)).toEqual(["p_ok"]);
  });

  it("throws when the data dir does not exist", () => {
    expect(() => enumeratePatients(path.join(dir, "nope"))).toThrow(/data.dir/i);
  });
});
