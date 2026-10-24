/* ==========================================================================
   /api/news?section=top — UK news for News Deck (Vercel function)

   Pulls public RSS feeds (BBC, Guardian, Surrey Live), merges and de-duplicates
   them, then (optionally) asks Claude for short summaries and a spoken briefing.

   Environment variables (Vercel → Settings → Environment Variables):
     ANTHROPIC_API_KEY  optional. Without it, the feeds' own standfirsts are used.
     NEWS_MODEL         optional. Defaults to claude-haiku-5-5.

   Responses are cached at Vercel's edge for 15 minutes, so feeds and the AI
   are hit at most a few times an hour however often the glasses ask.
   ========================================================================== */

/* --------------------------------------------------------------------------
   SECTIONS — the only place you need to edit to add, remove or reorder topics.
     key (e.g. gaming): short id, lowercase letters only
     tab:   text on the tab (keep it short, about 8 characters max)
     label: title shown at the top of the screen and used in the briefing
     feeds: [source name, RSS feed address] — one or more
   Tabs appear in the order listed here.
   -------------------------------------------------------------------------- */
const SECTIONS = {
  top: {
    tab: 'Top',
    label: 'Top stories',
    feeds: [
      ['BBC', 'https://feeds.bbci.co.uk/news/rss.xml'],
      ['Guardian', 'https://www.theguardian.com/uk/rss'],
    ],
  },
  uk: {
    tab: 'UK',
    label: 'UK',
    feeds: [
      ['BBC', 'https://feeds.bbci.co.uk/news/uk/rss.xml'],
      ['Guardian', 'https://www.theguardian.com/uk-news/rss'],
    ],
  },
  local: {
    tab: 'Surrey',
    label: 'Surrey',
    feeds: [
      ['BBC Surrey', 'https://feeds.bbci.co.uk/news/england/surrey/rss.xml'],
      ['Surrey Live', 'https://www.getsurrey.co.uk/news/?service=rss'],
    ],
  },
  world: {
    tab: 'World',
    label: 'World',
    feeds: [
      ['BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
      ['Guardian', 'https://www.theguardian.com/world/rss'],
    ],
  },
  tech: {
    tab: 'Tech',
    label: 'Technology',
    feeds: [
      ['BBC', 'https://feeds.bbci.co.uk/news/technology/rss.xml'],
      ['Guardian', 'https://www.theguardian.com/uk/technology/rss'],
      ['The Verge', 'https://www.theverge.com/rss/index.xml'],
    ],
  },
  gaming: {
    tab: 'Gaming',
    label: 'Gaming',
    feeds: [
      ['Guardian Games', 'https://www.theguardian.com/games/rss'],
      ['Eurogamer', 'https://www.eurogamer.net/feed'],
      ['VGC', 'https://www.videogameschronicle.com/feed/'],
      ['Rock Paper Shotgun', 'https://www.rockpapershotgun.com/feed'],
    ],
  },
};

const SECTION_LIST = Object.entries(SECTIONS).map(([key, s]) => ({ key, label: s.tab || s.label }));

const MAX_STORIES = 8;
const FEED_TIMEOUT_MS = 6000;
const AI_TIMEOUT_MS = 20000;

/* ---------- RSS parsing (no dependencies) ---------- */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function clean(s) {
  let t = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = t.replace(/<[^>]*>/g, ' ');
  t = decode(t);
  t = t.replace(/<[^>]*>/g, ' '); // escaped HTML revealed by decoding
  t = decode(t);                  // double-escaped entities (&amp;quot;)
  t = t.replace(/Continue reading\s*(\.\.\.|…)?/gi, '');
  return t.replace(/\s+/g, ' ').trim();
}

function parseRss(xml, source) {
  const items = [];
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []) {
    const get = (tag) => {
      const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return m ? clean(m[1]) : '';
    };
    const title = get('title');
    if (!title) continue;
    const date = Date.parse(get('pubDate') || get('dc:date'));
    let desc = get('description');
    if (desc.length > 320) desc = `${desc.slice(0, 317).replace(/\s+\S*$/, '')}…`;
    items.push({
      title,
      desc: desc === title ? '' : desc,
      link: get('link') || get('guid'),
      source,
      published: Number.isFinite(date) ? new Date(date).toISOString() : null,
    });
  }
  return items;
}

async function fetchFeed([source, url]) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NewsDeck/1.0 (personal smart-glasses reader)' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${source} feed returned ${res.status}`);
  return parseRss(await res.text(), source);
}

const titleKey = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 42);

// Newest first, de-duplicated, sources interleaved so one feed can't dominate.
function mergeStories(lists) {
  const seen = new Set();
  const queues = lists.map((l) =>
    l.filter((s) => {
      const k = titleKey(s.title);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0))
  );
  const out = [];
  while (out.length < MAX_STORIES && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && out.length < MAX_STORIES) out.push(q.shift());
  }
  return out.sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0));
}

/* ---------- Claude summaries ---------- */
async function summarise(stories, label) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !stories.length) return null;

  const input = stories.map((s, i) => ({ n: i + 1, source: s.source, headline: s.title, standfirst: s.desc }));

  // A forced tool call makes the model return structured data rather than free text.
  const TOOL = {
    name: 'deliver_news',
    description: 'Deliver the story summaries and the spoken briefing.',
    input_schema: {
      type: 'object',
      properties: {
        summaries: {
          type: 'array',
          items: { type: 'string' },
          description: 'One summary per story, in the same order as given: 1 or 2 sentences, at most 35 words, adding what the headline does not already say.',
        },
        briefing: {
          type: 'string',
          description: 'A spoken briefing of the 4 or 5 most important stories, at most 90 words, written to be read aloud by text-to-speech (no lists, symbols or abbreviations that read badly).',
        },
      },
      required: ['summaries', 'briefing'],
    },
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    body: JSON.stringify({
      model: process.env.NEWS_MODEL || 'claude-haiku-5-5',
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      system:
        'You write news summaries for a tiny smart-glasses display, in British English. ' +
        'Use only the information provided; never add facts, figures or names that are not in it. ' +
        'Be neutral and plain. No markdown.',
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{
        role: 'user',
        content: `Section: ${label}\nStories (JSON):\n${JSON.stringify(input)}\n\nSummarise these stories using the ${TOOL.name} tool.`,
      }],
    }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`Claude API returned ${res.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);

  let out = (data.content || []).find((c) => c.type === 'tool_use')?.input;
  if (!out) { // fallback: JSON written as plain text
    const text = (data.content || []).map((c) => c.text || '').join('');
    const start = text.indexOf('{');
    if (start >= 0) {
      try { out = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)); } catch { /* handled below */ }
    }
  }
  if (!out || !Array.isArray(out.summaries) || typeof out.briefing !== 'string') {
    const kinds = (data.content || []).map((c) => c.type).join(',') || 'none';
    throw new Error(`Unexpected AI reply (stop_reason=${data.stop_reason}, content=${kinds}): ${raw.slice(0, 300)}`);
  }
  return out;
}

function plainBriefing(stories, label) {
  const heads = stories.slice(0, 4).map((s) => s.title.replace(/[.!?]?$/, '.'));
  return heads.length ? `${label}. ${heads.join(' ')}` : '';
}

/* ---------- handler ---------- */
async function handler(req, res) {
  const key = String(req.query.section || 'top');
  const section = SECTIONS[key];
  if (!section) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'Unknown section', sections: SECTION_LIST });
  }

  const results = await Promise.allSettled(section.feeds.map(fetchFeed));
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? section.feeds[i][0] : null))
    .filter(Boolean);
  const stories = mergeStories(lists);

  if (!stories.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Couldn’t load the news feeds', failed });
  }

  let ai = null;
  try {
    ai = await summarise(stories, section.label);
  } catch (err) {
    console.error('Summary failed, using feed text:', err.message);
  }

  // If summaries were wanted but failed, cache briefly so a fix shows up quickly.
  const wantedAi = !!process.env.ANTHROPIC_API_KEY;
  res.setHeader('Cache-Control', wantedAi && !ai
    ? 'public, s-maxage=120'
    : 'public, s-maxage=900, stale-while-revalidate=3600');
  return res.status(200).json({
    section: key,
    label: section.label,
    sections: SECTION_LIST,
    updated: new Date().toISOString(),
    ai: !!ai,
    failed,
    briefing: ai?.briefing || plainBriefing(stories, section.label),
    items: stories.map((s, i) => ({
      id: `${key}-${i}`,
      title: s.title,
      summary: (ai && typeof ai.summaries[i] === 'string' && ai.summaries[i]) || s.desc,
      source: s.source,
      link: s.link,
      published: s.published,
    })),
  });
}

module.exports = handler;
module.exports.config = { maxDuration: 30 };
module.exports._test = { parseRss, mergeStories, clean };
