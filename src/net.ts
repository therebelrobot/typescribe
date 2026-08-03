/**
 * The only file in the project that can reach the network.
 *
 * Nothing on the transcription path imports it — it is used exclusively by
 * `typescribe setup`. Keeping it isolated means "does a run touch the network"
 * is answerable by looking at one import edge.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { get } from "node:https";
import { pipeline } from "node:stream/promises";

export interface DownloadResult {
  path: string;
  sha256: string;
  bytes: number;
}

const MAX_REDIRECTS = 8;

/**
 * Streams a URL to disk, hashing as it goes, and verifies the digest before
 * returning. A mismatch deletes the partial file and throws — a bad download
 * never survives on disk to be picked up by a later run.
 */
export async function download(
  url: string,
  destination: string,
  options: { expectedSha256?: string; label?: string; onProgress?: (done: number, total: number | null) => void } = {},
): Promise<DownloadResult> {
  const hash = createHash("sha256");
  let received = 0;

  try {
    const response = await open(url, MAX_REDIRECTS);
    const total = Number(response.headers["content-length"]) || null;

    response.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      options.onProgress?.(received, total);
    });

    await pipeline(response, createWriteStream(destination));
  } catch (error) {
    await rm(destination, { force: true });
    throw new Error(
      `Download failed for ${options.label ?? url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const digest = hash.digest("hex");
  if (options.expectedSha256 && digest !== options.expectedSha256) {
    await rm(destination, { force: true });
    throw new Error(
      `Checksum mismatch for ${options.label ?? url}\n` +
        `  expected ${options.expectedSha256}\n` +
        `  received ${digest}\n` +
        `The partial file has been deleted. Do not retry blindly — a mismatch means the\n` +
        `bytes are not what this build of typescribe was pinned against.`,
    );
  }

  const { size } = await stat(destination);
  return { path: destination, sha256: digest, bytes: size };
}

function open(url: string, redirectsLeft: number): Promise<NodeJS.ReadableStream & { headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) {
      reject(new Error("Too many redirects."));
      return;
    }
    if (!url.startsWith("https://")) {
      reject(new Error(`Refusing a non-HTTPS URL: ${url}`));
      return;
    }

    const request = get(url, { headers: { "user-agent": "typescribe-setup" } }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (status >= 300 && status < 400 && location) {
        response.resume();
        const next = new URL(location, url).toString();
        open(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status} ${response.statusMessage ?? ""}`.trim()));
        return;
      }
      resolve(response as never);
    });

    request.setTimeout(60_000, () => {
      request.destroy(new Error("Timed out after 60s with no response."));
    });
    request.on("error", reject);
  });
}

/** Renders a one-line progress bar onto stderr, rewriting in place. */
export function progressReporter(label: string): (done: number, total: number | null) => void {
  let lastDrawn = 0;
  return (done, total) => {
    const now = Date.now();
    const finished = total !== null && done >= total;
    if (!finished && now - lastDrawn < 120) return;
    lastDrawn = now;

    const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
    if (total === null) {
      process.stderr.write(`\r  ${label}  ${mb(done)} MB`);
    } else {
      const pct = Math.floor((done / total) * 100);
      const filled = Math.floor(pct / 4);
      process.stderr.write(
        `\r  ${label}  [${"#".repeat(filled)}${" ".repeat(25 - filled)}] ${String(pct).padStart(3)}%  ${mb(done)}/${mb(total)} MB`,
      );
    }
    if (finished) process.stderr.write("\n");
  };
}
