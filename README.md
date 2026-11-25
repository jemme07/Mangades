# Mangades

Minimal CLI to download MangaDex manga as `.cbz` or `.pdf` files (with cover art).

## Setup

```bash
npm install
```

## Usage

```bash
npm run download -- <mangadex-url-or-id> [lang] [output-dir] [options]
```

### Options

- `--format <cbz|pdf>` — Output format (default: `cbz`)
- `--split <volume|chapter|single>` — How to split files (default: `volume`)
- `--lang <code>` — Chapter language (default: `en`)
- `--fallback-lang <code>` — Fallback language for missing chapters (e.g. `es-la`)
- `--out <dir>` — Output directory (default: `./downloads`)

### Examples

```bash
# Default: all English volumes as .cbz into ./downloads/
npm run download -- https://mangadex.org/title/af0527c1-8734-4498-b128-7090340bc10d/dragon-ball

# Download as PDF split by chapter
npm run download -- af0527c1-8734-4498-b128-7090340bc10d --format pdf --split chapter

# Specify language and custom output directory
npm run download -- af0527c1-8734-4498-b128-7090340bc10d es-la ./my-manga
```

Existing non-empty output files are skipped automatically, so interrupted runs can be resumed by re-running the same command.
