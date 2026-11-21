import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const publicDir = path.join(__dirname, 'public');

const ADMIN_HTML_KEY =
  process.env.ADMIN_HTML_KEY ||
  'b6a428fdb65cb140edcc60b1930257916ee855e47f5f4b95d40cce378f09b9f4';

const UPSTREAM_RELEASES_API =
  process.env.RELEASES_API_URL ||
  'https://api.github.com/repos/khaledahmed34567/DrWael-Androidapp/releases/latest';

const PLATFORM_EXTS = {
  android: ['.apk'],
  win: ['.exe'],
  mac: ['.dmg'],
  'mac-zip': ['-mac.zip', 'darwin.zip', '.zip'],
  linux: ['.appimage'],
  'linux-deb': ['.deb'],
};

let releaseCache = { at: 0, data: null };

function safeKeyMatch(input, expected) {
  if (typeof input !== 'string' || !input) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function fetchReleaseData() {
  const now = Date.now();
  if (releaseCache.data && now - releaseCache.at < 5 * 60 * 1000) {
    return releaseCache.data;
  }

  const envUrls = {
    android: process.env.DL_ANDROID_URL || '',
    win: process.env.DL_WIN_URL || '',
    mac: process.env.DL_MAC_URL || '',
    'mac-zip': process.env.DL_MAC_ZIP_URL || '',
    linux: process.env.DL_LINUX_URL || '',
    'linux-deb': process.env.DL_LINUX_DEB_URL || '',
  };

  let tag = process.env.APP_VERSION || '1.0.0';
  let notes = '';
  let publishedAt = '';
  let androidSize = 0;
  const resolvedAssets = { ...envUrls };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(UPSTREAM_RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'DrWael-Server/1.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const raw = await resp.json();
      if (raw.tag_name) tag = String(raw.tag_name).replace(/^v/i, '');
      if (raw.body) notes = String(raw.body).trim();
      if (raw.published_at) publishedAt = String(raw.published_at);
      const assets = Array.isArray(raw.assets) ? raw.assets : [];
      for (const [key, exts] of Object.entries(PLATFORM_EXTS)) {
        if (resolvedAssets[key]) continue;
        const match = assets.find((a) => {
          const name = String(a?.name || '').toLowerCase();
          return exts.some((ext) => name.endsWith(ext));
        });
        if (match?.browser_download_url) {
          resolvedAssets[key] = String(match.browser_download_url);
          if (key === 'android' && typeof match.size === 'number') {
            androidSize = match.size;
          }
        }
      }
    }
  } catch {
    // Keep cached or env fallback silently
  }

  const payload = {
    version: tag,
    tag,
    notes,
    publishedAt,
    androidSize,
    androidUrl: '/dl/android',
    winUrl: '/dl/win',
    macUrl: '/dl/mac',
    macZipUrl: '/dl/mac-zip',
    linuxUrl: '/dl/linux',
    linuxDebUrl: '/dl/linux-deb',
    available: {
      android: Boolean(resolvedAssets.android),
      win: Boolean(resolvedAssets.win),
      mac: Boolean(resolvedAssets.mac),
      macZip: Boolean(resolvedAssets['mac-zip']),
      linux: Boolean(resolvedAssets.linux),
      linuxDeb: Boolean(resolvedAssets['linux-deb']),
    },
    _assets: resolvedAssets,
  };

  releaseCache = { at: now, data: payload };
  return payload;
}

// Allow CORS for WebView/app origins accessing release info
app.use('/api', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Block direct /DrWael.html completely
app.all('/DrWael.html', (_req, res) => {
  res.status(404).send('Not Found');
});

// Owner-only secret HTML download route
app.get('/download/html', (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (!safeKeyMatch(key, ADMIN_HTML_KEY)) {
    return res.status(404).send('Not Found');
  }
  const indexPath = path.join(publicDir, 'index.html');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="DrWael.html"');
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(indexPath);
});

// Filtered releases metadata endpoint (strictly without htmlUrl or repo links)
app.get('/api/releases', async (_req, res) => {
  const data = await fetchReleaseData();
  const { _assets, ...publicRelease } = data;
  res.setHeader('Cache-Control', 'public, max-age=120');
  res.json(publicRelease);
});

// Direct platform binary download routes
for (const platform of Object.keys(PLATFORM_EXTS)) {
  app.get(`/dl/${platform}`, async (_req, res) => {
    const data = await fetchReleaseData();
    const targetUrl = data._assets?.[platform];
    if (!targetUrl) {
      return res.status(404).json({ error: 'Release binary not available for this platform' });
    }
    return res.redirect(302, targetUrl);
  });
}

// Admin panel routes
app.get(['/admin', '/admin.html'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.use(express.static(publicDir));

app.use((_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Dr. Wael web server listening on http://${HOST}:${PORT}`);
});
