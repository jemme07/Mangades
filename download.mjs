import fs from "node:fs";
import path from "node:path";
import { Zip, ZipPassThrough } from "fflate";
import { PDFDocument } from "pdf-lib";

const USER_AGENT = "mangades-cli/2.0";
const VALID_FORMATS = new Set(["cbz", "pdf"]);
const VALID_SPLITS = new Set(["volume", "chapter", "single"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractMangaId(input) {
  if (!input) return null;
  const match = input.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : input;
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

function printUsage() {
  console.log(`Usage: node download.mjs <mangadex-url-or-id> [lang] [output-dir] [options]

Options:
  --format <cbz|pdf>             Output format (default: cbz)
  --split <volume|chapter|single> How to split files (default: volume)
  --lang <code>                  Chapter language (default: en)
  --out <dir>                    Output directory (default: ./downloads)
  -h, --help                     Show this help message`);
}

function parseArgs(argv) {
  const positional = [];
  let format = "cbz";
  let split = "volume";
  let lang;
  let outBase;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg === "--format") {
      format = argv[++i]?.toLowerCase();
    } else if (arg === "--split") {
      split = argv[++i]?.toLowerCase();
    } else if (arg === "--lang") {
      lang = argv[++i];
    } else if (arg === "--out") {
      outBase = argv[++i];
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const mangaId = extractMangaId(positional[0]);
  lang = lang || positional[1] || "en";
  outBase = outBase || positional[2] || path.join(process.cwd(), "downloads");

  if (!mangaId) {
    printUsage();
    process.exit(1);
  }
  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Invalid --format "${format}". Expected: cbz, pdf`);
  }
  if (!VALID_SPLITS.has(split)) {
    throw new Error(`Invalid --split "${split}". Expected: volume, chapter, single`);
  }

  return { mangaId, lang, outBase, format, split };
}

async function fetchWithRetry(url, retries = 6, baseDelay = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") || 0) * 1000;
        const wait = Math.max(retryAfter, baseDelay * Math.pow(2, attempt));
        console.warn(`  [429] Rate limited on ${url}, waiting ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        const wait = baseDelay * Math.pow(2, attempt);
        console.warn(`  [${res.status}] Server error on ${url}, retrying in ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = baseDelay * Math.pow(2, attempt);
      console.warn(`  [ERR] ${err.message} on ${url}, retrying in ${wait}ms...`);
      await sleep(wait);
    }
  }
}

async function fetchJson(url) {
  const res = await fetchWithRetry(url);
  return res.json();
}

async function getMangaInfo(mangaId, lang) {
  const data = await fetchJson(`https://api.mangadex.org/manga/${mangaId}?includes[]=cover_art`);
  const attrs = data.data.attributes;
  const title = attrs.title[lang] || attrs.title.en || Object.values(attrs.title)[0] || mangaId;
  return { title: sanitize(title), raw: data.data };
}

async function getCovers(mangaId) {
  const covers = new Map();
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await fetchJson(
      `https://api.mangadex.org/cover?manga[]=${mangaId}&limit=${limit}&offset=${offset}`
    );
    for (const item of data.data) {
      const vol = item.attributes.volume || "none";
      if (!covers.has(vol)) {
        covers.set(vol, `https://uploads.mangadex.org/covers/${mangaId}/${item.attributes.fileName}`);
      }
    }
    if (offset + data.data.length >= data.total || data.data.length === 0) break;
    offset += limit;
    await sleep(250);
  }
  return covers;
}

async function getAllChapters(mangaId, lang) {
  const chapters = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const data = await fetchJson(
      `https://api.mangadex.org/manga/${mangaId}/feed?translatedLanguage[]=${lang}&limit=${limit}&offset=${offset}&order[chapter]=asc`
    );
    chapters.push(...data.data);
    if (offset + data.data.length >= data.total || data.data.length === 0) break;
    offset += limit;
    await sleep(250);
  }
  return chapters.filter((c) => !c.attributes.externalUrl && c.attributes.pages > 0);
}

function groupChapters(chapters, split, covers) {
  const sorted = [...chapters].sort(
    (a, b) => Number(a.attributes.chapter || 0) - Number(b.attributes.chapter || 0)
  );

  if (split === "single") {
    return [
      {
        label: "all",
        chapters: sorted,
        coverUrl: covers.values().next().value || null,
      },
    ];
  }

  if (split === "chapter") {
    const chPad = Math.max(3, ...sorted.map((c) => String(c.attributes.chapter || "0").length));
    return sorted.map((ch) => {
      const vol = ch.attributes.volume || "0";
      const chNum = String(ch.attributes.chapter || "0").padStart(chPad, "0");
      return {
        label: `ch ${chNum}`,
        chapters: [ch],
        coverUrl: covers.get(vol) || null,
      };
    });
  }

  // Default: split by volume
  const byVol = new Map();
  for (const ch of sorted) {
    const vol = ch.attributes.volume || "0";
    if (!byVol.has(vol)) byVol.set(vol, []);
    byVol.get(vol).push(ch);
  }

  return [...byVol.keys()]
    .sort((a, b) => Number(a) - Number(b))
    .map((vol) => ({
      label: vol === "0" ? "no-vol" : `vol ${String(vol).padStart(2, "0")}`,
      chapters: byVol.get(vol),
      coverUrl: covers.get(vol) || null,
    }));
}

async function iterChapterImages(chapters, onImage) {
  const chPad = Math.max(3, ...chapters.map((c) => String(c.attributes.chapter || "0").length));
  for (const ch of chapters) {
    await sleep(400);
    const atHome = await fetchJson(`https://api.mangadex.org/at-home/server/${ch.id}`);
    const files = atHome.chapter.data;
    const baseUrl = atHome.baseUrl;
    const hash = atHome.chapter.hash;

    const chNum = String(ch.attributes.chapter || "0").padStart(chPad, "0");
    const chTitle = ch.attributes.title ? ` - ${sanitize(ch.attributes.title)}` : "";
    const chDir = `ch ${chNum}${chTitle}`;
    const pagePad = String(files.length).length;

    for (let i = 0; i < files.length; i++) {
      const fname = files[i];
      const ext = path.extname(fname) || ".jpg";
      const imgUrl = `${baseUrl}/data/${hash}/${fname}`;
      const res = await fetchWithRetry(imgUrl);
      const buf = new Uint8Array(await res.arrayBuffer());
      const pageName = `${chDir}/page ${String(i + 1).padStart(pagePad, "0")}${ext}`;
      await onImage({ buf, ext, pageName });
    }
    console.log(`    ch ${ch.attributes.chapter} (${files.length} pages)`);
  }
}

async function writeCbz({ chapters, coverUrl, outFile }) {
  const tmpFile = outFile + ".tmp";
  await new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(tmpFile);
    outStream.on("error", reject);
    outStream.on("finish", resolve);

    const zip = new Zip((err, data, final) => {
      if (err) {
        outStream.destroy(err);
        return;
      }
      if (data) outStream.write(data);
      if (final) outStream.end();
    });

    (async () => {
      try {
        if (coverUrl) {
          const ext = path.extname(new URL(coverUrl).pathname) || ".jpg";
          const res = await fetchWithRetry(coverUrl);
          const buf = new Uint8Array(await res.arrayBuffer());
          const entry = new ZipPassThrough(`00 cover${ext}`);
          zip.add(entry);
          entry.push(buf, true);
        }

        await iterChapterImages(chapters, ({ buf, pageName }) => {
          const entry = new ZipPassThrough(pageName);
          zip.add(entry);
          entry.push(buf, true);
        });

        zip.end();
      } catch (err) {
        outStream.destroy(err);
        reject(err);
      }
    })();
  });

  fs.renameSync(tmpFile, outFile);
}

async function embedImage(pdfDoc, buf) {
  // Detect PNG (89 50 4E 47) or JPEG (FF D8 FF) by magic bytes
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return pdfDoc.embedPng(buf);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return pdfDoc.embedJpg(buf);
  }
  throw new Error("Unsupported image format for PDF (only PNG and JPEG are supported; use --format cbz for WebP)");
}

async function writePdf({ chapters, coverUrl, outFile }) {
  const tmpFile = outFile + ".tmp";
  const pdfDoc = await PDFDocument.create();

  const addPageFromBuf = async (buf) => {
    const img = await embedImage(pdfDoc, buf);
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  };

  if (coverUrl) {
    const res = await fetchWithRetry(coverUrl);
    await addPageFromBuf(new Uint8Array(await res.arrayBuffer()));
  }

  await iterChapterImages(chapters, async ({ buf }) => {
    await addPageFromBuf(buf);
  });

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(tmpFile, pdfBytes);
  fs.renameSync(tmpFile, outFile);
}

async function main() {
  const { mangaId, lang, outBase, format, split } = parseArgs(process.argv.slice(2));

  console.log(`Fetching manga ${mangaId} (${lang}, format=${format}, split=${split})...`);
  const { title } = await getMangaInfo(mangaId, lang);
  const outDir = path.join(outBase, title);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Title: ${title}`);
  console.log(`Output: ${outDir}`);

  const [covers, chapters] = await Promise.all([
    getCovers(mangaId),
    getAllChapters(mangaId, lang),
  ]);
  console.log(`Found ${chapters.length} downloadable chapters and ${covers.size} covers.`);

  const groups = groupChapters(chapters, split, covers);
  console.log(`Grouped into ${groups.length} ${split} file(s).`);

  const writer = format === "pdf" ? writePdf : writeCbz;

  for (const group of groups) {
    const outFile = path.join(outDir, `${title} - ${group.label}.${format}`);

    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      console.log(`[SKIP] ${path.basename(outFile)} already exists.`);
      continue;
    }

    console.log(`[DOWN] ${path.basename(outFile)} (${group.chapters.length} chapters)...`);
    await writer({
      chapters: group.chapters,
      coverUrl: group.coverUrl,
      outFile,
    });
    const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
    console.log(`[DONE] ${path.basename(outFile)} (${sizeMb} MB)`);
  }

  console.log("All downloads finished!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
