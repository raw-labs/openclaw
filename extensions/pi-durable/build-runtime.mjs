import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const revision = "eaa719f4c2bff51c5994f9c28c5395cddb4d0632";
const archiveSha256 = "daf336aaf2f6712e051466bb317dc3e3875d96d7cf3f553b1b5db7968407b988";
const output = join(dirname(fileURLToPath(import.meta.url)), "dist");
const stampPath = join(output, "pi-runtime.stamp");
const bundlePath = join(output, "pi-runtime.mjs");
const licensePath = join(output, "pi-runtime.LICENSE");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stamp = hash(await readFile(new URL(import.meta.url)));
const cached = await readFile(stampPath, "utf8")
  .then(async (value) => {
    await Promise.all([access(bundlePath), access(licensePath)]);
    return value === stamp;
  })
  .catch(() => false);
if (!cached) {
  const scratch = await mkdtemp(join(tmpdir(), "openclaw-pi-durable-dependency-"));
  const source = join(scratch, "source");
  const archivePath = join(scratch, "source.tgz");
  try {
    const response = await fetch(
      `https://codeload.github.com/earendil-works/pi/tar.gz/${revision}`,
      {
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Could not download Pi Durable ${revision} (HTTP ${response.status}).`);
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (hash(archive) !== archiveSha256) {
      throw new Error(`Pi Durable archive checksum does not match ${revision}.`);
    }
    await mkdir(source);
    await writeFile(archivePath, archive);
    execFileSync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", source]);
    const npm = (args) =>
      execFileSync("npm", args, {
        cwd: source,
        shell: process.platform === "win32",
        stdio: "inherit",
      });
    npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    for (const workspace of ["pi-telemetry", "pi-schema", "chord", "pi-codemode"]) {
      npm(["run", "build", "-w", `@earendil-works/${workspace}`]);
    }
    npm(["run", "hydrate:model-data"]);
    npm(["run", "build:offline", "-w", "@earendil-works/pi-ai"]);
    npm(["run", "build", "-w", "@earendil-works/pi-durable"]);
    const entry = join(source, "openclaw-runtime.mjs");
    await writeFile(
      entry,
      `
      export { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
      export { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
      export { createModels } from "@earendil-works/pi-ai/models";
      export { CompactionTask, createRegistry, defineDoc, defineExtension, defineSignal, defineTask, defineTool, GenerationTask, Harness, hook, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
      export { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
      export { bool, obj, unsafe } from "@earendil-works/pi-schema";
    `,
    );
    await mkdir(output, { recursive: true });
    const candidate = join(output, `pi-runtime.${process.pid}.mjs`);
    try {
      await build({
        entryPoints: [entry],
        outfile: candidate,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node24",
        minifySyntax: true,
        banner: {
          js: 'import { createRequire as piRuntimeRequire } from "node:module"; const require = piRuntimeRequire(import.meta.url);',
        },
      });
      await cp(join(source, "LICENSE"), licensePath);
      await rename(candidate, bundlePath);
      await writeFile(stampPath, stamp);
    } finally {
      await rm(candidate, { force: true });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
