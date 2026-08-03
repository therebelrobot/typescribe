/**
 * Archive extraction for setup. Reads tar.gz and zip with `node:zlib` only, so
 * setup does not depend on `tar`, `unzip`, or PowerShell being present and
 * behaving the same way on all three platforms.
 *
 * Both readers refuse entries that escape the destination directory, because
 * the archives are fetched over the network and a path-traversal entry is the
 * classic way an archive turns into arbitrary file write.
 */

import { gunzipSync, inflateRawSync } from "node:zlib";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface ExtractedEntry {
  path: string;
  mode: number;
}

function safeJoin(destination: string, entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = resolve(destination, normalized);
  const root = resolve(destination);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Archive entry escapes the destination directory: ${entryPath}`);
  }
  return target;
}

/** POSIX/USTAR tar inside gzip. Handles GNU long names via the 'L' type flag. */
export function extractTarGz(archive: string, destination: string): ExtractedEntry[] {
  const buffer = gunzipSync(readFileSync(archive));
  const written: ExtractedEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  // Links whose target had not been written yet when we reached them.
  const deferredLinks: { target: string; resolved: string }[] = [];

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker

    const rawName = cstring(header.subarray(0, 100));
    const prefix = cstring(header.subarray(345, 500));
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    const type = String.fromCharCode(header[156]!);

    offset += 512;
    const dataEnd = offset + size;
    const data = buffer.subarray(offset, dataEnd);
    offset += Math.ceil(size / 512) * 512;

    if (type === "L") {
      // GNU long-name extension: this entry's data is the next entry's name.
      pendingLongName = cstring(data);
      continue;
    }

    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    if (!name) continue;

    const target = safeJoin(destination, name);

    if (type === "5") {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (type === "1" || type === "2") {
      // Hard link ('1') and symlink ('2'). The whisper.cpp tarball ships its
      // shared objects as libwhisper.so -> libwhisper.so.1 -> libwhisper.so.1.9.1,
      // and the binary's RUNPATH resolves through them, so dropping these
      // leaves an unloadable executable.
      const linkName = cstring(header.subarray(157, 257));
      if (!linkName) continue;
      // Reject a link that would resolve outside the destination.
      const resolved = linkName.startsWith("/")
        ? safeJoin(destination, linkName)
        : safeJoin(destination, join(dirname(name), linkName));
      mkdirSync(dirname(target), { recursive: true });
      rmSync(target, { force: true });
      try {
        if (type === "1" || process.platform === "win32") {
          // Windows symlinks need elevation, so copy instead. Hard links are
          // copied too — the size cost is trivial next to a model file.
          copyFileSync(resolved, target);
        } else {
          symlinkSync(linkName, target);
        }
      } catch {
        // A link whose target has not been written yet: copy on the second pass.
        deferredLinks.push({ target, resolved });
        continue;
      }
      written.push({ path: target, mode: 0 });
      continue;
    }
    if (type !== "0" && type !== "" && type !== "\0") continue; // devices, fifos

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    const fileMode = mode & 0o777;
    if (fileMode) chmodSync(target, fileMode);
    written.push({ path: target, mode: fileMode });
  }

  for (const link of deferredLinks) {
    try {
      copyFileSync(link.resolved, link.target);
      written.push({ path: link.target, mode: 0 });
    } catch {
      // A dangling link in the archive is the archive's problem, not ours.
    }
  }

  return written;
}

/** ZIP reader: central directory walk, STORE and DEFLATE only. */
export function extractZip(archive: string, destination: string): ExtractedEntry[] {
  const buffer = readFileSync(archive);
  const written: ExtractedEntry[] = [];

  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Corrupt zip: bad central directory signature.");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) {
      mkdirSync(safeJoin(destination, name), { recursive: true });
      continue;
    }

    // The local header repeats the name and extra fields, at its own lengths.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let content: Buffer;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression method ${method} for ${name}.`);

    const target = safeJoin(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);

    // Unix permissions live in the high 16 bits of the external attributes.
    const mode = (externalAttrs >>> 16) & 0o777;
    if (mode) chmodSync(target, mode);
    written.push({ path: target, mode });
  }

  return written;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // Scan backwards; the trailing comment is at most 65535 bytes.
  const limit = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= limit; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Corrupt zip: no end-of-central-directory record found.");
}

function cstring(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.toString("utf8", 0, end === -1 ? buffer.length : end).trim();
}

function octal(buffer: Buffer): number {
  const text = cstring(buffer).replace(/[^0-7]/g, "");
  return text ? parseInt(text, 8) : 0;
}

export function extract(
  archive: string,
  destination: string,
  kind: "tar.gz" | "zip",
): ExtractedEntry[] {
  mkdirSync(destination, { recursive: true });
  return kind === "tar.gz" ? extractTarGz(archive, destination) : extractZip(archive, destination);
}

export { join as joinPath };
