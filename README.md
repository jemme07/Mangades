# Mangades

Minimal CLI to download MangaDex manga by volume as `.cbz` archives (with volume cover art).

## Setup

```bash
npm install
```

## Usage

```bash
npm run download -- <mangadex-url-or-id> [lang] [output-dir]
```

Examples:

```bash
# Download all English volumes into ./downloads/
npm run download -- https://mangadex.org/title/af0527c1-8734-4498-b128-7090340bc10d/dragon-ball

# Specify language and custom output directory
npm run download -- af0527c1-8734-4498-b128-7090340bc10d es-la ./my-manga
```

Existing non-empty `.cbz` files are skipped automatically, so interrupted runs can be resumed by re-running the same command.
