// contents/live-map/game.js  ライブマップコンテンツ (ContentBase実装)

const PROXY_URL    = 'http://localhost:3001';
const VENUE_RADIUS = 300;  // 会場ジオフェンス半径(m)
const FETCH_RADIUS = 50;   // Ticketmaster検索半径(km)

// ── モックデータ（プロキシ未起動時のフォールバック）───────────────
const MOCK_EVENTS = [
  {
    id: 'mock_001',
    name: 'Taylor Swift - The Eras Tour Japan',
    venue: '東京ドーム',
    lat: 35.7057, lng: 139.7517,
    date: '2025-08-15T20:00:00',
    artist: 'Taylor Swift',
    imageUrl: '',
    ticketUrl: 'https://www.ticketmaster.com',
  },
  {
    id: 'mock_002',
    name: 'Billie Eilish - Hit Me Hard and Soft Tour',
    venue: '国立代々木競技場',
    lat: 35.6716, lng: 139.6985,
    date: '2025-09-20T19:30:00',
    artist: 'Billie Eilish',
    imageUrl: '',
    ticketUrl: 'https://www.ticketmaster.com',
  },
  {
    id: 'mock_003',
    name: 'Bruno Mars Live in Tokyo',
    venue: '横浜アリーナ',
    lat: 35.5095, lng: 139.6132,
    date: '2025-10-04T21:00:00',
    artist: 'Bruno Mars',
    imageUrl: '',
    ticketUrl: 'https://www.ticketmaster.com',
  },
];

// ── ヘルパー ─────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDate(iso) {
  if (!iso) return '日時未定';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDist(m) {
  return m < 1000 ? `${m.toFixed(0)}m` : `${(m / 1000).toFixed(1)}km`;
}

// ── YouTube IFrame API ローダー（シングルトン）──────────────────
let _ytReady = false, _ytLoading = false, _ytCbs = [];
function loadYTApi() {
  return new Promise(resolve => {
    if (_ytReady) { resolve(); return; }
    _ytCbs.push(resolve);
    if (!_ytLoading) {
      _ytLoading = true;
      window.onYouTubeIframeAPIReady = () => {
        _ytReady = true;
        _ytCbs.forEach(cb => cb());
        _ytCbs = [];
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  });
}

// ── ベニューアイコン SVG ────────────────────────────────────────
function venuePinHTML(color = '#e63946', highlight = false) {
  const c = highlight ? '#ffe566' : color;
  return `<div style="width:32px;height:40px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));">
    <svg width="32" height="40" viewBox="0 0 32 40" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="15" r="14" fill="${c}" stroke="#fff" stroke-width="2"/>
      <path d="M16 40 L5 25 Q16 31 27 25 Z" fill="${c}"/>
      <circle cx="16" cy="15" r="5" fill="#fff"/>
    </svg>
  </div>`;
}

// ────────────────────────────────────────────────────────────────
export class LiveMap {
  constructor(audioManager) {
    this.audio = audioManager;

    // DOM
    this.container    = null;
    this.mapEl        = null;
    this._loadingEl   = null;
    this._infoPanel   = null;
    this._ytContainer = null;

    // Leaflet
    this.map          = null;
    this.userMarker   = null;
    this.venueMarkers = new Map(); // eventId → { marker, event }

    // State
    this.events        = null;    // キャッシュ (null=未取得)
    this.nearbyVenueId = null;

    // YouTube
    this.ytPlayer    = null;
    this._ytVideoId  = null;

    // GPS
    this.watchId     = null;
    this.currentLat  = null;
    this.currentLng  = null;

    // location
    this._location = null;
  }

  // ── ContentBase interface ──────────────────────────────────────

  async onEnter(location) {
    this._location = location;

    // Leaflet CSS/JS をまだ読み込んでいなければ追加
    this._ensureLeaflet();

    // style.css
    if (!document.getElementById('lm-style')) {
      const link = document.createElement('link');
      link.id   = 'lm-style';
      link.rel  = 'stylesheet';
      link.href = './contents/live-map/style.css';
      document.head.appendChild(link);
    }

    this._showLoading(true);

    // Leaflet 読み込みを待つ
    await this._waitForLeaflet();

    // 地図初期化
    this._initMap(location.lat, location.lng);

    // イベント取得（キャッシュ済みなら再取得しない）
    if (!this.events) {
      await this._fetchEvents(location.lat, location.lng);
    }
    this._plotVenues();
    this._showLoading(false);

    // GPS監視開始
    this._startGPS();
  }

  onExit() {
    this._stopGPS();
    this._destroyYT();
    this._hideInfoPanel();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.venueMarkers.clear();
    this.userMarker    = null;
    this.nearbyVenueId = null;
    // events はキャッシュとして保持
  }

  onStart() {}
  onStop()  {}

  getUI() {
    this.container = document.createElement('div');
    this.container.style.cssText = 'position:fixed;inset:0;z-index:10;background:#1a1a2e;';

    // 地図領域
    this.mapEl = document.createElement('div');
    this.mapEl.style.cssText = 'width:100%;height:100%;';
    this.container.appendChild(this.mapEl);

    // ローディング表示
    this._loadingEl = document.createElement('div');
    this._loadingEl.style.cssText = [
      'position:absolute;inset:0;background:rgba(4,4,20,0.88);z-index:40;',
      'display:none;flex-direction:column;align-items:center;justify-content:center;',
      "font-family:'Consolas','Courier New',monospace;color:#66ccff;",
    ].join('');
    this._loadingEl.innerHTML = `
      <div style="font-size:32px;margin-bottom:16px;">📍</div>
      <div style="font-size:15px;letter-spacing:2px;">イベント情報を取得中...</div>
      <div style="font-size:11px;color:#445;margin-top:8px;">proxy server: ${PROXY_URL}</div>
    `;
    this.container.appendChild(this._loadingEl);

    // 会場情報パネル（下部スライドアップ）
    this._infoPanel = document.createElement('div');
    this._infoPanel.style.cssText = [
      'position:absolute;bottom:0;left:0;right:0;z-index:30;',
      'background:rgba(4,4,20,0.96);border-top:2px solid #334;',
      'padding:14px 16px 20px;transform:translateY(100%);',
      "transition:transform .35s ease;font-family:'Consolas','Courier New',monospace;",
    ].join('');
    this.container.appendChild(this._infoPanel);

    // YouTubeプレイヤーコンテナ（右下）
    this._ytContainer = document.createElement('div');
    this._ytContainer.style.cssText = [
      'position:absolute;right:0;z-index:31;',
      'width:min(280px,55vw);aspect-ratio:16/9;',
      'display:none;background:#000;',
    ].join('');
    this.container.appendChild(this._ytContainer);

    return this.container;
  }

  // ── Leaflet ────────────────────────────────────────────────────

  _ensureLeaflet() {
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id   = 'leaflet-css';
      link.rel  = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    if (!window.L && !document.getElementById('leaflet-js')) {
      const s = document.createElement('script');
      s.id  = 'leaflet-js';
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      document.head.appendChild(s);
    }
  }

  _waitForLeaflet() {
    return new Promise(resolve => {
      const check = () => window.L ? resolve() : setTimeout(check, 100);
      check();
    });
  }

  _initMap(lat, lng) {
    const L = window.L;
    if (this.map || !L) return;
    this.map = L.map(this.mapEl, { zoomControl: true }).setView([lat, lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(this.map);
  }

  // ── イベント取得 ────────────────────────────────────────────────

  async _fetchEvents(lat, lng) {
    try {
      // ヘルスチェック
      const health = await Promise.race([
        fetch(`${PROXY_URL}/api/health`).then(r => r.json()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      if (!health.ticketmaster) {
        console.warn('[LiveMap] Ticketmaster key not set → using mock data');
        this.events = MOCK_EVENTS;
        return;
      }
      // 実APIコール
      const res = await Promise.race([
        fetch(`${PROXY_URL}/api/events?lat=${lat}&lng=${lng}&radius=${FETCH_RADIUS}`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      const data = await res.json();
      this.events = Array.isArray(data) && data.length > 0 ? data : MOCK_EVENTS;
    } catch (e) {
      console.warn('[LiveMap] fetch failed → using mock data:', e.message);
      this.events = MOCK_EVENTS;
    }
  }

  // ── ベニュープロット ────────────────────────────────────────────

  _plotVenues() {
    if (!this.map || !this.events) return;
    const L = window.L;
    this.venueMarkers.clear();

    for (const ev of this.events) {
      const icon = L.divIcon({
        className: '',
        html: venuePinHTML(),
        iconSize:   [32, 40],
        iconAnchor: [16, 40],
        popupAnchor:[0, -42],
      });

      const marker = L.marker([ev.lat, ev.lng], { icon }).addTo(this.map);

      // ポップアップ（タップで表示）
      marker.bindPopup(this._buildPopupHTML(ev), { maxWidth: 240 });

      // 距離ツールチップ
      marker.bindTooltip('-- m', {
        permanent:  true,
        direction:  'top',
        offset:     [0, -42],
        className:  'lm-dist-tooltip',
      });

      marker.on('click', () => this._showInfoPanel(ev, this._distTo(ev)));

      this.venueMarkers.set(ev.id, { marker, event: ev });
    }
  }

  _distTo(ev) {
    if (this.currentLat === null) return null;
    return haversine(this.currentLat, this.currentLng, ev.lat, ev.lng);
  }

  // ── GPS ───────────────────────────────────────────────────────

  _startGPS() {
    if (!navigator.geolocation) return;
    this.watchId = navigator.geolocation.watchPosition(
      pos => this._onPosition(pos),
      err => console.warn('[LiveMap] GPS error:', err.message),
      { enableHighAccuracy: true, maximumAge: 3000 }
    );
  }

  _stopGPS() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  _onPosition(pos) {
    const { latitude: lat, longitude: lng } = pos.coords;
    this.currentLat = lat;
    this.currentLng = lng;

    const L = window.L;
    if (this.map && L) {
      const userIcon = L.divIcon({
        className: '',
        html: `<div class="lm-user-dot" style="
          width:18px;height:18px;border-radius:50%;
          background:#4a9eff;border:3px solid #fff;"></div>`,
        iconSize:   [18, 18],
        iconAnchor: [9, 9],
      });
      if (this.userMarker) {
        this.userMarker.setLatLng([lat, lng]);
      } else {
        this.userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 }).addTo(this.map);
        this.map.setView([lat, lng], 14);
      }
    }

    // 各会場との距離を計算・ツールチップ更新
    let nearestId   = null;
    let nearestDist = Infinity;

    for (const [id, { marker, event }] of this.venueMarkers) {
      const dist = haversine(lat, lng, event.lat, event.lng);
      if (dist < nearestDist) { nearestDist = dist; nearestId = id; }
      marker.setTooltipContent(fmtDist(dist));

      // 接近中ピンをハイライト
      const near = dist <= VENUE_RADIUS;
      const L = window.L;
      if (L) {
        marker.setIcon(L.divIcon({
          className: '',
          html: venuePinHTML('#e63946', near),
          iconSize:   [32, 40],
          iconAnchor: [16, 40],
          popupAnchor:[0, -42],
        }));
      }
    }

    // 接近/離脱の判定
    if (nearestId && nearestDist <= VENUE_RADIUS) {
      if (this.nearbyVenueId !== nearestId) {
        this.nearbyVenueId = nearestId;
        const { event } = this.venueMarkers.get(nearestId);
        this._showInfoPanel(event, nearestDist);
        this._playYT(event.artist);
      } else {
        // 距離だけ更新
        this._updateInfoDist(nearestDist);
      }
    } else {
      if (this.nearbyVenueId !== null) {
        this.nearbyVenueId = null;
        this._hideInfoPanel();
        this._stopYT();
      }
    }
  }

  // ── 情報パネル ─────────────────────────────────────────────────

  _showInfoPanel(event, dist) {
    const distStr = dist !== null ? ` — <span style="color:#66ccff;">${fmtDist(dist)}</span> 先` : '';
    this._infoPanel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:10px;color:#f44;letter-spacing:2px;margin-bottom:5px;">
            🎵 LIVE EVENT${dist !== null && dist <= VENUE_RADIUS ? ' — 接近中！' : ''}
          </div>
          <div style="font-size:clamp(14px,4vw,19px);font-weight:bold;color:#fff;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${event.artist}</div>
          <div style="font-size:12px;color:#aab;margin-top:2px;">📍 ${event.venue}</div>
          <div style="font-size:12px;color:#667;margin-top:2px;" id="lm-dist-label">
            🗓 ${fmtDate(event.date)}${distStr}
          </div>
        </div>
        <a href="${event.ticketUrl}" target="_blank" class="lm-ticket-btn"
          style="padding:10px 14px;background:#e63946;border-radius:8px;color:#fff;
            font-size:12px;font-weight:bold;text-decoration:none;white-space:nowrap;
            touch-action:manipulation;">
          チケット<br>購入
        </a>
      </div>
      ${event.name !== event.artist
        ? `<div style="font-size:10px;color:#445;margin-top:6px;">${event.name}</div>`
        : ''}
    `;
    this._infoPanel.style.transform = 'translateY(0)';

    // YouTubeコンテナをパネルの上に配置
    requestAnimationFrame(() => {
      const h = this._infoPanel.offsetHeight;
      if (this._ytContainer) this._ytContainer.style.bottom = (h + 4) + 'px';
    });
  }

  _updateInfoDist(dist) {
    const el = this._infoPanel.querySelector('#lm-dist-label');
    if (el && dist !== null) {
      const nearbyEv = this.venueMarkers.get(this.nearbyVenueId)?.event;
      if (nearbyEv) {
        el.innerHTML = `🗓 ${fmtDate(nearbyEv.date)} — <span style="color:#66ccff;">${fmtDist(dist)}</span> 先`;
      }
    }
  }

  _hideInfoPanel() {
    this._infoPanel.style.transform = 'translateY(100%)';
  }

  _buildPopupHTML(event) {
    return `
      <div style="font-family:'Consolas','Courier New',monospace;min-width:170px;line-height:1.5;">
        <div style="font-weight:bold;color:#111;margin-bottom:3px;">${event.artist}</div>
        <div style="font-size:12px;color:#555;">📍 ${event.venue}</div>
        <div style="font-size:11px;color:#888;margin-top:3px;">🗓 ${fmtDate(event.date)}</div>
        <div style="margin-top:8px;">
          <a href="${event.ticketUrl}" target="_blank"
            style="color:#e63946;font-size:12px;font-weight:bold;text-decoration:none;">
            チケット購入 →
          </a>
        </div>
      </div>
    `;
  }

  // ── YouTube ───────────────────────────────────────────────────

  async _playYT(artist) {
    try {
      const health = await fetch(`${PROXY_URL}/api/health`).then(r => r.json()).catch(() => ({}));
      if (!health.youtube) {
        console.warn('[LiveMap] YouTube key not set → skip');
        return;
      }
      const url = `${PROXY_URL}/api/youtube?artist=${encodeURIComponent(artist)}`;
      const res = await Promise.race([
        fetch(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
      const { videoId } = await res.json();
      if (videoId) await this._createYTPlayer(videoId);
    } catch (e) {
      console.warn('[LiveMap] YouTube play failed:', e.message);
    }
  }

  async _createYTPlayer(videoId) {
    if (this._ytVideoId === videoId && this.ytPlayer) return;
    this._ytVideoId = videoId;

    await loadYTApi();

    // 古いプレイヤーを破棄して新しいdivを作成
    if (this.ytPlayer) {
      try { this.ytPlayer.destroy(); } catch (e) {}
      this.ytPlayer = null;
    }
    this._ytContainer.innerHTML = '';
    const el = document.createElement('div');
    this._ytContainer.appendChild(el);

    this.ytPlayer = new window.YT.Player(el, {
      videoId,
      width:  '100%',
      height: '100%',
      playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1 },
      events: {
        onReady: e => e.target.playVideo(),
      },
    });
    this._ytContainer.style.display = 'block';
  }

  _stopYT() {
    if (this.ytPlayer) {
      try { this.ytPlayer.stopVideo(); } catch (e) {}
    }
    this._ytContainer.style.display = 'none';
  }

  _destroyYT() {
    if (this.ytPlayer) {
      try { this.ytPlayer.destroy(); } catch (e) {}
      this.ytPlayer  = null;
    }
    this._ytVideoId = null;
    if (this._ytContainer) {
      this._ytContainer.innerHTML = '';
      this._ytContainer.style.display = 'none';
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  _showLoading(show) {
    if (this._loadingEl) this._loadingEl.style.display = show ? 'flex' : 'none';
  }
}
