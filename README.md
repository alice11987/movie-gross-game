# Movie Gross Showdown

A browser game: two movies, pick the one that earned more at the worldwide
box office. The pairs are deliberately close, so it's a judgement call rather
than an obvious one.

## How it plays

- A run is **32 matches** drawn from a pool of 150 films (64 movies in play
  per run, so no two runs are the same).
- **Sudden death** — one wrong answer ends the run. Your best streak is saved
  locally.
- **Difficulty ramp** — match 1 pairs films roughly 2.2x apart; the gap
  narrows every round until match 32 pairs films within about 3% of each
  other.
- Click a poster, or use the arrow keys.

## Running locally

No build step and no dependencies. Open `index.html` in a browser:

```bash
open index.html
```

Poster art is loaded from TMDB, so posters need an internet connection.
Offline, each card falls back to a title-and-year card and the game still
plays normally.

## Deploying to Render

The repo includes `render.yaml`, so Render can pick the settings up
automatically:

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New** → **Blueprint**, pick
   this repo, and apply. Render reads `render.yaml` and creates the static
   site.

To set it up by hand instead, choose **New** → **Static Site** and use:

| Setting           | Value      |
| ----------------- | ---------- |
| Build command     | *(empty)*  |
| Publish directory | `.`        |

Pushes to `main` then auto-deploy.

## Refreshing the box office data

`movies.js` is a generated snapshot — worldwide lifetime grosses as of
4 October 2026. To bring it up to date:

```bash
python3 tools/refresh_movies.py
```

That pulls grosses from Box Office Mojo, matches each title to its TMDB
poster by scraping TMDB's server-rendered search pages (no API key needed),
and rewrites `movies.js`. TMDB pages are cached under `tools/.cache`, so
reruns are cheap. Occasional lookups fail to rate limiting — the script says
which ones, and rerunning picks them up from cache.

Useful flags: `--out <path>` to write elsewhere, `--no-cache` to refetch
everything.

## Credits

Box office figures from [Box Office Mojo](https://www.boxofficemojo.com/).
Poster art courtesy of [TMDB](https://www.themoviedb.org/). This product uses
the TMDB API but is not endorsed or certified by TMDB.
