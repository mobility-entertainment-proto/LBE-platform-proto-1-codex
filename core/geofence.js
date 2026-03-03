// core/geofence.js  ジオフェンスエンジン

import { LocationManager } from './location.js';

export class GeofenceEngine {
  constructor(locations, contentRegistry) {
    this.locations = locations;
    this.contentRegistry = contentRegistry;
    this.locationManager = new LocationManager();
    this.activeLocationId = null;
    this.debugMode = false;
    this.onStatusUpdate = null;
  }

  start(onStatusUpdate) {
    this.onStatusUpdate = onStatusUpdate;
    this.locationManager.start(
      pos => this._onGpsUpdate(pos),
      err => this._notify({ msg: `GPS エラー: ${err}`, dist: Infinity, nearestLoc: null })
    );
  }

  stop() {
    this.locationManager.stop();
  }

  // デバッグ: 任意のlocation_idを強制起動
  debugForce(locationId) {
    this.debugMode = true; // GPS判定を無効化
    const loc = this.locations.find(l => l.id === locationId);
    if (!loc) return;
    if (this.activeLocationId && this.activeLocationId !== locationId) {
      this._exit(this.locations.find(l => l.id === this.activeLocationId));
    }
    this._enter(loc);
  }

  debugExit() {
    this.debugMode = false; // GPS判定を再有効化
    if (!this.activeLocationId) return;
    const loc = this.locations.find(l => l.id === this.activeLocationId);
    if (loc) this._exit(loc);
  }

  _onGpsUpdate(pos) {
    const { latitude: lat, longitude: lng } = pos.coords;
    let nearestLoc = null;
    let nearestDist = Infinity;

    for (const loc of this.locations) {
      const rawDist = LocationManager.haversine(lat, lng, loc.lat, loc.lng);
      const edgeDist = Math.max(0, rawDist - loc.radius);
      if (edgeDist < nearestDist) { nearestDist = edgeDist; nearestLoc = loc; }

      // デバッグモード中はGPSによるenter/exit判定をスキップ
      if (!this.debugMode) {
        const inside = rawDist <= loc.radius;
        const isActive = this.activeLocationId === loc.id;
        if (inside && !isActive) {
          if (this.activeLocationId) this._exit(this.locations.find(l => l.id === this.activeLocationId));
          this._enter(loc);
        } else if (!inside && isActive) {
          this._exit(loc);
        }
      }
    }

    const prefix = this.debugMode ? '[DEBUG] ' : '';
    const msg = nearestLoc
      ? (nearestDist < 1 ? `${nearestLoc.name} 内` : `${nearestLoc.name} まで ${nearestDist.toFixed(0)}m`)
      : '位置情報を取得中...';
    this._notify({ msg: prefix + msg, dist: nearestDist, nearestLoc });
  }

  _enter(loc) {
    this.activeLocationId = loc.id;
    const content = this.contentRegistry[loc.content];
    if (content) content.onEnter(loc);
  }

  _exit(loc) {
    if (!loc) return;
    const content = this.contentRegistry[loc.content];
    if (content) content.onExit(loc);
    if (this.activeLocationId === loc.id) this.activeLocationId = null;
  }

  _notify(data) {
    if (this.onStatusUpdate) this.onStatusUpdate(data);
  }
}
