# Deezer Album Shuffle

Shuffle through your Deezer album library with full playback — no official API registration needed.

Uses the ARL cookie approach to authenticate with Deezer's internal APIs, with server-side BF-CBC decryption for premium streaming.

## Dependencies

- **Node.js** 18+ (v20+ recommended)
- No npm packages required — zero dependencies

## How to Run

```bash
# 1. Clone the repo
git clone https://github.com/Leotomas/deezer-album-shuffle.git
cd deezer-album-shuffle

# 2. Start the server (BF-CBC decryption requires legacy OpenSSL)
node --openssl-legacy-provider server.js

# 3. Open http://localhost:3001 in your browser

# 4. Paste your Deezer ARL cookie (see below)
```

The server runs on port **3001** by default. Set the `PORT` environment variable to change it.

### Getting your ARL cookie

1. Log into [deezer.com](https://www.deezer.com) in your browser
2. Open DevTools (F12) → Application → Cookies → `https://www.deezer.com`
3. Find the cookie named `arl` — copy its value (should be ~192 characters)
4. Paste it into the app's login screen

> ⚠️ Logging out of Deezer or changing your password invalidates the ARL cookie.

### Streaming quality

| Setting | Format | Bitrate |
|---------|--------|---------|
| 128 kbps | MP3 | 128 |
| 320 kbps | MP3 | 320 |
| FLAC | Lossless | ~1411 |

Quality can be changed in-app at any time — the current track reloads automatically.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `DEEZER_ARL` | — | Pre-set ARL cookie (skip manual entry) |

## How it works

1. **Auth** — Your ARL cookie is sent to Deezer's `gw-light` API to establish a session and fetch a `license_token` for premium streaming
2. **Library** — Album list is fetched via the public Deezer API (paginated, with ARL auth)
3. **Streaming** — Track URLs are obtained from `media.deezer.com/v1/get_url` using `track_token` + `license_token`
4. **Decryption** — Premium streams are BF-CBC encrypted; the server decrypts them before sending to the browser
5. **Playback** — Decrypted audio is served as standard MP3/FLAC via the `/api/stream/:trackId` endpoint

## License

This is free and unencumbered software released into the public domain under [The Unlicense](https://unlicense.org/). Do whatever you want with it.