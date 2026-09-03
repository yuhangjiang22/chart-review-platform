// Print the content SHA of the asthma-adherence rubric.
//
// Step 1 of SITE-GUIDE.md. Every package a site sends back records this SHA, so
// two sites' results can be checked for having been produced against the same
// rubric — and a site that pulled mid-round can tell.
//
// This exists as a FILE rather than the `npx tsx -e '…'` one-liner the guide used
// to carry. That one-liner was written with backslash line-continuations inside
// single quotes, so the backslashes reached the JS source and esbuild rejected it
// (`Syntax error "\x0A"`); a site following the guide exactly got an uncaught
// exception as its very first action. A command a site must run is a command that
// has to be runnable, which means it has to live somewhere it can be tested.
//
// Usage:
//   npx tsx scripts/asthma/rubric-sha.ts [task-id]

import { computeTaskSha } from "../../server/lib/lock.js";
import { guidelineDir } from "@chart-review/rubric";

const taskId = process.argv[2] ?? "asthma-adherence";
const dir = guidelineDir(taskId);
process.stdout.write(`${computeTaskSha(dir)}\n`);
