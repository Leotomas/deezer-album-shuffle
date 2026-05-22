// Self-restart with --openssl-legacy-provider if needed (for BF-CBC decryption)
if (!process.execArgv.includes('--openssl-legacy-provider')) {
  const { spawn } = require('child_process');
  console.log('Restarting with --openssl-legacy-provider…');
  const child = spawn(process.argv[0], ['--openssl-legacy-provider', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });
  child.unref();
  process.exit(0);
}

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3001;

// ── Config ──────────────────────────────────────────
let ARL = process.env.DEEZER_ARL || '';
let SID = '';
let USER_ID = '';
let LICENSE_TOKEN = '';
let USER_OPTIONS = {};
let DZR_UNIQ_ID = '';
let FAMILY_USER_ID = '';
let ARL_EXPIRY = null; // ISO date when ARL cookie expires
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (c.arl) ARL = c.arl;
    if (c.sid) SID = c.sid;
    if (c.userId) USER_ID = c.userId;
    if (c.dzr_uniq_id) DZR_UNIQ_ID = c.dzr_uniq_id;
    if (c.familyUserId) FAMILY_USER_ID = c.familyUserId;
    if (c.arlExpiry) ARL_EXPIRY = c.arlExpiry;
  } catch {}
}
loadConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ arl: ARL, sid: SID, userId: USER_ID, dzr_uniq_id: DZR_UNIQ_ID, familyUserId: FAMILY_USER_ID, arlExpiry: ARL_EXPIRY }, null, 2));
}

function cookieHeader() {
  let c = 'arl=' + ARL;
  if (DZR_UNIQ_ID) c += '; dzr_uniq_id=' + DZR_UNIQ_ID;
  if (FAMILY_USER_ID) c += '; familyUserId=' + FAMILY_USER_ID;
  return c;
}

// ── Deezer Decryption ───────────────────────────────
const BF_SECRET = 'g4el58wc0zvf9na1';

function md5Hex(data) {
  return crypto.createHash('md5').update(data.toString()).digest('hex');
}

function getBlowfishKey(trackId) {
  const idMd5 = md5Hex(trackId);
  let key = '';
  for (let i = 0; i < 16; i++) {
    key += String.fromCharCode(idMd5.charCodeAt(i) ^ idMd5.charCodeAt(i + 16) ^ BF_SECRET.charCodeAt(i));
  }
  return key;
}

function decryptChunk(chunk, bfKey) {
  const decipher = crypto.createDecipheriv('bf-cbc', bfKey, Buffer.from([0,1,2,3,4,5,6,7]));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(chunk), decipher.final()]);
}

function decryptBuffer(source, trackId) {
  const bfKey = getBlowfishKey(trackId);
  const CHUNK_SIZE = 2048;
  const dest = Buffer.alloc(source.length);
  let pos = 0;
  let i = 0;
  while (pos < source.length) {
    const size = Math.min(CHUNK_SIZE, source.length - pos);
    const chunk = source.slice(pos, pos + size);
    const decrypted = (i % 3 === 0 && size === CHUNK_SIZE) ? decryptChunk(chunk, bfKey) : chunk;
    decrypted.copy(dest, pos);
    pos += size;
    i++;
  }
  return dest;
}

// ── Deezer Gateway API ───────────────────────────────
const API_KEY = 'ZAIVAHCEISOHWAICUQUEXAEPICENGUAFAEZAIPHAELEEVAHPHUCUFONGUAPASUAY';
const BASE_PARAMS = {
  version: '8.32.0',
  api_key: API_KEY,
  output: 3,
  input: 3,
  buildId: 'ios12_universal',
  screenHeight: '480',
  screenWidth: '320',
  lang: 'en',
};

const IOS_UA = 'Deezer/8.32.0.2 (iOS; 14.4; Mobile; en; iPhone10_5)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function buildQuery(method, extra = {}) {
  const qp = { ...BASE_PARAMS, method, api_version: '1.0', api_token: '', ...extra };
  if (SID) qp.sid = SID;
  return Object.entries(qp).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function gwPost(method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = buildQuery(method);
    const postData = JSON.stringify(params);
    const opts = {
      hostname: 'api.deezer.com',
      path: `/1.0/gateway.php?${qs}`,
      method: 'POST',
      headers: { 'Cookie': cookieHeader(), 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': Buffer.byteLength(postData), 'Accept': '*/*', 'User-Agent': IOS_UA, 'Accept-Language': 'en-US', 'Cache-Control': 'no-cache' }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from gateway POST')); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function gwGet(method, extraParams = {}) {
  return new Promise((resolve, reject) => {
    const qs = buildQuery(method, extraParams);
    const opts = {
      hostname: 'api.deezer.com',
      path: `/1.0/gateway.php?${qs}`,
      method: 'GET',
      headers: { 'Cookie': cookieHeader(), 'Accept': '*/*', 'User-Agent': IOS_UA, 'Accept-Language': 'en-US', 'Cache-Control': 'no-cache' }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from gateway GET')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Call www.deezer.com/ajax/gw-light.php (for getUserData with license_token)
function gwLightGet(method) {
  return new Promise((resolve, reject) => {
    const qs = `method=${encodeURIComponent(method)}&api_version=1.0&api_token=null${SID ? '&sid=' + encodeURIComponent(SID) : ''}`;
    const opts = {
      hostname: 'www.deezer.com',
      path: `/ajax/gw-light.php?${qs}`,
      method: 'GET',
      headers: { 'Cookie': cookieHeader(), 'Accept': '*/*', 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US', 'Cache-Control': 'no-cache' }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from gw-light')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Init session
async function initSession() {
  if (!ARL) throw new Error('No ARL set');
  const data = await new Promise((resolve, reject) => {
    const qs = buildQuery('deezer.ping');
    const opts = {
      hostname: 'www.deezer.com',
      path: `/ajax/gw-light.php?${qs}`,
      method: 'POST',
      headers: { 'Cookie': cookieHeader(), 'Content-Type': 'application/json; charset=UTF-8', 'Accept': '*/*', 'User-Agent': IOS_UA, 'Cache-Control': 'no-cache' }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Invalid JSON from deezer.ping')); } });
    });
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
  if (data.error && data.error.GATEWAY_ERROR) throw new Error(data.error.GATEWAY_ERROR);
  SID = data.results?.SESSION || '';
  if (!SID) throw new Error('No session from deezer.ping');
  saveConfig();
  return SID;
}

// Fetch user data including license_token
async function fetchUserData() {
  const data = await gwLightGet('deezer.getUserData');
  const results = data.results || {};
  const user = results.USER || {};
  const options = user.OPTIONS || {};
  USER_ID = user.USER_ID || USER_ID;
  LICENSE_TOKEN = options.license_token || '';
  USER_OPTIONS = {
    can_stream_lossless: !!(options.web_lossless || options.mobile_lossless),
    can_stream_hq: !!(options.web_hq || options.mobile_hq),
    country: results.COUNTRY || '',
  };
  saveConfig();
  return { USER_ID, LICENSE_TOKEN, USER_OPTIONS };
}

async function getUser() {
  const data = await gwGet('user_getInfo');
  if (data.error && Array.isArray(data.error) && data.error.length > 0) throw new Error('User info failed');
  return data.results || data;
}

// Public API (for album library, uses ARL cookie for auth)
function deezerPublicGet(apiPath, retries = 2) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.deezer.com',
      path: apiPath,
      method: 'GET',
      headers: { 'Cookie': cookieHeader(), 'User-Agent': BROWSER_UA, 'Accept': 'application/json' }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Retry on rate limit
          if (parsed.error && parsed.error.code === 4 && retries > 0) {
            setTimeout(() => deezerPublicGet(apiPath, retries - 1).then(resolve, reject), 1000);
            return;
          }
          resolve(parsed);
        } catch { reject(new Error('Invalid JSON from public API')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Get track stream URL using proper media.deezer.com API
async function getTrackStreamUrl(trackId, quality = 1) {
  // 1=128k, 3=320k, 9=FLAC
  const formatName = quality === 9 ? 'FLAC' : quality === 3 ? 'MP3_320' : 'MP3_128';

  // Get track data to find TRACK_TOKEN
  const trackData = await gwPost('song.getData', { sng_id: String(trackId) });
  if (trackData.error && Array.isArray(trackData.error) && trackData.error.length > 0) {
    throw new Error('Track data failed');
  }
  let trackResults = trackData.results || {};
  let trackToken = trackResults.TRACK_TOKEN;

  // If track is STATUS 3 (unavailable in region), try to find it via redirected album
  if (trackResults.STATUS === 3 && trackResults.ALB_ID) {
    try {
      const pubAlbum = await deezerPublicGet(`/album/${trackResults.ALB_ID}`);
      if (pubAlbum.id && pubAlbum.id !== Number(trackResults.ALB_ID)) {
        // Public API redirected to a different album version
        const redirectTracks = await gwPost('song.getListByAlbum', { alb_id: String(pubAlbum.id), nb: 300, lang: 'en' });
        const rTracks = redirectTracks.results?.data || [];
        const matchTrack = rTracks.find(t =>
          (t.SNG_TITLE || t.TITLE || '').toLowerCase().trim() === (trackResults.SNG_TITLE || trackResults.TITLE || '').toLowerCase().trim()
          || t.TRACK_NUMBER === trackResults.TRACK_NUMBER
        );
        if (matchTrack && matchTrack.STATUS !== 3 && matchTrack.STATUS !== 0) {
          const redirectData = await gwPost('song.getData', { sng_id: String(matchTrack.SNG_ID) });
          if (redirectData.results?.TRACK_TOKEN && redirectData.results.STATUS === 1) {
            trackResults = redirectData.results;
            trackToken = redirectData.results.TRACK_TOKEN;
          }
        }
      } else if (pubAlbum.error) {
        // Album not in public API — search by title and artist
        const albumInfo = await gwPost('album.getData', { alb_id: String(trackResults.ALB_ID), lang: 'en' });
        const albumTitle = albumInfo.results?.ALB_TITLE;
        const artistName = albumInfo.results?.ART_NAME;
        if (albumTitle && artistName) {
          const searchResult = await deezerPublicGet(`/search/album?q=${encodeURIComponent(albumTitle + ' ' + artistName)}&limit=5`);
          const found = (searchResult.data || []).find(a =>
            a.title.toLowerCase().replace(/[^a-z0-9 ]/g, '') === albumTitle.toLowerCase().replace(/[^a-z0-9 ]/g, '')
          );
          if (found && found.id) {
            const redirectTracks = await gwPost('song.getListByAlbum', { alb_id: String(found.id), nb: 300, lang: 'en' });
            const rTracks = redirectTracks.results?.data || [];
            const matchTrack = rTracks.find(t =>
              (t.SNG_TITLE || t.TITLE || '').toLowerCase().trim() === (trackResults.SNG_TITLE || trackResults.TITLE || '').toLowerCase().trim()
              || t.TRACK_NUMBER === trackResults.TRACK_NUMBER
            );
            if (matchTrack && matchTrack.STATUS !== 3 && matchTrack.STATUS !== 0) {
              const redirectData = await gwPost('song.getData', { sng_id: String(matchTrack.SNG_ID) });
              if (redirectData.results?.TRACK_TOKEN && redirectData.results.STATUS === 1) {
                trackResults = redirectData.results;
                trackToken = redirectData.results.TRACK_TOKEN;
              }
            }
          }
        }
      }
    } catch (e) { /* fall through with original track */ }
  }

  if (!trackToken) throw new Error('No track token');

  // If we have license_token, use the proper streaming API
  if (LICENSE_TOKEN) {
    try {
      const body = JSON.stringify({
        license_token: LICENSE_TOKEN,
        media: [{ type: 'FULL', formats: [{ format: formatName, cipher: 'BF_CBC_STRIPE' }] }],
        track_tokens: [trackToken],
      });
      const streamUrl = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'media.deezer.com',
          path: '/v1/get_url',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = https.request(opts, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const mediaUrl = parsed.data?.[0]?.media?.[0]?.sources?.[0]?.url;
              if (mediaUrl) resolve(mediaUrl);
              else {
                // Check for rights error — don't fall back to preview
                const errCode = parsed.data?.[0]?.errors?.[0]?.code;
                if (errCode === 2002) reject(new Error('UNAVAILABLE'));
                else reject(new Error('No media URL'));
              }
            } catch { reject(new Error('Invalid CDN response')); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      return { url: streamUrl, premium: true, encrypted: streamUrl.includes('/media/') || streamUrl.includes('/mobile/') };
    } catch (e) {
      if (e.message === 'UNAVAILABLE') throw new Error('Track not available for streaming');
      console.error('Premium stream failed, falling back:', e.message);
    }
  }

  // Fallback: try preview from MEDIA array
  if (trackResults.MEDIA && trackResults.MEDIA.length > 0) {
    for (const media of trackResults.MEDIA) {
      if (media.TYPE !== 'preview' && media.HREF) return { url: media.HREF, premium: false };
    }
    const preview = trackResults.MEDIA.find(m => m.HREF);
    if (preview) return { url: preview.HREF, premium: false, preview: true };
  }

  // Last resort: public API preview
  throw new Error('No stream available');
}

function parseRange(rangeHeader, totalLength) {
  const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!m) return { start: 0, end: totalLength - 1 };
  const start = parseInt(m[1]);
  const end = m[2] ? parseInt(m[2]) : totalLength - 1;
  return { start, end: Math.min(end, totalLength - 1) };
}

// ── HTTP Helpers ─────────────────────────────────────
function jsonRes(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { jsonRes(res, 404, { error: 'Not found' }); return; }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
  });
}

// ── API Handler ─────────────────────────────────────
async function handleAPI(req, res, pathname, query) {
  try {
    if (pathname === '/api/set-arl' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { arl, arlExpiry } = JSON.parse(body);
          if (!arl) return jsonRes(res, 400, { error: 'Missing arl' });
          if (arl.length !== 192) return jsonRes(res, 400, { error: 'ARL must be 192 characters. Got ' + arl.length });
          ARL = arl;
          ARL_EXPIRY = arlExpiry || null;
          SID = '';
          USER_ID = '';
          LICENSE_TOKEN = '';
          saveConfig();
          try {
            await initSession();
            await fetchUserData();
            const user = await getUser();
            USER_ID = user.USER_ID;
            saveConfig();
            jsonRes(res, 200, {
              ok: true,
              message: 'Connected as ' + (user.BLOG_NAME || user.USER_NAME || 'Unknown'),
              premium: !!LICENSE_TOKEN,
              user: { id: user.USER_ID, name: user.BLOG_NAME || user.USER_NAME },
              arlExpiry: ARL_EXPIRY
            });
          } catch (e) {
            ARL = ''; SID = ''; USER_ID = ''; LICENSE_TOKEN = ''; ARL_EXPIRY = null;
            saveConfig();
            jsonRes(res, 401, { error: 'ARL invalid or expired: ' + e.message });
          }
        } catch { jsonRes(res, 400, { error: 'Invalid JSON' }); }
      });
      return;
    }

    if (!ARL) return jsonRes(res, 401, { error: 'No ARL set' });
    if (!SID) {
      try { await initSession(); } catch (e) { return jsonRes(res, 401, { error: 'Session failed: ' + e.message }); }
    }
    if (!LICENSE_TOKEN) {
      try { await fetchUserData(); } catch (e) { console.error('User data fetch failed:', e.message); }
    }

    // Status
    if (pathname === '/api/logout' && req.method === 'POST') {
      ARL = ''; SID = ''; USER_ID = ''; LICENSE_TOKEN = ''; ARL_EXPIRY = null;
      saveConfig();
      jsonRes(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/status') {
      try {
        if (!USER_ID) { const user = await getUser(); USER_ID = user.USER_ID; saveConfig(); }
        jsonRes(res, 200, { arl: true, valid: true, premium: !!LICENSE_TOKEN, user: { id: USER_ID, premium: !!LICENSE_TOKEN }, arlExpiry: ARL_EXPIRY });
      } catch { jsonRes(res, 200, { arl: true, valid: false }); }
      return;
    }

    // Albums - use mobile.pageUser with tab=albums
    if (pathname === '/api/albums') {
      const limit = parseInt(query.limit) || 100;
      const start = parseInt(query.start) || 0;
      try {
        if (!USER_ID) { const user = await getUser(); USER_ID = user.USER_ID; saveConfig(); }
        // Use public API for full album library (mobile.pageUser only returns 4)
        const pubData = await deezerPublicGet(`/user/${USER_ID}/albums?limit=${limit}&index=${start}`);
        if (pubData.error) throw new Error(pubData.error.message || pubData.error);
        const albumsRaw = pubData.data || [];
        const total = pubData.total || albumsRaw.length;
        const albums = albumsRaw.map(a => ({
          id: a.id, title: a.title,
          artist: { id: a.artist?.id, name: a.artist?.name },
          cover_medium: a.cover_medium || '',
          cover_big: a.cover_big || '',
          cover: a.cover_medium || a.cover || '',
        }));
        jsonRes(res, 200, { data: albums, total, hasMore: start + albums.length < total });
      } catch (e) { jsonRes(res, 500, { error: 'Albums fetch failed: ' + e.message }); }
      return;
    }

    // Search
    if (pathname === '/api/search') {
      const q = query.q || '';
      try {
        const data = await gwPost('search_music', { query: q, filter: 'ALBUM', limit: 50, nb: 50 });
        const albumsRaw = data.results?.ALBUM || [];
        const albums = albumsRaw.map(a => ({
          id: a.ALB_ID, title: a.ALB_TITLE,
          artist: { id: a.ART_ID, name: a.ART_NAME },
          cover_medium: a.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${a.ALB_PICTURE}/156x156-000000-80-0-0.jpg` : '',
          cover_big: a.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${a.ALB_PICTURE}/500x500-000000-80-0-0.jpg` : '',
          cover: a.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${a.ALB_PICTURE}/156x156-000000-80-0-0.jpg` : '',
        }));
        jsonRes(res, 200, { data: albums });
      } catch (e) { jsonRes(res, 500, { error: e.message }); }
      return;
    }

    // Album tracks
    if (pathname.startsWith('/api/album/') && pathname.endsWith('/tracks')) {
      const id = pathname.split('/')[3];
      try {
        const data = await gwPost('song.getListByAlbum', { alb_id: String(id), nb: 300, lang: 'en' });
        let tracksRaw = data.results?.data || data.results || [];
        // If all tracks are STATUS 3 (unavailable), try the public API to get the redirected album
        const allUnavailable = tracksRaw.length > 0 && tracksRaw.every(t => t.STATUS === 3 || t.STATUS === 0);
        if (allUnavailable) {
          try {
            const pubAlbum = await deezerPublicGet(`/album/${id}`);
            if (pubAlbum.id && pubAlbum.id !== Number(id)) {
              // Public API redirected to a different album (regional version)
              const redirectData = await gwPost('song.getListByAlbum', { alb_id: String(pubAlbum.id), nb: 300, lang: 'en' });
              const redirectTracks = redirectData.results?.data || redirectData.results || [];
              if (redirectTracks.length > 0 && !redirectTracks.every(t => t.STATUS === 3 || t.STATUS === 0)) {
                tracksRaw = redirectTracks;
              }
            } else if (pubAlbum.error) {
              // Album not found in public API — search by title and artist
              const albumInfo = await gwPost('album.getData', { alb_id: String(id), lang: 'en' });
              const albumTitle = albumInfo.results?.ALB_TITLE;
              const artistName = albumInfo.results?.ART_NAME;
              if (albumTitle && artistName) {
                const searchResult = await deezerPublicGet(`/search/album?q=${encodeURIComponent(albumTitle + ' ' + artistName)}&limit=5`);
                const found = (searchResult.data || []).find(a =>
                  a.title.toLowerCase().replace(/[^a-z0-9 ]/g, '') === albumTitle.toLowerCase().replace(/[^a-z0-9 ]/g, '')
                );
                if (found && found.id && found.id !== Number(id)) {
                  const redirectData = await gwPost('song.getListByAlbum', { alb_id: String(found.id), nb: 300, lang: 'en' });
                  const redirectTracks = redirectData.results?.data || redirectData.results || [];
                  if (redirectTracks.length > 0 && !redirectTracks.every(t => t.STATUS === 3 || t.STATUS === 0)) {
                    tracksRaw = redirectTracks;
                  }
                }
              }
            }
          } catch (e) { /* fall through with original tracks */ }
        }
        const tracks = tracksRaw.map(t => ({
          id: t.SNG_ID, title: t.SNG_TITLE || t.TITLE, duration: t.DURATION,
          artist: { id: t.ART_ID, name: t.ART_NAME }, disk_number: t.DISK_NUMBER, track_number: t.TRACK_NUMBER,
          status: t.STATUS, // 0=not available, 1=available, 3=rights issue
        }));
        jsonRes(res, 200, { data: tracks });
      } catch (e) { jsonRes(res, 500, { error: e.message }); }
      return;
    }

    // Album info
    if (pathname.startsWith('/api/album/')) {
      const id = pathname.split('/')[3];
      try {
        const data = await gwPost('album.getData', { alb_id: String(id), lang: 'en' });
        const r = data.results || {};
        jsonRes(res, 200, {
          id: r.ALB_ID, title: r.ALB_TITLE,
          artist: { id: r.ART_ID, name: r.ART_NAME },
          cover_medium: r.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${r.ALB_PICTURE}/156x156-000000-80-0-0.jpg` : '',
          cover_big: r.ALB_PICTURE ? `https://e-cdns-images.dzcdn.net/images/cover/${r.ALB_PICTURE}/500x500-000000-80-0-0.jpg` : '',
          nb_tracks: r.NB_TRACK,
        });
      } catch (e) { jsonRes(res, 500, { error: e.message }); }
      return;
    }

    // Fix broken cover art — fetches correct cover from public album API
    if (pathname.startsWith('/api/fix-cover/') && req.method === 'GET') {
      const id = pathname.split('/')[3];
      try {
        let detail = await deezerPublicGet(`/album/${id}`);
        // If public API returns error, search by title+artist
        if (detail.error || !detail.id) {
          const albumInfo = await gwPost('album.getData', { alb_id: String(id), lang: 'en' });
          const albumTitle = albumInfo.results?.ALB_TITLE;
          const artistName = albumInfo.results?.ART_NAME;
          if (albumTitle && artistName) {
            const searchResult = await deezerPublicGet(`/search/album?q=${encodeURIComponent(albumTitle + ' ' + artistName)}&limit=5`);
            const found = (searchResult.data || []).find(a =>
              a.title.toLowerCase().replace(/[^a-z0-9 ]/g, '') === albumTitle.toLowerCase().replace(/[^a-z0-9 ]/g, '')
            );
            if (found && found.id) {
              detail = found;
            }
          }
        }
        if (detail.error || !detail.id) { jsonRes(res, 404, { error: 'Album not found' }); return; }
        const coverMedium = detail.cover_medium || '';
        const coverBig = detail.cover_big || '';
        jsonRes(res, 200, { id: detail.id, cover_medium: coverMedium, cover_big: coverBig, nb_tracks: detail.nb_tracks || 0, record_type: detail.record_type || '' });
      } catch (e) { jsonRes(res, 500, { error: e.message }); }
      return;
    }

    // Stream
    if (pathname.startsWith('/api/stream/')) {
      const trackId = pathname.split('/')[3];
      const quality = parseInt(query.quality) || (LICENSE_TOKEN ? 3 : 1);
      try {
        const streamInfo = await getTrackStreamUrl(trackId, quality);
        if (streamInfo.url) {
          const parsed = new URL(streamInfo.url);
          const opts = {
            hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET',
            headers: { 'User-Agent': BROWSER_UA }
          };

          if (streamInfo.encrypted) {
            // Download entire encrypted file, decrypt, then send
            const proxyReq = https.request(opts, proxyRes => {
              const chunks = [];
              let totalLen = 0;
              proxyRes.on('data', c => { chunks.push(c); totalLen += c.length; });
              proxyRes.on('end', () => {
                const encrypted = Buffer.concat(chunks, totalLen);
                try {
                  const decrypted = decryptBuffer(encrypted, trackId);
                  const h = { 'Content-Type': 'audio/mpeg', 'Content-Length': decrypted.length, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
                  if (req.headers.range) {
                    const range = parseRange(req.headers.range, decrypted.length);
                    h['Content-Range'] = `bytes ${range.start}-${range.end}/${decrypted.length}`;
                    h['Content-Length'] = range.end - range.start + 1;
                    res.writeHead(206, h);
                    res.end(decrypted.slice(range.start, range.end + 1));
                  } else {
                    res.writeHead(200, h);
                    res.end(decrypted);
                  }
                } catch (e) {
                  console.error('Decrypt failed:', e.message);
                  jsonRes(res, 500, { error: 'Decryption failed' });
                }
              });
            });
            proxyReq.on('error', () => jsonRes(res, 500, { error: 'Stream download failed' }));
            proxyReq.end();
          } else {
            // Not encrypted — proxy directly
            if (req.headers.range) opts.headers['Range'] = req.headers.range;
            const proxyReq = https.request(opts, proxyRes => {
              const h = { 'Content-Type': proxyRes.headers['content-type'] || 'audio/mpeg', 'Access-Control-Allow-Origin': '*' };
              if (proxyRes.headers['content-length']) h['Content-Length'] = proxyRes.headers['content-length'];
              if (proxyRes.headers['content-range']) h['Content-Range'] = proxyRes.headers['content-range'];
              if (proxyRes.headers['accept-ranges']) h['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
              res.writeHead(proxyRes.statusCode, h);
              proxyRes.pipe(res);
            });
            proxyReq.on('error', () => jsonRes(res, 500, { error: 'Stream failed' }));
            proxyReq.end();
          }
          return;
        }
        jsonRes(res, 404, { error: 'No stream URL' });
      } catch (e) {
        jsonRes(res, 500, { error: e.message });
      }
      return;
    }

// New-releases cache (TTL 1 hour)
let _nrCache = null;
let _nrCacheTime = 0;
const NR_CACHE_TTL = 60 * 60 * 1000;

    // New Releases - albums from followed artists (last 30 days, 3+ tracks, not singles, not in library)
    if (pathname === '/api/new-releases') {
      const noCache = query.refresh === '1';
      try {
        if (!noCache && _nrCache && (Date.now() - _nrCacheTime) < NR_CACHE_TTL) {
          return jsonRes(res, 200, _nrCache);
        }
        if (!USER_ID) { const user = await getUser(); USER_ID = user.USER_ID; saveConfig(); }
        // 1. Fetch followed artists (with pagination)
        const allArtists = [];
        let aIdx = 0;
        while (true) {
          const ap = await deezerPublicGet(`/user/${USER_ID}/artists?limit=200&index=${aIdx}`);
          allArtists.push(...(ap.data || []));
          if (!ap.data || ap.data.length < 200 || allArtists.length >= (ap.total || 0)) break;
          aIdx += ap.data.length;
        }
        // 2. Fetch library album IDs for dedup (parallel-ish, limited concurrency)
        const libraryIds = new Set();
        const libFirst = await deezerPublicGet(`/user/${USER_ID}/albums?limit=500&index=0`);
        const libTotal = libFirst.total || 0;
        for (const a of (libFirst.data || [])) libraryIds.add(String(a.id));
        const libPromises = [];
        for (let i = 500; i < libTotal; i += 500) {
          libPromises.push(deezerPublicGet(`/user/${USER_ID}/albums?limit=500&index=${i}`));
        }
        const libPages = await Promise.all(libPromises);
        for (const page of libPages) for (const a of (page.data || [])) libraryIds.add(String(a.id));
        // 3. Fetch recent albums from artists (parallel, batched 5 with delay to avoid rate limits)
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const albumMap = new Map();
        const BATCH = 5;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < allArtists.length; i += BATCH) {
          const batch = allArtists.slice(i, i + BATCH);
          const results = await Promise.allSettled(batch.map(ar => deezerPublicGet(`/artist/${ar.id}/albums?limit=50`)));
          for (let ri = 0; ri < results.length; ri++) {
            const r = results[ri];
            if (r.status !== 'fulfilled') continue;
            const albPage = r.value;
            const artistInfo = batch[ri];
            for (const a of (albPage.data || [])) {
              const type = (a.record_type || a.type || '').toLowerCase();
              if (type === 'single') continue;
              const nb = a.nb_tracks || a.track_count || 0;
              if (nb > 0 && nb < 3) continue;
              if (libraryIds.has(String(a.id))) continue;
              if (!a.release_date) continue;
              if (new Date(a.release_date) < cutoff) continue;
              if (albumMap.has(a.id)) continue;
              albumMap.set(a.id, {
                id: a.id, title: a.title,
                artist: { id: a.artist?.id || artistInfo.id, name: a.artist?.name || artistInfo.name || '' },
                cover_medium: a.cover_medium || '', cover_big: a.cover_big || '', cover: a.cover_medium || a.cover || '',
                release_date: a.release_date, nb_tracks: nb,
              });
            }
          }
          if (i + BATCH < allArtists.length) await sleep(1000); // rate limit cushion
        }
        const newReleases = [...albumMap.values()].sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''));
        // No server-side enrichment — too many rate limit failures.
        // Frontend enriches lazily via /api/album-detail/:id
        const filtered = newReleases;
        _nrCache = { data: filtered };
        _nrCacheTime = Date.now();
        jsonRes(res, 200, _nrCache);
      } catch (e) { jsonRes(res, 500, { error: 'New releases fetch failed: ' + e.message }); }
      return;
    }

    // Add album to library
    if (pathname.startsWith('/api/add-album/') && req.method === 'POST') {
      const albumId = pathname.split('/')[3];
      try {
        await gwPost('album_addFavorite', { alb_id: String(albumId) });
        _nrCache = null; // Invalidate cache since library changed
        jsonRes(res, 200, { ok: true });
      } catch (e) { jsonRes(res, 500, { error: 'Add album failed: ' + e.message }); }
      return;
    }

    // Album detail (lazy enrichment for new releases)
    if (pathname.startsWith('/api/album-detail/') && req.method === 'GET') {
      const albumId = pathname.split('/')[3];
      try {
        const detail = await deezerPublicGet(`/album/${albumId}`);
        if (detail.error) { jsonRes(res, 500, detail); return; }
        jsonRes(res, 200, {
          id: detail.id,
          title: detail.title,
          artist: detail.artist ? { id: detail.artist.id, name: detail.artist.name } : {},
          nb_tracks: detail.nb_tracks || 0,
          record_type: detail.record_type || '',
          release_date: detail.release_date || '',
          cover_medium: detail.cover_medium || '',
          cover_big: detail.cover_big || ''
        });
      } catch (e) { jsonRes(res, 500, { error: e.message }); }
      return;
    }

    jsonRes(res, 404, { error: 'Unknown route' });
  } catch (e) { jsonRes(res, 500, { error: e.message }); }
}

// ── Static ──────────────────────────────────────────
const MIME = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Range','Access-Control-Max-Age':'86400'}); res.end(); return; }
  if (parsed.pathname.startsWith('/api/')) return handleAPI(req, res, parsed.pathname, parsed.query);
  let filePath = path.join(__dirname, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
  sendFile(res, filePath, MIME[path.extname(filePath)] || 'application/octet-stream');
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Deezer Album Shuffle on http://0.0.0.0:${PORT}`);
  if (ARL) {
    console.log('ARL loaded');
    try {
      await initSession();
      console.log('Session OK');
      await fetchUserData();
      console.log('Premium:', !!LICENSE_TOKEN, '| License:', LICENSE_TOKEN ? LICENSE_TOKEN.slice(0,20) + '...' : 'none');
      const user = await getUser();
      USER_ID = user.USER_ID;
      saveConfig();
      console.log('User:', user.BLOG_NAME || user.USER_NAME, 'ID:', user.USER_ID);
    } catch (e) { console.log('Init failed:', e.message); }
  } else { console.log('No ARL — use /api/set-arl'); }
});