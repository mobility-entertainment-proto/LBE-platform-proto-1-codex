// server/proxy.js  APIプロキシサーバー
// 起動: node server/proxy.js
// 依存: npm install

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');

const app    = express();
const PORT   = process.env.PORT || 3001;
const TM_KEY = process.env.TICKETMASTER_API_KEY;
const YT_KEY = process.env.YOUTUBE_API_KEY;

app.use(cors());
app.use(express.json());

// ── ヘルスチェック ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ticketmaster: !!TM_KEY && TM_KEY !== 'ここに自分で入力する',
    youtube:      !!YT_KEY && YT_KEY !== 'ここに自分で入力する',
  });
});

// ── GET /api/events?lat=&lng=&radius= ────────────────────────
// Ticketmaster APIを呼び出してイベント一覧を返す
app.get('/api/events', async (req, res) => {
  const { lat, lng, radius = 50 } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }
  if (!TM_KEY || TM_KEY === 'ここに自分で入力する') {
    return res.status(500).json({ error: 'TICKETMASTER_API_KEY is not configured in .env' });
  }

  try {
    const url = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
    url.searchParams.set('apikey',             TM_KEY);
    url.searchParams.set('latlong',            `${lat},${lng}`);
    url.searchParams.set('radius',             radius);
    url.searchParams.set('unit',               'km');
    url.searchParams.set('classificationName', 'music');
    url.searchParams.set('sort',               'date,asc');
    url.searchParams.set('size',               '20');

    const tmRes  = await fetch(url.toString(), { timeout: 8000 });
    const tmData = await tmRes.json();

    const events = (tmData._embedded?.events || [])
      .map(e => {
        const venue = e._embedded?.venues?.[0];
        return {
          id:        e.id,
          name:      e.name,
          venue:     venue?.name || '',
          lat:       parseFloat(venue?.location?.latitude  || 0),
          lng:       parseFloat(venue?.location?.longitude || 0),
          date:      e.dates?.start?.dateTime || e.dates?.start?.localDate || '',
          artist:    e._embedded?.attractions?.[0]?.name || e.name,
          imageUrl:  e.images?.find(i => i.ratio === '3_2')?.url || e.images?.[0]?.url || '',
          ticketUrl: e.url || '',
        };
      })
      .filter(e => e.lat !== 0 && e.lng !== 0);

    res.json(events);
  } catch (err) {
    console.error('[proxy] /api/events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/youtube?artist= ─────────────────────────────────
// YouTube Data API v3でアーティスト名を検索し、MVのvideo_idを返す
app.get('/api/youtube', async (req, res) => {
  const { artist } = req.query;

  if (!artist) {
    return res.status(400).json({ error: 'artist is required' });
  }
  if (!YT_KEY || YT_KEY === 'ここに自分で入力する') {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY is not configured in .env' });
  }

  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('key',        YT_KEY);
    url.searchParams.set('q',          `${artist} official MV`);
    url.searchParams.set('type',       'video');
    url.searchParams.set('part',       'snippet');
    url.searchParams.set('maxResults', '1');
    url.searchParams.set('order',      'relevance');

    const ytRes  = await fetch(url.toString(), { timeout: 8000 });
    const ytData = await ytRes.json();

    const videoId = ytData.items?.[0]?.id?.videoId || null;
    res.json({ videoId, artist });
  } catch (err) {
    console.error('[proxy] /api/youtube error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 起動 ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[proxy] http://localhost:${PORT}`);
  console.log(`  Ticketmaster API: ${TM_KEY && TM_KEY !== 'ここに自分で入力する' ? '✓ 設定済み' : '✗ 未設定 (.envを確認)'}`);
  console.log(`  YouTube API:      ${YT_KEY && YT_KEY !== 'ここに自分で入力する' ? '✓ 設定済み' : '✗ 未設定 (.envを確認)'}`);
});
