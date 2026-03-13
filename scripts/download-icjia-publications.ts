import { createWriteStream } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const PAGE_URL = "https://icjia.illinois.gov/researchhub/publications/";
const OUTPUT_DIR = path.resolve("downloads", "icjia-publications");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json");
const CONCURRENCY = 8;

type DownloadRecord = {
  fileName: string;
  sourceUrl: string;
};

type DownloadFailure = {
  fileName: string;
  sourceUrl: string;
  error: string;
};

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pdfUrls = await getPublicationPdfUrls();
  const records = buildFilePlan(pdfUrls);

  console.log(`Found ${records.length} unique PDF URLs.`);
  const failures = await downloadAll(records);

  await writeFile(
    MANIFEST_PATH,
    JSON.stringify(
      {
        sourcePage: PAGE_URL,
        downloadedAt: new Date().toISOString(),
        count: records.length,
        failedCount: failures.length,
        failures,
        files: records,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Saved PDFs to ${OUTPUT_DIR}`);
  console.log(`Wrote manifest to ${MANIFEST_PATH}`);
  if (failures.length > 0) {
    console.log(`Completed with ${failures.length} failed downloads.`);
  }
}

async function getPublicationPdfUrls(): Promise<string[]> {
  const pageHtml = await fetchText(PAGE_URL);
  const appBundlePath = findAppBundlePath(pageHtml);
  const appBundleUrl = new URL(appBundlePath, PAGE_URL).toString();
  const appBundle = await fetchText(appBundleUrl);

  const matches = [...appBundle.matchAll(/"fileURL":"(https:\/\/[^"]+?\.pdf)"/g)];
  const urls = matches.map((match) => decodeJsString(match[1]));

  return [...new Set(urls)];
}

function findAppBundlePath(html: string): string {
  const match = html.match(/<script[^>]+src="([^"]*\/js\/app\.[^"]+\.js)"/i);

  if (!match) {
    throw new Error("Could not locate the publications app bundle in the page HTML.");
  }

  return match[1];
}

function buildFilePlan(urls: string[]): DownloadRecord[] {
  const seenNames = new Map<string, number>();

  return urls.map((sourceUrl) => {
    const url = new URL(sourceUrl);
    const rawName = decodeURIComponent(path.posix.basename(url.pathname));
    const sanitized = sanitizeFileName(rawName || "download.pdf");
    const fileName = makeUniqueFileName(sanitized, seenNames);

    return { fileName, sourceUrl };
  });
}

function sanitizeFileName(fileName: string): string {
  const safe = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return safe.length > 0 ? safe : "download.pdf";
}

function makeUniqueFileName(fileName: string, seenNames: Map<string, number>): string {
  const ext = path.extname(fileName) || ".pdf";
  const base = path.basename(fileName, ext);
  const normalizedName = fileName.toLowerCase();
  const existing = seenNames.get(normalizedName) ?? 0;

  if (existing === 0 && !seenNames.has(normalizedName)) {
    seenNames.set(normalizedName, 1);
    return fileName;
  }

  let counter = existing + 1;
  let candidate = `${base}-${counter}${ext}`;
  while (seenNames.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${base}-${counter}${ext}`;
  }

  seenNames.set(normalizedName, counter);
  seenNames.set(candidate.toLowerCase(), 1);
  return candidate;
}

async function downloadAll(records: DownloadRecord[]): Promise<DownloadFailure[]> {
  let nextIndex = 0;
  const failures: DownloadFailure[] = [];

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, records.length) }, async () => {
      while (nextIndex < records.length) {
        const index = nextIndex++;
        const record = records[index];
        try {
          await downloadOne(record, index + 1, records.length);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({
            fileName: record.fileName,
            sourceUrl: record.sourceUrl,
            error: message,
          });
          console.error(`[${index + 1}/${records.length}] FAILED ${record.fileName}: ${message}`);
        }
      }
    }),
  );

  return failures;
}

async function downloadOne(record: DownloadRecord, index: number, total: number) {
  const destination = path.join(OUTPUT_DIR, record.fileName);

  if (await fileExists(destination)) {
    console.log(`[${index}/${total}] SKIP ${record.fileName}`);
    return;
  }

  const response = await fetch(record.sourceUrl);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${record.sourceUrl}: ${response.status} ${response.statusText}`);
  }

  await pipeline(response.body, createWriteStream(destination));
  console.log(`[${index}/${total}] ${record.fileName}`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function decodeJsString(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
