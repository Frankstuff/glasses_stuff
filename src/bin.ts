#!/usr/bin/env node
/**
 * The `chesshacker` command. It checks Node's version before loading anything else, so an old
 * Node gets a clear message instead of a crash.
 */

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(
    `chesshacker needs Node.js 22 or newer, and this is ${process.version}.\n` +
      "→ Install the current LTS from nodejs.org (or `brew install node`), then run `npm install` again.",
  );
  process.exit(1);
}

// sharp imports JSON, which Node 22 before 22.12 warns about on every start. Other warnings still show.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") console.warn(`(node:${process.pid}) ${warning.name}: ${warning.message}`);
});

await import("./cli.js");
