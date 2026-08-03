/**
 * Builds a single-file executable using Node's built-in Single Executable
 * Application support.
 *
 * The pipeline is:
 *   1. esbuild bundles src/ into one CommonJS file (SEA does not accept ESM
 *      as the entry script).
 *   2. `node --experimental-sea-config` turns that into a preparation blob.
 *   3. A copy of a Node binary is taken as the carrier.
 *   4. postject injects the blob into that carrier.
 *   5. macOS carriers are re-signed, because injection invalidates the
 *      existing signature and Gatekeeper refuses unsigned Mach-O binaries.
 *
 * Cross-building works by pointing --node at a Node binary for the target
 * platform. Everything else about the process is platform-independent.
 *
 * esbuild and postject are called through their JavaScript APIs rather than
 * their CLIs. Shelling out to `npx` fails on Windows, where the shim is
 * `npx.cmd` and spawnSync will not resolve a `.cmd` without a shell — and
 * turning on `shell: true` to fix that would put file paths through cmd.exe
 * quoting. Importing the APIs sidesteps both and is faster.
 *
 * Usage:
 *   node --experimental-strip-types scripts/build-sea.ts
 *   node --experimental-strip-types scripts/build-sea.ts \
 *     --platform win32 --node vendor/node-win32-x64/node.exe --strip
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type TargetPlatform = "linux" | "darwin" | "win32";

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

interface BuildOptions {
  platform: TargetPlatform;
  nodeBinary: string;
  outDir: string;
  name: string;
  strip: boolean;
  keepIntermediates: boolean;
}

function parse(argv: string[]): BuildOptions {
  const options: BuildOptions = {
    platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    nodeBinary: process.execPath,
    outDir: "dist",
    name: "typescribe",
    strip: false,
    keepIntermediates: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value.`);
      return next;
    };
    switch (arg) {
      case "--platform": {
        const p = value();
        if (p !== "linux" && p !== "darwin" && p !== "win32") {
          throw new Error(`--platform must be linux, darwin, or win32 (got "${p}").`);
        }
        options.platform = p;
        break;
      }
      case "--node": options.nodeBinary = value(); break;
      case "--out": options.outDir = value(); break;
      case "--name": options.name = value(); break;
      case "--strip": options.strip = true; break;
      case "--keep": options.keepIntermediates = true; break;
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return options;
}

const HELP = `build-sea — bundle typescribe into one executable

  --platform <p>   linux | darwin | win32          (default: this machine)
  --node <path>    Node binary to use as carrier   (default: the running node)
  --out <dir>      Output directory                (default: dist)
  --name <name>    Executable base name            (default: typescribe)
  --strip          Run \`strip\` on the carrier first (~15% smaller; not win32)
  --keep           Keep the intermediate .cjs and .blob
  -h, --help       This text

Cross-building: download the target platform's Node from nodejs.org, verify it
against SHASUMS256.txt, and point --node at the extracted binary. Building
natively on each OS in CI avoids this entirely — see .github/workflows/release.yml.
`;

/**
 * devDependencies are needed to build but not to run, so a missing one means
 * `npm ci` has not happened rather than anything being broken.
 */
async function importBuildDependency<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as unknown as T;
  } catch {
    throw new Error(
      `Build dependency "${name}" is not installed.\n` +
        `Run \`npm ci\` first. It is a devDependency — the built executable does not need it.`,
    );
  }
}

function run(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`${label}: could not run \`${command}\` — ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label}: \`${command}\` exited with code ${result.status}`);
  }
}

/** postject ships no type declarations. */
interface PostjectApi {
  inject(
    filename: string,
    resourceName: string,
    resourceData: Buffer,
    options?: { sentinelFuse?: string; machoSegmentName?: string; overwrite?: boolean },
  ): Promise<void>;
}

async function build(options: BuildOptions): Promise<void> {
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(options.nodeBinary)) {
    throw new Error(`Carrier Node binary not found: ${options.nodeBinary}`);
  }

  const bundle = join(outDir, `${options.name}.cjs`);
  const blob = join(outDir, `${options.name}.blob`);
  const seaConfig = join(outDir, `${options.name}.sea.json`);
  const exe = join(outDir, options.platform === "win32" ? `${options.name}.exe` : options.name);

  // 1. Bundle. CommonJS is required: SEA rejects an ESM entry script.
  step("bundling");
  const esbuild = await importBuildDependency<typeof import("esbuild")>("esbuild");
  const result = await esbuild.build({
    entryPoints: ["src/cli.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: true,
    outfile: bundle,
    logLevel: "warning",
  });
  if (result.errors.length) {
    throw new Error(`bundle: esbuild reported ${result.errors.length} error(s)`);
  }

  // 2. Preparation blob.
  step("building SEA blob");
  writeFileSync(
    seaConfig,
    JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
  );
  run(process.execPath, ["--experimental-sea-config", seaConfig], "sea-config");

  // 3. Carrier.
  step(`copying carrier (${options.nodeBinary})`);
  rmSync(exe, { force: true });
  copyFileSync(options.nodeBinary, exe);
  chmodSync(exe, 0o755);

  if (options.strip) {
    if (options.platform === "win32") {
      warn("--strip skipped: not applicable to a Windows carrier");
    } else {
      step("stripping carrier");
      // Size optimization only — a machine without binutils should still build.
      const stripped = spawnSync("strip", [exe], { stdio: "inherit" });
      if (stripped.error || stripped.status !== 0) {
        warn("strip unavailable or failed — continuing with an unstripped carrier");
      }
    }
  }

  // Injection rewrites bytes, which invalidates any signature already on the
  // carrier. Both signed platforms want the old one removed first.
  if (options.platform === "darwin") {
    step("removing existing signature");
    spawnSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
  }
  if (options.platform === "win32") {
    // Official Node builds for Windows are Authenticode-signed. Leaving a stale
    // signature behind is not fatal — the binary still runs — but it makes
    // SmartScreen noisier, so remove it when signtool is available.
    step("removing existing signature");
    const removed = spawnSync("signtool", ["remove", "/s", exe], { stdio: "ignore" });
    if (removed.error || removed.status !== 0) {
      warn("signtool unavailable or failed — continuing with a stale signature on the carrier");
    }
  }

  // 4. Inject.
  step("injecting blob");
  const postject = await importBuildDependency<PostjectApi>("postject");
  // postject prints a "Can't find string offset for section name" line per ELF
  // section it probes. They are noise on a successful build and drown out the
  // real output in CI, so buffer them and only surface them if injection fails.
  const noise: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...parts: unknown[]) => noise.push(parts.join(" "));
  console.log = (...parts: unknown[]) => noise.push(parts.join(" "));
  try {
    await postject.inject(exe, "NODE_SEA_BLOB", readFileSync(blob), {
      sentinelFuse: FUSE,
      ...(options.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
    });
  } catch (error) {
    console.warn = realWarn;
    console.log = realLog;
    for (const line of noise) process.stderr.write(`${line}\n`);
    throw error;
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
  chmodSync(exe, 0o755);

  // 5. Re-sign. Ad-hoc is enough for local use; ship a real Developer ID
  //    signature and a notarization pass if you distribute it.
  if (options.platform === "darwin") {
    step("ad-hoc signing");
    const signed = spawnSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });
    if (signed.status !== 0) {
      warn("codesign failed — the binary will run locally but Gatekeeper will block it elsewhere");
    }
  }

  if (!options.keepIntermediates) {
    for (const file of [bundle, blob, seaConfig]) rmSync(file, { force: true });
  }

  const size = statSync(exe).size / 1024 / 1024;
  step(`done: ${exe} (${size.toFixed(0)} MB)`);
  if (options.platform === (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux")) {
    step(`verify with: ${exe} --check`);
  }
}

function step(message: string): void {
  process.stderr.write(`[build-sea] ${message}\n`);
}
function warn(message: string): void {
  process.stderr.write(`[build-sea] warning: ${message}\n`);
}

build(parse(process.argv.slice(2))).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
