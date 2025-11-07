# WebNovel EPUB Scraper

A small utility for turning novels from **webnoveltranslations.com** into clean EPUB files.  
Each chapter becomes its own EPUB (ideal for Kavita and similar readers).  
The script downloads only new chapters and caches covers to avoid unnecessary requests.

---

## Features

- Scrapes metadata, cover, and chapter list from a novel’s main page  
- Converts chapters into individual EPUB files  
- Skips chapters that were already generated  
- Supports multiple novels via:
  - `NOVELS="url1,url2"`
  - or a `novels.txt` file (one URL per line)
- EPUB metadata is formatted so Kavita groups chapters correctly

---

## Requirements

- Node.js 18+
- npm
- Docker (optional)

---

## Running Locally

Install the dependencies:

```bash
npm install
```

Run with a single novel:

```bash
NOVELS="URL" node main.js
```

Or place multiple URLs into `novels.txt`:

```
URL1
URL2
```

Then run:

```bash
node main.js
```

---

## Output

Generated files are stored in:

```
books/
  <SeriesName>/
    <SeriesName> - c000.epub
    <SeriesName> - c001.epub
    ...
assets/
  <SeriesName>-cover.jpg
```

Both folders are ignored by Git.

---

## Docker

Build:

```bash
docker compose build
```

Run:

```bash
docker compose up -d
```

You can pass novel URLs directly:

```yaml
environment:
  NOVELS: "https://webnoveltranslations.com/novel/the-golden-haired-summoner/"
```

Or use a text file:

```yaml
environment:
  NOVELS_FILE: /app/config/novels.txt
volumes:
  - ./config:/app/config
```

---

## Configuration

| Variable        | Description                     |
|----------------|---------------------------------|
| `NOVELS`       | Comma‑separated list of URLs     |
| `NOVELS_FILE`  | Path to a file containing URLs   |

URLs must point to a novel root

---

## Legal Disclaimer

This tool is provided for personal use only.  
You are responsible for ensuring you have the right to download or convert any content.  
The author assumes no liability for misuse, violations of terms of service, or copyright infringement.  
Use responsibly and respect the rules of the websites you interact with.

---
