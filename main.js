const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const nodepub = require('nodepub');
const { URL } = require('url');
const cron = require('node-cron');

/* ───────────────────────── CONFIG ───────────────────────── */
const OUT_DIR = path.resolve('books');      // where epubs go
const ASSETS_DIR = 'assets';                // where covers are cached
const CSS = `
  body { font-family: serif; line-height: 1.6; }
  h1, h2 { page-break-after: avoid; }
  p { margin: 0 0 1em; }
  img { max-width: 100%; height: auto; }
`;
const UA = 'Mozilla/5.0 (compatible; NovelEPUB/1.0)';

/* ───────────── METADATA (template; filled per novel) ───────────── */
const metadata = {
    id: 'placeholder',
    cover: '',
    title: '',
    series: '',
    sequence: 1,
    author: 'Anonymous',
    fileAs: 'Anonymous',
    genre: '',
    tags: '',
    copyright: '',
    publisher: '',
    published: '',
    language: 'en',
    description: '',
    contents: 'Chapters',
    showContents: false,
    source: '',
    images: [] // keep empty; don't add cover here (avoids duplicate manifest entries)
};

/* ───────────────────────── HELPERS ───────────────────────── */
const safe = s => String(s || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');

function resolveUrl(base, maybeRelative) {
    try { return new URL(maybeRelative, base).toString(); }
    catch { return null; }
}

// Ensure a cover file exists; returns local file path (caches by series name)
async function ensureCover(imgUrl, outDir = ASSETS_DIR, baseName) {
    await fsp.mkdir(outDir, { recursive: true });
    const u = new URL(imgUrl);
    const extGuess = (u.pathname.split('.').pop() || '').toLowerCase();
    const ext = ['jpg','jpeg','png','gif','webp'].includes(extGuess) ? extGuess : 'jpg';
    const filename = `${safe(baseName)}.${ext}`;
    const filePath = path.join(outDir, filename);
    if (fs.existsSync(filePath)) return filePath;
    const res = await axios.get(imgUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': UA } });
    await fsp.writeFile(filePath, res.data);
    return filePath;
}

// Compute output paths
function getChapterOutPath(seriesTitle, chapterNumber) {
    const cNum = String(chapterNumber || 0).padStart(3, '0');
    const seriesFolder = path.join(OUT_DIR, safe(seriesTitle));
    const fileBase = `${seriesTitle} - c${cNum}`;
    return { seriesFolder, fileBase, fullPath: path.join(seriesFolder, `${fileBase}.epub`) };
}

/* ───────────────── SCRAPE SERIES METADATA (per novel) ───────────────── */
async function getMetadata() {
    const { data } = await axios.get(metadata.source, { headers: { 'User-Agent': UA } });
    const $ = cheerio.load(data);

    metadata.title = $('.post-title').first().text().trim() || metadata.series || 'Series';
    metadata.series = metadata.title;

    const $authorLink = $(".author-content a[rel='tag']").first();
    if ($authorLink.length) {
        metadata.author = $authorLink.text().trim();
        metadata.fileAs = metadata.author.split(' ').reverse().join(', ');
    }

    const genres = [];
    $('.genres-content a[rel="tag"]').each((_, el) => genres.push($(el).text().trim()));
    metadata.genre = genres.join(', ');

    const raw = $('.summary_image img').first().attr('data-src') || $('.summary_image img').first().attr('src');
    if (raw) {
        const coverUrl = resolveUrl(metadata.source, raw);
        try {
            const coverPath = await ensureCover(coverUrl, ASSETS_DIR, `${metadata.title}-cover`);
            metadata.cover = coverPath; // DO NOT also push into metadata.images
            console.log('✓ Cover ready:', coverPath);
        } catch (e) {
            console.warn('! Failed to download cover:', e.message);
        }
    } else {
        console.warn('! No cover URL found');
    }
}

/* ─────────────────────── SCRAPE CHAPTER LIST ─────────────────────── */
const chapterList = [];

async function getChapterList() {
    console.log('Fetching chapters...');

    // Build the ajax endpoint robustly (no accidental "//")
    const ajaxUrl = new URL('ajax/chapters', metadata.source).toString();
    console.log(metadata.source)
    console.log(ajaxUrl)

    let data;
    try {
        const res = await axios.post(
            ajaxUrl,
            null,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; NovelEPUB/1.0)',
                    'Referer': metadata.source,
                    'X-Requested-With': 'XMLHttpRequest'
                },
                // some hosts care about this
                validateStatus: s => s >= 200 && s < 500
            }
        );
        if (res.status === 404) {
            throw new Error(`ajax/chapters 404 at ${ajaxUrl}`);
        }
        data = res.data;
    } catch (e) {
        // Fallback: grab the full novel page and look for a pre-rendered list
        console.warn('ajax/chapters failed, falling back to page parse:', e.message);
        const page = await axios.get(metadata.source, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NovelEPUB/1.0)' } });
        data = page.data;
    }

    const $ = cheerio.load(data);

    // Works with both ajax fragment and full page
    $('ul.list-chap').each((_, ul) => {
        const title = $(ul).prev('a').text().trim() || 'Default';
        const book = { title, chapters: [] };

        $(ul).find('li.wp-manga-chapter a').each((_, a) => {
            const chapterTitle = $(a).text().trim();
            if (!chapterTitle) return;
            const url = $(a).attr('href');
            const num = Number((chapterTitle.match(/\b(\d+)\b/) || [])[1] ?? 0);
            book.chapters.push({ title: chapterTitle, url, number: num });
        });

        book.chapters.reverse();
        chapterList.push(book);
    });

    if(chapterList.length === 0) {
        const title =  'Default';
        const book = { title, chapters: [] };
        $('li.wp-manga-chapter a').each((_, a) => {
            const chapterTitle = $(a).text().trim();
            if (!chapterTitle) return;
            const url = $(a).attr('href');
            const num = Number((chapterTitle.match(/\b(\d+)\b/) || [])[1] ?? 0);
            book.chapters.push({ title: chapterTitle, url, number: num });
        });

        book.chapters.reverse();
        chapterList.push(book);
    }

    if (!chapterList.length) {
        throw new Error('No chapters found via ajax or fallback parser.');
    }
}

/* ───────────────────── SCRAPE CHAPTER CONTENT ───────────────────── */
async function getChapterHtml(chapterUrl) {
    console.log('Fetching chapter:', chapterUrl);
    const { data } = await axios.get(chapterUrl, { headers: { 'User-Agent': UA } });
    const $ = cheerio.load(data);

    const chapterTitle = $('#chapter-heading').first().text().trim();
    const $container = $('#novel-chapter-container');
    $container.find('script, style, .chapter-nav, .share-buttons, .nav-links').remove();
    $container.find('div[data-format=""]').remove();

    const inner = $container.html() || '';
    const html = `<h1>${escapeHtml(chapterTitle || '')}</h1>\n${inner}`;
    return { chapterTitle: chapterTitle || 'Chapter', html };
}

/* ────────────────────── BUILD EPUB (per chapter) ────────────────────── */
async function writeChapterEpub(seriesMeta, chapter) {
    const { seriesFolder, fileBase, fullPath } = getChapterOutPath(seriesMeta.series, chapter.number);
    if (fs.existsSync(fullPath)) {
        console.log(`• Skipping c${String(chapter.number).padStart(3,'0')} (already exists)`);
        return;
    }
    await fsp.mkdir(seriesFolder, { recursive: true });

    // Ensure calibre:series_index is written (Kavita grouping). Use 0.5 for prologue.
    const isPrologue = Number(chapter.number) === 0;
    const sequenceSafe = isPrologue ? 0.5 : Number(chapter.number) || 1;

    const perChapterMeta = {
        ...seriesMeta,
        series: seriesMeta.series,
        sequence: sequenceSafe,
        id: `${seriesMeta.series.replace(/\s+/g, '-')}-c${String(chapter.number).padStart(3,'0')}`,
        title: `${seriesMeta.series} — Chapter ${chapter.number}`,
        description: chapter.title,
        published: new Date().toISOString().slice(0, 10),
        showContents: false
    };

    const epub = nodepub.document(perChapterMeta, { styles: CSS });
    epub.addSection('Copyright', `<p>© ${new Date().getFullYear()} ${seriesMeta.author}</p>`, true, true);
    epub.addSection(chapter.title, chapter.html, false, false, `chapter-${String(chapter.number).padStart(3,'0')}`);

    await epub.writeEPUB(seriesFolder, fileBase);
    console.log(`✓ Wrote ${path.join(seriesFolder, `${fileBase}.epub`)}`);
}

/* ────────────────────────── UTIL ────────────────────────── */
function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ──────────────────── URL-ONLY INPUT (env) ──────────────────── */
// Reads URLs from either NOVELS (CSV) or NOVELS_FILE (one per line).
// If both are set, they’re combined. Duplicates and blanks are removed.
// Comments starting with # are allowed in the file.
function getRequestedNovelUrls() {
    const urls = [];

    // 1) NOVELS env (comma-separated)
    if (process.env.NOVELS) {
        urls.push(
            ...process.env.NOVELS
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
        );
    }

    // 2) NOVELS_FILE env (defaults to ./novels.txt)
    const filePath = process.env.NOVELS_FILE || path.resolve('./novels.txt');
    if (fs.existsSync(filePath)) {
        const txt = fs.readFileSync(filePath, 'utf8');
        urls.push(
            ...txt
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#')) // ignore blanks/comments
        );
    }

    // Validate
    const normalized = Array.from(
        new Set(
            urls.map(u => {
                let nu;
                try { nu = normalizeNovelUrl(u); } catch (e) { throw new Error(`Bad URL "${u}": ${e.message}`); }
                return nu;
            })
        )
    );

    if (!normalized.length) {
        throw new Error('Provide novel URLs via NOVELS or NOVELS_FILE (e.g., novels.txt).');
    }
    return normalized;
}


function normalizeNovelUrl(input) {
    let u;
    try { u = new URL(input); }
    catch { throw new Error(`Invalid URL: ${input}`); }
    if (!/^\/novel\/[^/]+\/?$/.test(u.pathname)) {
        throw new Error(`URL must be a novel root like /novel/<slug>/ : ${u.href}`);
    }
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    u.hash = ''; u.search = '';
    return u.toString();
}

/* ───────────────────── PER-NOVEL RUNNER ───────────────────── */
async function processNovel(novelUrl) {
    // reset per novel
    metadata.source = novelUrl;
    metadata.cover = '';
    metadata.images = [];
    metadata.series = '';
    metadata.title = '';
    chapterList.length = 0;

    console.log(`\n=== Processing novel: ${novelUrl} ===`);
    await getMetadata();
    await getChapterList();

    for (const group of chapterList) {
        console.log(`\nGroup: ${group.title}`);
        for (const ch of group.chapters) {
            const { fullPath } = getChapterOutPath(metadata.series, ch.number);
            if (fs.existsSync(fullPath)) {
                console.log(`• Already on disk: ${path.basename(fullPath)}`);
                continue;
            }
            const { html } = await getChapterHtml(ch.url);
            await writeChapterEpub(metadata, { ...ch, html });
        }
    }
}

/* ─────────────────────────── MAIN ─────────────────────────── */
async function main() {
    const urls = getRequestedNovelUrls(); // from NOVELS env
    await fsp.mkdir(OUT_DIR, { recursive: true });
    for (const url of urls) {
        try {
            await processNovel(url);
        } catch (e) {
            console.error(`! Failed for ${url}: ${e.message}`);
        }
    }
}

// Run the job once, then schedule it
async function runJobOnce() {
    console.log(`[${new Date().toISOString()}] Starting crawl run`);
    try {
        await main();
        console.log(`[${new Date().toISOString()}] Crawl run completed`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Crawl run failed:`, err);
    }
}

if (require.main === module) {
    // 1) Run immediately on startup
    runJobOnce();

    // 2) Schedule to run every 6 hours
    //
    // "0 */6 * * *" = minute 0, every 6th hour, every day
    // (in the container's timezone, or TZ env if set)
    cron.schedule('0 */6 * * *', () => {
        runJobOnce();
    });

    // Keep process alive
}