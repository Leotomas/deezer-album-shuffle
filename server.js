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
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (c.arl) ARL = c.arl;
    if (c.sid) SID = c.sid;
    if (c.userId) USER_ID = c.userId;
    if (c.dzr_uniq_id) DZR_UNIQ_ID = c.dzr_uniq_id;
    if (c.familyUserId) FAMILY_USER_ID = c.familyUserId;
  } catch {}
}
loadConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ arl: ARL, sid: SID, userId: USER_ID, dzr_uniq_id: DZR_UNIQ_ID, familyUserId: FAMILY_USER_ID }, null, 2));
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
function deezerPublicGet(apiPath) {
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
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from public API')); } });
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
  const trackResults = trackData.results || {};
  const trackToken = trackResults.TRACK_TOKEN;

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
              else reject(new Error('No media URL'));
            } catch { reject(new Error('Invalid CDN response')); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      return { url: streamUrl, premium: true, encrypted: streamUrl.includes('/media/') || streamUrl.includes('/mobile/') };
    } catch (e) {
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
          const { arl } = JSON.parse(body);
          if (!arl) return jsonRes(res, 400, { error: 'Missing arl' });
          if (arl.length !== 192) return jsonRes(res, 400, { error: 'ARL must be 192 characters. Got ' + arl.length });
          ARL = arl;
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
              user: { id: user.USER_ID, name: user.BLOG_NAME || user.USER_NAME }
            });
          } catch (e) {
            ARL = ''; SID = ''; USER_ID = ''; LICENSE_TOKEN = '';
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
    if (pathname === '/api/status') {
      try {
        if (!USER_ID) { const user = await getUser(); USER_ID = user.USER_ID; saveConfig(); }
        jsonRes(res, 200, { arl: true, valid: true, premium: !!LICENSE_TOKEN, user: { id: USER_ID, premium: !!LICENSE_TOKEN } });
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
        const tracksRaw = data.results?.data || data.results || [];
        const tracks = tracksRaw.map(t => ({
          id: t.SNG_ID, title: t.SNG_TITLE || t.TITLE, duration: t.DURATION,
          artist: { id: t.ART_ID, name: t.ART_NAME }, disk_number: t.DISK_NUMBER, track_number: t.TRACK_NUMBER,
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