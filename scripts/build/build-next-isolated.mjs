#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assembleStandalone,
  syncStandaloneNativeAssets as _syncNativeAssets,
  syncStandaloneExtraModules as _syncExtraModules,
} from "./assembleStandalone.mjs";
import {
  isBackendOnlyBuild,
  stubDashboardPages,
  restoreDashboardPages,
} from "./backendOnlyPages.mjs";

/**
 * Layer 1: `app/` has been renamed to `dist/` and the App-Router collision is gone.
 * The only transient paths remaining are `.tmp/wine32` (Wine prefix used by some
 * older build tools) and `_tasks` (planning workspace).
 */

const projectRoot = process.cwd();
const distDir = path.resolve(process.env.NEXT_DIST_DIR || ".build/next");
const backupRoot = path.join(os.tmpdir(), `omniroute-build-isolated-${process.pid}-${Date.now()}`);
const DEFAULT_BUILD_MEMORY_MB = 4096;
const MIN_BUILD_MEMORY_MB = 1536;
const MAX_AUTO_BUILD_MEMORY_MB = 4096;
const DEFAULT_CONTAINER_BUILD_MEMORY_MB = 3072;

export function getTransientBuildPaths(rootDir = projectRoot, env = process.env) {
  const paths = [
    {
      label: "local Wine prefix",
      sourcePath: path.join(rootDir, ".tmp", "wine32"),
      backupPath: path.join(backupRoot, "wine32"),
    },
  ];

  if (env.OMNIROUTE_BUILD_MOVE_TASKS === "1") {
    paths.push({
      label: "task planning workspace",
      sourcePath: path.join(rootDir, "_tasks"),
      backupPath: path.join(backupRoot, "_tasks"),
    });
  }

  return paths;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function movePath(sourcePath, destinationPath, fsImpl = fs) {
  const mkdir = typeof fsImpl.mkdir === "function" ? fsImpl.mkdir.bind(fsImpl) : fs.mkdir.bind(fs);
  await mkdir(path.dirname(destinationPath), { recursive: true });

  try {
    await fsImpl.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }

    console.warn(
      `[build-next-isolated] EXDEV while moving ${sourcePath} -> ${destinationPath}; falling back to copy/remove`
    );
    await fsImpl.cp(sourcePath, destinationPath, {
      recursive: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
    });
    await fsImpl.rm(sourcePath, { recursive: true, force: true });
  }
}

/**
 * Best-effort: physically create the isolated Windows profile dirs that
 * resolveNextBuildEnv() may have pointed APPDATA/LOCALAPPDATA at. No-op when
 * resolveNextBuildEnv didn't set them (non-Windows, or NEXT_DIST_DIR already set).
 */
export function ensureWindowsBuildProfileDirs(env, mkdirImpl = mkdirSync) {
  if (!env?.APPDATA || !env?.LOCALAPPDATA) return;
  mkdirImpl(env.APPDATA, { recursive: true });
  mkdirImpl(env.LOCALAPPDATA, { recursive: true });
}

function runNextBuild() {
  return new Promise((resolve) => {
    const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
    const buildEnv = resolveNextBuildEnv(process.env);
    ensureWindowsBuildProfileDirs(buildEnv);
    const child = spawn(process.execPath, [nextBin, "build", resolveNextBuildBundlerFlag()], {
      cwd: projectRoot,
      stdio: "inherit",
      env: buildEnv,
    });

    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };

    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);

    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      if (signal) {
        resolve({ code: 1, signal });
        return;
      }
      resolve({ code: code ?? 1, signal: null });
    });
  });
}

export function resolveNextBuildBundlerFlag(baseEnv = process.env) {
  // Turbopack is the default production bundler (Next 16 stable). Benchmarked on
  // this codebase: 2-3x faster than the single-threaded webpack pass (17min -> 9min
  // on a 32-core box; ~20min -> 7min on ubuntu-latest), artifact validated
  // end-to-end (standalone smoke + e2e/package/electron CI jobs). Webpack stays as
  // the explicit escape hatch (=0) for bundler-compat regressions.
  return baseEnv.OMNIROUTE_USE_TURBOPACK === "0" ? "--webpack" : "--turbopack";
}

function withoutMaxOldSpaceSize(nodeOptions = "") {
  const tokens = String(nodeOptions).split(/\s+/).filter(Boolean);
  const kept = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--max-old-space-size") {
      index += 1;
      continue;
    }
    if (token.startsWith("--max-old-space-size=")) continue;
    kept.push(token);
  }

  return kept.join(" ");
}

function roundDownTo256(valueMb) {
  return Math.floor(valueMb / 256) * 256;
}

function readConstrainedMemoryBytes() {
  const candidates = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"];

  for (const candidate of candidates) {
    try {
      const raw = fsSync.readFileSync(candidate, "utf8").trim();
      if (!raw || raw === "max") continue;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      if (parsed >= 9_000_000_000_000_000_000) continue;
      return parsed;
    } catch {
      // Best effort only.
    }
  }

  return null;
}

function isLikelyContainerBuild(baseEnv = process.env) {
  if (baseEnv.BUILDKIT_SANDBOX_HOSTNAME) return true;
  if (baseEnv.container || baseEnv.CONTAINER) return true;
  return fsSync.existsSync("/.dockerenv") || fsSync.existsSync("/run/.containerenv");
}

export function resolveBuildMemoryMb(baseEnv = process.env) {
  const explicitRaw = baseEnv.OMNIROUTE_BUILD_MEMORY_MB || baseEnv.NEXT_BUILD_MEMORY_MB;
  if (typeof explicitRaw === "string" && explicitRaw.trim().length > 0) {
    const parsed = Number.parseInt(explicitRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 1024) {
      return String(parsed);
    }
  }

  const constrainedBytes = readConstrainedMemoryBytes();
  if (constrainedBytes === null && isLikelyContainerBuild(baseEnv)) {
    return String(DEFAULT_CONTAINER_BUILD_MEMORY_MB);
  }
  const totalMemoryBytes = constrainedBytes ?? os.totalmem();
  const totalMemoryMb = Math.floor(totalMemoryBytes / 1024 / 1024);

  if (!Number.isFinite(totalMemoryMb) || totalMemoryMb <= 0) {
    return String(DEFAULT_BUILD_MEMORY_MB);
  }

  const reservedForOsMb = 768;
  const autoSizedMb = roundDownTo256(
    Math.max(MIN_BUILD_MEMORY_MB, totalMemoryMb - reservedForOsMb)
  );
  const boundedMb = Math.min(MAX_AUTO_BUILD_MEMORY_MB, autoSizedMb);

  if (!Number.isFinite(boundedMb) || boundedMb < MIN_BUILD_MEMORY_MB) {
    return String(DEFAULT_BUILD_MEMORY_MB);
  }

  return String(boundedMb);
}

export function resolveNextBuildEnv(baseEnv = process.env) {
  const nodeOptions = withoutMaxOldSpaceSize(baseEnv.NODE_OPTIONS);
  const buildMemoryMb = resolveBuildMemoryMb(baseEnv);

  return {
    ...baseEnv,
    NEXT_PRIVATE_BUILD_WORKER: baseEnv.NEXT_PRIVATE_BUILD_WORKER || "0",
    NODE_OPTIONS: `${nodeOptions} --max-old-space-size=${buildMemoryMb}`.trim(),
  };
}

async function resetStandaloneOutput(rootDir = projectRoot, fsImpl = fs) {
  // Use the module-level distDir so NEXT_DIST_DIR is respected
  const resolvedDistDir =
    rootDir === projectRoot
      ? distDir
      : path.join(rootDir, process.env.NEXT_DIST_DIR || ".build/next");
  const standaloneRoot = path.join(resolvedDistDir, "standalone");
  if (!(await exists(standaloneRoot))) return;

  const staleStandaloneBackup = path.join(backupRoot, "standalone-stale");

  await movePath(standaloneRoot, staleStandaloneBackup, fsImpl);
  console.log("[build-next-isolated] Moved stale standalone output out of the build path");
}

export async function pruneStandaloneArtifacts(rootDir = projectRoot, fsImpl = fs) {
  const resolvedDistDirForPrune =
    rootDir === projectRoot
      ? distDir
      : path.join(rootDir, process.env.NEXT_DIST_DIR || ".build/next");
  const standaloneRoot = path.join(resolvedDistDirForPrune, "standalone");
  const pruneTargets = [path.join(standaloneRoot, "_tasks")];

  for (const targetPath of pruneTargets) {
    if (!(await exists(targetPath))) continue;
    await fsImpl.rm(targetPath, { recursive: true, force: true });
    console.log(
      `[build-next-isolated] Pruned standalone artifact: ${path.relative(rootDir, targetPath)}`
    );
  }
}

export async function syncStandaloneNativeAssets(
  rootDir = projectRoot,
  fsImpl = fs,
  log = console
) {
  return _syncNativeAssets(rootDir, fsImpl, log);
}

export async function syncStandaloneExtraModules(
  rootDir = projectRoot,
  fsImpl = fs,
  log = console
) {
  return _syncExtraModules(rootDir, fsImpl, log);
}

export async function main() {
  const movedPaths = [];
  const transientBuildPaths = getTransientBuildPaths();

  // Backend-only fast build: replace the dashboard leaf pages with zero-cost stubs so
  // `next build` skips the frontend (client vendor chunks + prerender) while keeping every
  // API route handler. Restored in `finally` and on SIGINT/SIGTERM (git-recoverable regardless).
  let stubbedPages = [];
  const restoreStubbedPagesOnce = () => {
    if (stubbedPages.length > 0) {
      restoreDashboardPages(stubbedPages);
      stubbedPages = [];
    }
  };
  const onFatalSignal = (signal) => {
    console.warn(`[build-next-isolated] Received ${signal} — restoring stubbed pages before exit`);
    restoreStubbedPagesOnce();
    process.exit(1);
  };

  try {
    for (const entry of transientBuildPaths) {
      if (!(await exists(entry.sourcePath))) continue;
      await movePath(entry.sourcePath, entry.backupPath);
      movedPaths.push(entry);
    }

    if (isBackendOnlyBuild()) {
      console.log(
        "[build-next-isolated] OMNIROUTE_BUILD_BACKEND_ONLY set — building API only (dashboard UI stubbed)"
      );
      stubbedPages = stubDashboardPages(projectRoot);
      process.once("SIGINT", onFatalSignal);
      process.once("SIGTERM", onFatalSignal);
    }

    await resetStandaloneOutput(projectRoot);

    const result = await runNextBuild();
    const standaloneDir = path.join(distDir, "standalone");
    if (result.code === 0 && (await exists(standaloneDir))) {
      try {
        await fs.cp(path.join(projectRoot, "docs"), path.join(standaloneDir, "docs"), {
          recursive: true,
        });
        console.log("[build-next-isolated] Copied docs/ to standalone output");
      } catch (docsCopyErr) {
        console.warn("[build-next-isolated] Non-fatal error copying docs/:", docsCopyErr?.message);
      }

      try {
        await pruneStandaloneArtifacts(projectRoot);
      } catch (pruneErr) {
        console.warn(
          "[build-next-isolated] Non-fatal error pruning standalone artifacts:",
          pruneErr
        );
      }

      // Best-effort: build the TPROXY native addon (Linux-only, opt-in) BEFORE
      // assembling, so its transparent.node is present for assembleStandalone's
      // NATIVE_ASSET_ENTRIES copy. Non-Linux / no-toolchain is non-fatal — the
      // capture mode degrades gracefully when the addon is absent.
      try {
        const { buildTproxyNative } = await import("./build-tproxy-native.mjs");
        const res = buildTproxyNative(projectRoot);
        console.log(
          res.built
            ? "[build-next-isolated] Built TPROXY native addon (transparent.node)"
            : `[build-next-isolated] TPROXY native addon skipped: ${res.reason}`
        );
      } catch (nativeErr) {
        console.warn(
          "[build-next-isolated] Non-fatal error building TPROXY native addon:",
          nativeErr?.message
        );
      }

      try {
        console.log(
          "[build-next-isolated] Assembling standalone bundle (static + public + natives + extras)..."
        );
        assembleStandalone({
          distDir,
          outDir: standaloneDir,
          projectRoot,
          copyNatives: true,
        });
        const { spawnSync } = await import("node:child_process");
        const basePathWrite = spawnSync(
          process.execPath,
          [path.join(projectRoot, "scripts", "build", "write-build-base-path.mjs")],
          { cwd: projectRoot, env: process.env, stdio: "inherit" }
        );
        if (basePathWrite.status !== 0) {
          console.warn(
            "[build-next-isolated] Non-fatal error writing BUILD_OMNIROUTE_BASE_PATH sentinel"
          );
        }
      } catch (assembleErr) {
        console.warn("[build-next-isolated] Non-fatal error assembling standalone:", assembleErr);
      }
    }
    process.exitCode = result.code;
  } catch (error) {
    console.error("[build-next-isolated] Build failed:", error);
    process.exitCode = 1;
  } finally {
    // Restore the stubbed dashboard pages FIRST so the working tree is clean even if the
    // transient-path restore below throws.
    restoreStubbedPagesOnce();
    process.off("SIGINT", onFatalSignal);
    process.off("SIGTERM", onFatalSignal);

    while (movedPaths.length > 0) {
      const entry = movedPaths.pop();
      if (!entry) continue;
      try {
        await movePath(entry.backupPath, entry.sourcePath);
      } catch (restoreError) {
        console.error(
          `[build-next-isolated] Failed to restore ${entry.label} from ${entry.backupPath}:`,
          restoreError
        );
        process.exitCode = 1;
      }
    }

    try {
      await fs.rm(backupRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn("[build-next-isolated] Failed to clean temporary backup root:", cleanupError);
    }
  }
}

const entryScript = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryScript === import.meta.url) {
  await main();
}
