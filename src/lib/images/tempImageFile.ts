import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEMP_IMAGE_TTL_MS = 5 * 60 * 1000;

const MAX_TEMP_IMAGE_BYTES = 32 * 1024 * 1024;
const TEMP_IMAGE_DIR_NAME = "omniroute-image-downloads";
const TEMP_IMAGE_ID_RE = /^([0-9a-f]{32})-(\d{10,16})$/;

const IMAGE_FORMATS = [
  { mime: "image/png", extension: "png" },
  { mime: "image/jpeg", extension: "jpg" },
  { mime: "image/webp", extension: "webp" },
  { mime: "image/gif", extension: "gif" },
  { mime: "image/avif", extension: "avif" },
] as const;

type ImageMime = (typeof IMAGE_FORMATS)[number]["mime"];
type ImageExtension = (typeof IMAGE_FORMATS)[number]["extension"];

export interface TemporaryImageFile {
  id: string;
  bytes: Buffer;
  mime: ImageMime;
  extension: ImageExtension;
  expiresAt: number;
}

export interface TemporaryImageReference {
  id: string;
  mime: ImageMime;
  extension: ImageExtension;
  expiresAt: number;
}

export interface ImageResponsePayload {
  created?: unknown;
  data: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

let testDirectoryOverride: string | null = null;

function temporaryImageDirectory(): string {
  return testDirectoryOverride ?? join(tmpdir(), TEMP_IMAGE_DIR_NAME);
}

function sniffImageFormat(bytes: Buffer): { mime: ImageMime; extension: ImageExtension } | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mime: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", extension: "webp" };
  }
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { mime: "image/gif", extension: "gif" };
    }
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
    ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii"))
  ) {
    return { mime: "image/avif", extension: "avif" };
  }
  return null;
}

function decodeBase64Image(value: string): Buffer {
  const trimmed = value.trim();
  const commaIndex = trimmed.startsWith("data:") ? trimmed.indexOf(",") : -1;
  const payload = commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed;
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) throw new Error("Generated image payload is empty");
  if (bytes.length > MAX_TEMP_IMAGE_BYTES) {
    throw new Error("Generated image exceeds temporary image size limit");
  }
  return bytes;
}

function parseTemporaryImageId(id: string): { expiresAt: number } | null {
  const match = TEMP_IMAGE_ID_RE.exec(id);
  if (!match) return null;
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return { expiresAt };
}

async function removeTemporaryImageFiles(id: string): Promise<void> {
  const directory = temporaryImageDirectory();
  await Promise.all(
    IMAGE_FORMATS.map(({ extension }) =>
      unlink(join(directory, `${id}.${extension}`)).catch(() => undefined)
    )
  );
}

async function cleanupExpiredTemporaryImages(now = Date.now()): Promise<void> {
  const directory = temporaryImageDirectory();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const dot = entry.lastIndexOf(".");
      if (dot <= 0) return;
      const id = entry.slice(0, dot);
      const parsed = parseTemporaryImageId(id);
      if (!parsed || parsed.expiresAt > now) return;
      await unlink(join(directory, entry)).catch(() => undefined);
    })
  );
}

function scheduleDeletion(id: string, ttlMs: number): void {
  const timer = setTimeout(() => {
    void removeTemporaryImageFiles(id);
  }, ttlMs);
  timer.unref?.();
}

export async function storeTemporaryImageFromBase64(
  value: string,
  ttlMs = TEMP_IMAGE_TTL_MS
): Promise<TemporaryImageReference> {
  const normalizedTtlMs =
    Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : TEMP_IMAGE_TTL_MS;
  const bytes = decodeBase64Image(value);
  const format = sniffImageFormat(bytes);
  if (!format) throw new Error("Generated image format is not supported for temporary download");

  const directory = temporaryImageDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cleanupExpiredTemporaryImages();

  const expiresAt = Date.now() + normalizedTtlMs;
  const id = `${randomUUID().replaceAll("-", "")}-${expiresAt}`;
  await writeFile(join(directory, `${id}.${format.extension}`), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  scheduleDeletion(id, normalizedTtlMs);

  return { id, ...format, expiresAt };
}

export async function readTemporaryImage(id: string): Promise<TemporaryImageFile | null> {
  const parsed = parseTemporaryImageId(id);
  if (!parsed) return null;
  if (Date.now() >= parsed.expiresAt) {
    await removeTemporaryImageFiles(id);
    return null;
  }

  const directory = temporaryImageDirectory();
  for (const format of IMAGE_FORMATS) {
    try {
      const bytes = await readFile(join(directory, `${id}.${format.extension}`));
      return { id, bytes, ...format, expiresAt: parsed.expiresAt };
    } catch {
      continue;
    }
  }
  return null;
}

export async function materializeImageResponseUrls(
  payload: ImageResponsePayload,
  publicOrigin: string,
  ttlMs = TEMP_IMAGE_TTL_MS
): Promise<ImageResponsePayload> {
  const data = await Promise.all(
    payload.data.map(async (item) => {
      const rawBase64 = typeof item.b64_json === "string" ? item.b64_json : null;
      const dataUrl =
        typeof item.url === "string" && item.url.startsWith("data:image/") ? item.url : null;
      const source = rawBase64 ?? dataUrl;
      if (!source) return item;

      const stored = await storeTemporaryImageFromBase64(source, ttlMs);
      const { b64_json: _discarded, ...rest } = item;
      return {
        ...rest,
        url: new URL(`/v1/images/temp/${stored.id}`, publicOrigin).toString(),
      };
    })
  );

  return { ...payload, data };
}

/** Test-only override so filesystem tests do not share the process temp directory. */
export function __setTemporaryImageDirectoryForTesting(directory: string | null): void {
  testDirectoryOverride = directory;
}
