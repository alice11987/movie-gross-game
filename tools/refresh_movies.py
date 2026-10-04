#!/usr/bin/env python3
"""Regenerate movies.js for Movie Gross Showdown.

Pulls worldwide lifetime grosses from Box Office Mojo, matches each title to
its TMDB poster by scraping TMDB's server-rendered search pages (no API key
needed), and writes the top POOL_SIZE films to movies.js.

    python3 tools/refresh_movies.py                 # overwrite movies.js
    python3 tools/refresh_movies.py --out /tmp/x.js # write elsewhere
    python3 tools/refresh_movies.py --no-cache      # ignore cached pages

Both sites 403 Python's urllib but serve curl, so every fetch shells out to
curl. TMDB pages are cached under tools/.cache so reruns are cheap.
"""
import argparse
import html as html_mod
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

BOM_URL = "https://www.boxofficemojo.com/chart/ww_top_lifetime_gross/?offset=0"
POOL_SIZE = 150          # films written to movies.js
SCRAPE_SIZE = 200        # films pulled from Box Office Mojo before trimming
IMG_HOST = "https://image.tmdb.org/t/p/w500/"  # canonical host; media.* 301s here
WORKERS = 5

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
CACHE_DIR = os.path.join(HERE, ".cache")


def fetch(url, cache_key=None, use_cache=True):
    """GET a page via curl, optionally memoised on disk."""
    path = os.path.join(CACHE_DIR, cache_key) if cache_key else None
    if path and use_cache and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    cmd = ["curl", "-sL", "--compressed", "--max-time", "30",
           "-A", UA, "-H", "Accept-Language: en-US,en;q=0.9", url]
    for attempt in range(4):
        res = subprocess.run(cmd, capture_output=True, text=True)
        body = res.stdout
        if res.returncode == 0 and len(body) > 2000:
            if path:
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(body)
            return body
        time.sleep(1.5 * (attempt + 1))
    print("  fetch failed: " + url, file=sys.stderr)
    return ""


# ---------------------------------------------------------------- box office

def scrape_box_office(use_cache):
    """Return [{title, year, gross}] sorted by worldwide gross, descending."""
    page = fetch(BOM_URL, "boxofficemojo.html", use_cache)
    if not page:
        sys.exit("could not fetch Box Office Mojo")

    movies = []
    for row in re.findall(r"<tr>(.*?)</tr>", page, re.S):
        cells = [re.sub(r"<[^>]+>", "", c).strip()
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if len(cells) < 8 or not cells[0].isdigit():
            continue
        gross = re.sub(r"[^0-9]", "", cells[2])
        year = re.search(r"(\d{4})", cells[7])
        if not gross or not year:
            continue
        movies.append({
            "title": html_mod.unescape(cells[1]),
            "year": int(year.group(1)),
            "gross": int(gross),
        })

    movies.sort(key=lambda m: -m["gross"])
    return movies[:SCRAPE_SIZE]


# --------------------------------------------------------------------- tmdb

def norm(text):
    return re.sub(r"[^a-z0-9]", "", html_mod.unescape(text or "").lower())


def parse_cards(page):
    """Pull (tmdb id, title, year, poster hash) from a TMDB search page."""
    cards = []
    for chunk in page.split("comp:media-card")[1:]:
        href = re.search(r'href="/movie/(\d+)(?:-[^"?]*)?(?:\?[^"]*)?"', chunk)
        if not href:
            continue
        title = re.search(r'<img alt="([^"]*)" class="poster', chunk)
        date = re.search(r'class="release_date[^"]*">([^<]+)<', chunk)
        poster = re.search(r"/t/p/w\d+_and_h\d+[a-z_]*/([A-Za-z0-9]+)\.(?:jpg|png)", chunk)
        year = re.search(r"(\d{4})", date.group(1)) if date else None
        cards.append({
            "id": int(href.group(1)),
            "title": (title.group(1) if title else "").strip(),
            "year": int(year.group(1)) if year else None,
            "hash": poster.group(1) if poster else None,
        })
    return cards


def pick(cards, want_title, want_year):
    """Score on title match, then year proximity, then TMDB relevance.

    Year alone picks the wrong film: tie-in documentaries ("Beyond the Movie:
    The Fellowship of the Ring") and soundalikes ("The Chambermaid on the
    Titanic") share a release year with the film we want.
    """
    want = norm(want_title)
    best, best_score = None, None
    for index, card in enumerate(cards):
        got = norm(card["title"])
        score = 0.0
        if got and got == want:
            score += 100
        elif got and (got in want or want in got):
            score += 40
        if card["year"] is not None:
            gap = abs(card["year"] - want_year)
            score += {0: 30, 1: 20, 2: 5}.get(gap, -10 * min(gap, 5))
        if card["hash"]:
            score += 10
        score -= index * 0.5
        if best_score is None or score > best_score:
            best, best_score = card, score
    return best


def add_poster(movie, use_cache):
    query = urllib.parse.quote(movie["title"])
    url = "https://www.themoviedb.org/search/movie?query=%s&language=en-US" % query
    key = re.sub(r"[^A-Za-z0-9]+", "_", movie["title"])[:80] + ".html"
    page = fetch(url, key, use_cache)
    best = pick(parse_cards(page), movie["title"], movie["year"]) if page else None
    return dict(movie,
                poster=best["hash"] + ".jpg" if best and best["hash"] else None,
                matched=best["title"] if best else None)


# -------------------------------------------------------------------- output

def write_movies_js(movies, out_path, as_of):
    lines = [
        "// Movie pool for Movie Gross Showdown.",
        "// Worldwide lifetime grosses: Box Office Mojo, snapshot %s." % as_of,
        "// Poster art: TMDB. Generated by tools/refresh_movies.py - edit that,",
        "// not this file.",
        "const BOX_OFFICE_AS_OF = '%s';" % as_of,
        "",
        "const MOVIES = [",
    ]
    for movie in movies:
        title = movie["title"].replace("\\", "\\\\").replace("'", "\\'")
        lines.append("  { title: '%s', year: %d, gross: %d, poster: '%s' },"
                     % (title, movie["year"], movie["gross"], movie["poster"]))
    lines += ["];", ""]
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join(PROJECT, "movies.js"))
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args()
    use_cache = not args.no_cache

    print("fetching Box Office Mojo...")
    movies = scrape_box_office(use_cache)
    print("  got %d films, $%.2fB down to $%.0fM"
          % (len(movies), movies[0]["gross"] / 1e9, movies[-1]["gross"] / 1e6))

    print("matching posters on TMDB (%d lookups)..." % len(movies))
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        matched = list(pool.map(lambda m: add_poster(m, use_cache), movies))

    missing = [m["title"] for m in matched if not m["poster"]]
    if missing:
        print("  no poster for %d: %s" % (len(missing), ", ".join(missing[:10])))
        print("  (rerun to retry; these are usually transient rate limits)")

    usable = [m for m in matched if m["poster"]][:POOL_SIZE]
    if len(usable) < POOL_SIZE:
        sys.exit("only %d usable films, need %d - rerun to retry"
                 % (len(usable), POOL_SIZE))

    as_of = time.strftime("%-d %B %Y")
    write_movies_js(usable, args.out, as_of)
    print("wrote %d films to %s (as of %s)" % (len(usable), args.out, as_of))


if __name__ == "__main__":
    main()
