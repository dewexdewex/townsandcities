# Towns & Cities

Randomised, narrated audiovisual stories. Static site for GitHub Pages: no server, no build step.

## Pages

| URL | What |
|---|---|
| `/` | Public player: title sequence → story with subtitles → credits, then the next random story |
| `/admin/` | CRUD admin for stories, tracks and YouTube video UIDs |

## Deploy

1. Copy the contents of this folder into the repo root (keep `audio/music` as it is).
2. Repo → Settings → Pages → Deploy from branch → `main` / `(root)`.
3. Visit `https://dewexdewex.github.io/townsandcities/`.

The player must be served over https (GitHub Pages is), otherwise the YouTube embeds will not load.

## Admin and "database"

GitHub Pages is static, so the repository itself is the database:

* `data/stories.json`, `data/tracks.json`, `data/videos.json` hold the records.
* Audio uploads go to `audio/stories/` and `audio/music/`.
* Every add, edit and delete is a commit made through the GitHub Contents API.

**Sign-in:** GitHub's OAuth web flow needs a server-side secret, which a static site cannot hold, so the admin uses a
fine-grained personal access token instead:

1. <https://github.com/settings/personal-access-tokens/new>
2. Repository access: only `townsandcities`. Permissions → Contents: **Read and write**.
3. Paste it into `/admin/`. It is kept in `sessionStorage` (cleared when the tab closes) and is sent only to api.github.com.

Only someone holding a token with write access can change anything, even though the page itself is public.

**Existing files:** use *Import existing files* on the Tracks tab (folder `audio/music`) to register the mp3s you have already
uploaded, then Edit each to add author and copyright date. Same for Stories.

**Deleting:** select rows → Delete selected → confirm. You then get 10 seconds to Undo before the commit happens.

**Video UIDs:** upload/paste a CSV; any 11-character ID or YouTube link in it is picked up. With "look up" ticked, each ID is
checked against YouTube (title and channel are stored, and videos that are missing or not embeddable are skipped).

Changes appear on the public site after GitHub Pages rebuilds, usually within a minute.

## How the player behaves

* Stories are shuffled; when all have played, reshuffled. A track is picked at random per chapter.
* Two YouTube players alternate. Each clip is a random video, random start point, 4–12 s, muted, cross-faded.
* Music rises for the titles, ducks to about 20% under the narration (voice is always dominant), rises for the credits and fades out.
* Subtitles come from the transcript, split into sentences and paced proportionally across the narration length.
* Controls: play/pause (Space), next (N or →), mute (M), volume, subtitles toggle. They fade out when idle.
* A "Begin" tap is required first; browsers block audio without it.

Tunable constants are at the top of `js/app.js`.

## Data format

```json
// data/stories.json
{ "stories": [{ "id": "…", "title": "…", "author": "…", "copyright": "2026-01-31",
  "file": "audio/stories/….mp3", "duration": 312, "transcript": "…", "added": "ISO date" }] }
// data/tracks.json
{ "tracks": [{ "id": "…", "title": "…", "author": "…", "copyright": "2025-05-01", "file": "audio/music/….mp3", "added": "…" }] }
// data/videos.json
{ "videos": [{ "id": "11-char UID", "title": "…", "channel": "…", "added": "…" }] }
```
