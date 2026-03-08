/**
 * RescuAR - 店舗×QR AR フロントエンド
 * jsQR でQR検出 → 座標変換 → Canvas 2D でARオーバーレイ描画
 */
(function() {
  'use strict';

  // --- Constants & DOM ---
  const videoEl = document.getElementById('videoEl');
  const detectCanvas = document.getElementById('detectCanvas');
  const detectCtx = detectCanvas.getContext('2d');
  const cameraCanvas = document.getElementById('cameraCanvas');
  const cameraCtx = cameraCanvas.getContext('2d');
  const overlayCanvas = document.getElementById('overlayCanvas');
  const overlayCtx = overlayCanvas.getContext('2d');
  const loadingEl = document.getElementById('loading');

  const DETECT_WIDTH = 640;
  const LERP_OLD = 0.7;
  const LERP_NEW = 0.25;
  const AR_TIMEOUT_MS = 2000;
  /** バックエンドAPI */
  const API_BASE = 'https://gerbera-backend-jb9g.onrender.com/api/items';
  const EXPIRY_UPDATE_INTERVAL_MS = 1000;

  /** 1x1透明PNG（プレースホルダー）。実画像は frontend/assets/ に置いてパスを差し替え可 */
  const PLACEHOLDER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  var _assetBase = (function() { return window.location.href.replace(/[^/]+$/, ''); })();
  var _img = function(name) { return _assetBase + 'images/' + name; };
  const ASSET_URLS = {
    hotAura: PLACEHOLDER_PNG,
    cryingFace: _assetBase + 'images/icon_cry.png',
    syutyusen1: _assetBase + 'images/syutyusen-1.png',
    syutyusen2: _assetBase + 'images/syutyusen-2.png',
    ghost_move_right_1: _img('move_right-1.png'),
    ghost_move_right_2: _img('move_right-2.png'),
    ghost_move_left_1: _img('move_left-1.png'),
    ghost_move_left_2: _img('move_left-2.png'),
    ghost_move_up_1: _img('move_up-1.png'),
    ghost_move_up_2: _img('move_up-2.png'),
    ghost_move_down_1: _img('move_down-1.png'),
    ghost_move_down_2: _img('move_down-2.png'),
    ghost_wave_1: _img('wave-1.png'),
    ghost_wave_2: _img('wave-2.png')
  };
  /** プリロード済み画像。drawSingleARTag で参照。毎フレーム new Image() 禁止。 */
  const arAssets = {
    hotAura: null, cryingFace: null, syutyusen1: null, syutyusen2: null,
    ghost_move_right_1: null, ghost_move_right_2: null, ghost_move_left_1: null, ghost_move_left_2: null,
    ghost_move_up_1: null, ghost_move_up_2: null, ghost_move_down_1: null, ghost_move_down_2: null,
    ghost_wave_1: null, ghost_wave_2: null
  };

  // --- Coordinate Logic ---
  let viewW = 0, viewH = 0;
  let detectW = 0, detectH = 0;
  let scaleX = 1, scaleY = 1;
  let offsetX = 0, offsetY = 0;

  function updateCoordinateTransform() {
    viewW = overlayCanvas.clientWidth;
    viewH = overlayCanvas.clientHeight;
    if (viewW <= 0 || viewH <= 0) return;

    const viewAspect = viewW / viewH;
    detectW = DETECT_WIDTH;
    detectH = Math.round(DETECT_WIDTH / viewAspect);

    detectCanvas.width = detectW;
    detectCanvas.height = detectH;
    cameraCanvas.width = viewW;
    cameraCanvas.height = viewH;
    overlayCanvas.width = viewW;
    overlayCanvas.height = viewH;

    scaleX = viewW / detectW;
    scaleY = viewH / detectH;
    offsetX = 0;
    offsetY = 0;
  }

  function detectToScreen(detectX, detectY) {
    return {
      x: detectX * scaleX + offsetX,
      y: detectY * scaleY + offsetY
    };
  }

  function getQRCenterAndAngle(location) {
    const tl = location.topLeftCorner;
    const tr = location.topRightCorner;
    const br = location.bottomRightCorner;
    const bl = location.bottomLeftCorner;
    const cx = (tl.x + tr.x + br.x + bl.x) / 4;
    const cy = (tl.y + tr.y + br.y + bl.y) / 4;
    const angle = Math.atan2(tr.y - tl.y, tr.x - tl.x);
    return { cx, cy, angle };
  }

  function lerp(a, b, t) {
    return a * (1 - t) + b * t;
  }

  // --- State (multi-QR tracking & quad scan) ---
  const activeProducts = new Map();
  let lastExpiryUpdateTime = 0;
  let frameCount = 0;

  // --- API Logic ---
  function getRemainingMinutes(expiryTimeIso) {
    if (!expiryTimeIso || typeof expiryTimeIso !== 'string') return null;
    const expiryMs = new Date(expiryTimeIso).getTime();
    if (isNaN(expiryMs)) return null;
    const remainingMs = expiryMs - Date.now();
    return Math.floor(remainingMs / (60 * 1000));
  }

  async function fetchProductInfo(qrData) {
    const url = API_BASE + '/' + encodeURIComponent(qrData);
    const res = await fetch(url);
    if (!res.ok) {
      return { name: '取得失敗' };
    }
    const data = await res.json();
    return data;
  }

  // --- Video / Canvas (camera feed) ---
  function drawVideoToDetectCanvas() {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (vw <= 0 || vh <= 0) return;

    const videoAspect = vw / vh;
    const detectAspect = detectW / detectH;
    let sx = 0, sy = 0, sw = vw, sh = vh;

    if (detectAspect > videoAspect) {
      sh = vw / detectAspect;
      sy = (vh - sh) / 2;
    } else {
      sw = vh * detectAspect;
      sx = (vw - sw) / 2;
    }
    detectCtx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, detectW, detectH);
  }

  function drawVideoToCameraCanvas() {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (viewW <= 0 || viewH <= 0 || vw <= 0 || vh <= 0) return;

    const videoAspect = vw / vh;
    const viewAspect = viewW / viewH;
    let sx = 0, sy = 0, sw = vw, sh = vh;

    if (viewAspect > videoAspect) {
      sh = vw / viewAspect;
      sy = (vh - sh) / 2;
    } else {
      sw = vh * viewAspect;
      sx = (vw - sw) / 2;
    }
    cameraCtx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, viewW, viewH);
  }

  // --- AR Drawing（スーパー値札・割引シール風・円形シール） ---
  /** QRを覆う白い値札。中心に重なる（大きめサイズ） */
  const TAG_OFFSET_Y = 0;
  const TAG_WIDTH = 200;
  const TAG_HEIGHT = 108;
  /** 集中線画像の表示サイズ（タグ基準の倍率）。大きくするなら 1.5〜2、小さくするなら 0.8 など */
  const SYUTYUSEN_SIZE_RATIO = 1.2;
  /** おばけAR: 表示サイズ(px)、追従速度・徘徊速度(px/フレーム)、到達判定(px)、タグ横オフセット(px)、パタパタ間隔(ms) */
  const GHOST_SIZE = 56;
  const GHOST_SPEED_TRACKING = 2.0;
  const GHOST_SPEED_WANDERING = 0.8;
  const GHOST_REACH_DIST = 22;
  const GHOST_TAG_OFFSET = 85;
  const GHOST_FLIP_MS = 250;
  const GHOST_WANDER_MARGIN = 40;
  const GHOST_WANDER_WAIT_MS = 2500;
  /** 永続おばけの状態（1体のみ、wandering / tracking / waving） */
  const ghost = {
    screenX: 0, screenY: 0, state: 'wandering',
    targetX: 0, targetY: 0, reachedAt: null,
    trackingEntryId: null, targetSide: null,
    dir: 'down', spawned: false
  };

  /**
   * 円形を描画。中心(x,y)、半径radius、塗りfillColor、枠strokeColor、枠太さstrokeWidth。
   */
  function drawCircle(ctx, x, y, radius, fillColor, strokeColor, strokeWidth) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    if (strokeColor && strokeWidth > 0) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  /** 角丸長方形のパス（タグ本体・影用）。x,yは左上、w,h、半径r */
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** 賞味期限バーの基準時間（分）。12時間 = この値以上でバーMAX。 */
  const EXPIRY_BAR_BASE_MINUTES = 12 * 60;

  /**
   * 賞味期限ゲージ（細長い棒バー）。val/max で塗り幅、timeRatio で色（1=緑→0=赤、黄・オレンジを挟む）。
   */
  function drawHealthBar(ctx, x, y, width, height, val, max, timeRatio) {
    const radius = Math.max(1, Math.min(height / 2, 4));
    let color = '#22c55e';
    if (typeof timeRatio === 'number') {
      if (timeRatio >= 2 / 3) color = '#22c55e';
      else if (timeRatio >= 1 / 3) color = '#eab308';
      else if (timeRatio >= 1 / 12) color = '#f97316';
      else color = '#ef4444';
    } else if (max > 0) {
      const ratio = val / max;
      if (ratio <= 1 / 5) color = '#ef4444';
      else if (ratio <= 3 / 5) color = '#eab308';
      else color = '#22c55e';
    }
    const fillRatio = max > 0 ? Math.min(1, val / max) : 0;
    const fillW = Math.max(0, width * fillRatio);
    ctx.fillStyle = '#e5e7eb';
    roundRectPath(ctx, x, y, width, height, radius);
    ctx.fill();
    if (fillW > 0) {
      ctx.fillStyle = color;
      roundRectPath(ctx, x, y, fillW, height, radius);
      ctx.fill();
    }
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, width, height, radius);
    ctx.stroke();
  }

  /** 吹き出し（角丸四角＋三角形のしっぽ）。左上(x,y)、幅w、高さh */
  function drawSpeechBubble(ctx, x, y, w, h, tailSize) {
    const r = 5;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + w / 2 + 6, y + h);
    ctx.lineTo(x + w / 2, y + h + tailSize);
    ctx.lineTo(x + w / 2 - 6, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawSingleARTag(entry) {
    const { smoothedCorners, smoothedCenterX, smoothedCenterY, smoothedAngle, productInfo, remainingMinutes } = entry;
    const centerX = smoothedCenterX;
    const centerY = smoothedCenterY;
    const angle = smoothedAngle;

    if (smoothedCorners) {
      const { tl, tr, br, bl } = smoothedCorners;
      overlayCtx.strokeStyle = '#e11d48';
      overlayCtx.lineWidth = 2;
      overlayCtx.beginPath();
      overlayCtx.moveTo(tl.x, tl.y);
      overlayCtx.lineTo(tr.x, tr.y);
      overlayCtx.lineTo(br.x, br.y);
      overlayCtx.lineTo(bl.x, bl.y);
      overlayCtx.closePath();
      overlayCtx.stroke();
    }

    overlayCtx.save();
    overlayCtx.translate(centerX, centerY + TAG_OFFSET_Y);
    overlayCtx.rotate(angle);
    overlayCtx.translate(-TAG_WIDTH / 2, -TAG_HEIGHT / 2);

    const isUrgentTime = remainingMinutes !== null && remainingMinutes < 180;
    const isVeryUrgentTime = remainingMinutes !== null && remainingMinutes < 60;
    const lowStock = productInfo && productInfo.stock !== undefined && productInfo.stock <= 3;
    const discountRate = (productInfo && productInfo.discount_rate != null) ? Math.round(productInfo.discount_rate) : 0;
    const hasDiscount = discountRate > 0;
    const originalPrice = productInfo && productInfo.original_price != null ? productInfo.original_price : null;
    const currentPrice = (productInfo && (productInfo.current_price != null || productInfo.original_price != null))
      ? (productInfo.current_price != null ? productInfo.current_price : productInfo.original_price)
      : null;

    const tagR = 12;
    const shadowOffset = 4;
    const tagCx = TAG_WIDTH / 2;
    const tagCy = TAG_HEIGHT / 2;

    // ----- 0. オーラ（値札タグの背面）。画像用意後にコメント解除し、ASSET_URLS で hotAura を読み込む -----
    /*
    overlayCtx.save();
    overlayCtx.globalAlpha = 0.5;
    if (arAssets.hotAura && arAssets.hotAura.complete && arAssets.hotAura.naturalWidth > 1) {
      const auraSize = Math.max(TAG_WIDTH, TAG_HEIGHT) * 1.4;
      overlayCtx.drawImage(arAssets.hotAura, tagCx - auraSize / 2, tagCy - auraSize / 2, auraSize, auraSize);
    } else {
      const r = Math.max(TAG_WIDTH, TAG_HEIGHT) * 0.7;
      const g = overlayCtx.createRadialGradient(tagCx, tagCy, 0, tagCx, tagCy, r);
      g.addColorStop(0, 'rgba(251,146,60,0.5)');
      g.addColorStop(0.5, 'rgba(249,115,22,0.2)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      overlayCtx.fillStyle = g;
      overlayCtx.fillRect(tagCx - r, tagCy - r, r * 2, r * 2);
    }
    overlayCtx.restore();
    */

    // ----- 0b. 割引50%以上：集中線をタグ背面に（文字と被らないよう土台の手前に描画） -----
    if (discountRate >= 50) {
      const cx = TAG_WIDTH / 2;
      const cy = TAG_HEIGHT / 2;
      const rayCount = 24;
      overlayCtx.save();
      overlayCtx.globalAlpha = 0.12;
      overlayCtx.strokeStyle = '#dc2626';
      overlayCtx.lineWidth = 1;
      for (let i = 0; i < rayCount; i++) {
        const a = (i / rayCount) * Math.PI * 2;
        const len = Math.max(TAG_WIDTH, TAG_HEIGHT) * 0.7;
        overlayCtx.beginPath();
        overlayCtx.moveTo(cx, cy);
        overlayCtx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        overlayCtx.stroke();
      }
      overlayCtx.restore();
    }

    // ----- 0c. 消費期限残り1時間未満：集中線画像をタグ背面に1秒ごと点滅 -----
    if (isVeryUrgentTime) {
      const syutyusenImg = (Math.floor(performance.now() / 1000) % 2 === 0 ? arAssets.syutyusen1 : arAssets.syutyusen2);
      if (syutyusenImg && syutyusenImg.complete && syutyusenImg.naturalWidth > 0) {
        const cx = TAG_WIDTH / 2;
        const cy = TAG_HEIGHT / 2;
        const size = Math.max(TAG_WIDTH, TAG_HEIGHT) * SYUTYUSEN_SIZE_RATIO;
        overlayCtx.save();
        overlayCtx.globalAlpha = 0.9;
        overlayCtx.drawImage(syutyusenImg, cx - size / 2, cy - size / 2, size, size);
        overlayCtx.restore();
      }
    }

    // ----- 1. 立体感：ドロップシャドウ（タグの右下にずらした半透明の黒） -----
    roundRectPath(overlayCtx, shadowOffset, shadowOffset, TAG_WIDTH, TAG_HEIGHT, tagR);
    overlayCtx.fillStyle = 'rgba(0,0,0,0.25)';
    overlayCtx.fill();

    // ----- 2. 土台：タグ本体（角丸・グラデで立体感・上左にハイライト） -----
    roundRectPath(overlayCtx, 0, 0, TAG_WIDTH, TAG_HEIGHT, tagR);
    const tagGrad = overlayCtx.createLinearGradient(0, 0, TAG_WIDTH, TAG_HEIGHT);
    tagGrad.addColorStop(0, '#ffffff');
    tagGrad.addColorStop(0.4, '#fafafa');
    tagGrad.addColorStop(1, '#f0f0f0');
    overlayCtx.fillStyle = tagGrad;
    overlayCtx.fill();
    overlayCtx.strokeStyle = '#e5e7eb';
    overlayCtx.lineWidth = 1;
    overlayCtx.stroke();
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.8)';
    overlayCtx.lineWidth = 1.2;
    overlayCtx.beginPath();
    overlayCtx.moveTo(tagR, 0);
    overlayCtx.lineTo(TAG_WIDTH - tagR, 0);
    overlayCtx.moveTo(0, tagR);
    overlayCtx.lineTo(0, TAG_HEIGHT - tagR);
    overlayCtx.stroke();

    // ----- 3. 上部：商品名（黒・ゴシック）。価格・シールと重ならないよう左寄せ -----
    overlayCtx.fillStyle = '#000000';
    overlayCtx.font = 'bold 14px sans-serif';
    overlayCtx.textAlign = 'left';
    const nameText = (!productInfo || !productInfo.name)
      ? '読み込み中...'
      : (productInfo.name === '取得失敗' ? '取得失敗' : (productInfo.name.length > 14 ? productInfo.name.slice(0, 13) + '…' : productInfo.name));
    overlayCtx.fillText(nameText, 12, 24);

    // ----- 3. 中央：価格表示（期限切れ時はメッセージ、通常時は価格） -----
    const priceY = 72;
    const priceCenterX = TAG_WIDTH / 2;
    const priceBaseline = priceY + 10;
    const isExpired = productInfo && productInfo.status === 'expired';

    if (isExpired) {
      const line1 = '【期限切れ】';
      const line2 = '店員にお知らせください。';
      const lineHeight = 18;
      const centerY = TAG_HEIGHT / 2;
      overlayCtx.fillStyle = '#dc2626';
      overlayCtx.font = 'bold 14px sans-serif';
      overlayCtx.textAlign = 'center';
      overlayCtx.fillText(line1, priceCenterX, centerY - lineHeight / 2 + 4);
      overlayCtx.fillText(line2, priceCenterX, centerY + lineHeight / 2 + 4);
    } else {
    overlayCtx.font = 'bold 32px sans-serif';
    const priceStrForMeasure = currentPrice != null ? String(currentPrice) : '---';
    const priceW = overlayCtx.measureText(priceStrForMeasure).width;
    overlayCtx.font = '12px sans-serif';
    const yenW = overlayCtx.measureText('円').width;
    const gap = 8;

    if (hasDiscount && originalPrice != null && currentPrice != null) {
      const origStr = String(originalPrice);
      overlayCtx.font = '16px sans-serif';
      const origW = overlayCtx.measureText(origStr).width;
      const totalPriceW = origW + gap + priceW + 6 + yenW;
      const startX = priceCenterX - totalPriceW / 2;
      overlayCtx.fillStyle = '#6b7280';
      overlayCtx.textAlign = 'left';
      overlayCtx.fillText(origStr, startX, priceBaseline);
      overlayCtx.strokeStyle = '#ef4444';
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.moveTo(startX, priceBaseline);
      overlayCtx.lineTo(startX + origW, priceBaseline);
      overlayCtx.stroke();
      overlayCtx.fillStyle = '#000000';
      overlayCtx.font = 'bold 32px sans-serif';
      overlayCtx.fillText(String(currentPrice), startX + origW + gap, priceBaseline);
      overlayCtx.font = '12px sans-serif';
      overlayCtx.fillStyle = '#374151';
      overlayCtx.fillText('円', startX + origW + gap + priceW + 6, priceY + 4);
    } else {
      const totalPriceW = priceW + 6 + yenW;
      const startX = priceCenterX - totalPriceW / 2;
      overlayCtx.fillStyle = '#000000';
      overlayCtx.font = 'bold 32px sans-serif';
      overlayCtx.textAlign = 'left';
      overlayCtx.fillText(priceStrForMeasure, startX, priceBaseline);
      overlayCtx.font = '12px sans-serif';
      overlayCtx.fillStyle = '#374151';
      overlayCtx.fillText('円', startX + priceW + 6, priceY + 4);
    }
    }

    // ----- 4. 割引シール（赤枠・黄地・SALE/XX円引き・長方形からはみ出て右上に配置） -----
    if (hasDiscount) {
      const sealCx = TAG_WIDTH - 8;
      const sealCy = 22;
      const sealR = 34;
      const sealTilt = (entry.id ? (entry.id.charCodeAt(0) % 7 - 3) : 2) * (Math.PI / 180);
      overlayCtx.save();
      overlayCtx.translate(sealCx, sealCy);
      overlayCtx.rotate(sealTilt);
      overlayCtx.translate(-sealCx, -sealCy);
      overlayCtx.shadowColor = 'rgba(0,0,0,0.35)';
      overlayCtx.shadowBlur = 6;
      overlayCtx.shadowOffsetX = 2;
      overlayCtx.shadowOffsetY = 2;
      drawCircle(overlayCtx, sealCx, sealCy, sealR, '#dc2626', '#b91c1c', 2);
      overlayCtx.restore();
      overlayCtx.save();
      overlayCtx.translate(sealCx, sealCy);
      overlayCtx.rotate(sealTilt);
      overlayCtx.translate(-sealCx, -sealCy);
      const innerR = sealR - 4;
      const sealInnerGrad = overlayCtx.createLinearGradient(sealCx - innerR, sealCy - innerR, sealCx + innerR, sealCy + innerR);
      sealInnerGrad.addColorStop(0, '#fef9c3');
      sealInnerGrad.addColorStop(1, '#fef08a');
      overlayCtx.beginPath();
      overlayCtx.arc(sealCx, sealCy, innerR, 0, Math.PI * 2);
      overlayCtx.fillStyle = sealInnerGrad;
      overlayCtx.fill();
      overlayCtx.strokeStyle = '#dc2626';
      overlayCtx.lineWidth = 1;
      overlayCtx.stroke();
      const discountYen = (originalPrice != null && currentPrice != null) ? (originalPrice - currentPrice) : 0;
      const discountLabel = discountYen > 0 ? discountYen + '円引き' : (discountRate >= 1 ? discountRate + '%値引き' : 'SALE');
      overlayCtx.fillStyle = '#dc2626';
      overlayCtx.font = 'bold 13px sans-serif';
      let labelW = overlayCtx.measureText(discountLabel).width;
      if (labelW > innerR * 1.7) {
        overlayCtx.font = 'bold 11px sans-serif';
      }
      overlayCtx.textAlign = 'center';
      overlayCtx.fillText(discountLabel, sealCx, sealCy + 5);
      overlayCtx.restore();
    }

    // ----- 5. 賞味期限バー（12時間基準・線形減少・緑→黄→オレンジ→赤） -----
    if (productInfo) {
      const barY = TAG_HEIGHT - 16;
      const barW = 60;
      const barH = 10;
      overlayCtx.fillStyle = '#000000';
      overlayCtx.font = 'bold 10px sans-serif';
      overlayCtx.textAlign = 'left';
      overlayCtx.fillText('賞味期限', 12, barY + 8);
      const labelW = overlayCtx.measureText('賞味期限').width;
      const baseMin = EXPIRY_BAR_BASE_MINUTES;
      const minutes = remainingMinutes !== null ? remainingMinutes : 0;
      const timeRatio = Math.min(minutes / baseMin, 1);
      const barVal = timeRatio * 5;
      drawHealthBar(overlayCtx, 12 + labelW + 6, barY, barW, barH, barVal, 5, timeRatio);
    }

    // ----- 6. 在庫わずか：吹き出し「残りN点！」 -----
    if (lowStock && productInfo) {
      const bubbleX = TAG_WIDTH / 2 - 40;
      const bubbleY = -28;
      const bubbleW = 80;
      const bubbleH = 24;
      overlayCtx.fillStyle = '#ffffff';
      overlayCtx.strokeStyle = '#94a3b8';
      overlayCtx.lineWidth = 1;
      drawSpeechBubble(overlayCtx, bubbleX, bubbleY, bubbleW, bubbleH, 6);
      overlayCtx.fill();
      overlayCtx.stroke();
      overlayCtx.fillStyle = '#dc2626';
      overlayCtx.font = 'bold 12px sans-serif';
      overlayCtx.textAlign = 'center';
      overlayCtx.fillText('残り' + productInfo.stock + '点！', bubbleX + bubbleW / 2, bubbleY + bubbleH / 2 + 5);
    }

    // ----- 7. 期限間近：感情アイコン（PNG）を値札の左上に縦方向ふわふわで表示 -----
    if (isUrgentTime) {
      const floatY = Math.sin(performance.now() / 400) * 6;
      const faceX = -20;
      const faceY = -20 + floatY;
      if (arAssets.cryingFace && arAssets.cryingFace.complete && arAssets.cryingFace.naturalWidth > 0) {
        const faceSize = 64;
        overlayCtx.drawImage(arAssets.cryingFace, faceX - faceSize / 2, faceY - faceSize / 2, faceSize, faceSize);
      } else {
        overlayCtx.font = '22px sans-serif';
        overlayCtx.textAlign = 'center';
        overlayCtx.fillStyle = '#1f2937';
        overlayCtx.fillText('😢', faceX, faceY + 8);
      }
    }

    overlayCtx.restore();
  }

  function getGhostMoveDir(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  function updateGhost() {
    if (!ghost.spawned) {
      ghost.screenX = viewW / 2;
      ghost.screenY = viewH;
      ghost.state = 'wandering';
      ghost.targetX = GHOST_WANDER_MARGIN + Math.random() * (viewW - 2 * GHOST_WANDER_MARGIN);
      ghost.targetY = GHOST_WANDER_MARGIN + Math.random() * (viewH - 2 * GHOST_WANDER_MARGIN);
      ghost.spawned = true;
    }
    var urgentEntry = null;
    for (var e of activeProducts.values()) {
      if (e.remainingMinutes != null && e.remainingMinutes < 60) { urgentEntry = e; break; }
    }
    var gx = ghost.screenX;
    var gy = ghost.screenY;
    var now = performance.now();
    var half = GHOST_SIZE / 2;
    var minX = half;
    var maxX = Math.max(minX, viewW - half);
    var minY = half;
    var maxY = Math.max(minY, viewH - half);

    if (!urgentEntry) {
      if (ghost.state === 'tracking' || ghost.state === 'waving') {
        ghost.state = 'wandering';
        ghost.targetX = GHOST_WANDER_MARGIN + Math.random() * (viewW - 2 * GHOST_WANDER_MARGIN);
        ghost.targetY = GHOST_WANDER_MARGIN + Math.random() * (viewH - 2 * GHOST_WANDER_MARGIN);
        ghost.reachedAt = null;
        ghost.trackingEntryId = null;
        ghost.targetSide = null;
      }
      if (ghost.state === 'wandering') {
        if (ghost.reachedAt != null) {
          if (now - ghost.reachedAt >= GHOST_WANDER_WAIT_MS) {
            ghost.targetX = GHOST_WANDER_MARGIN + Math.random() * (viewW - 2 * GHOST_WANDER_MARGIN);
            ghost.targetY = GHOST_WANDER_MARGIN + Math.random() * (viewH - 2 * GHOST_WANDER_MARGIN);
            ghost.reachedAt = null;
          }
        } else {
          var dx = ghost.targetX - gx;
          var dy = ghost.targetY - gy;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < GHOST_REACH_DIST) {
            ghost.reachedAt = now;
          } else if (dist > 0) {
            ghost.screenX = gx + (dx / dist) * GHOST_SPEED_WANDERING;
            ghost.screenY = gy + (dy / dist) * GHOST_SPEED_WANDERING;
            ghost.dir = getGhostMoveDir(dx, dy);
          }
        }
      }
    } else {
      var tagCenterX = urgentEntry.smoothedCenterX;
      var tagCenterY = urgentEntry.smoothedCenterY + TAG_OFFSET_Y;
      var angle = urgentEntry.smoothedAngle || 0;
      var targetRightX = tagCenterX + GHOST_TAG_OFFSET * Math.cos(angle);
      var targetRightY = tagCenterY + GHOST_TAG_OFFSET * Math.sin(angle);
      var targetLeftX = tagCenterX - GHOST_TAG_OFFSET * Math.cos(angle);
      var targetLeftY = tagCenterY - GHOST_TAG_OFFSET * Math.sin(angle);
      var tx, ty;
      if (ghost.state === 'waving' && ghost.trackingEntryId === urgentEntry.id) {
        ghost.trackingEntryId = urgentEntry.id;
        tx = ghost.targetSide === 'left' ? targetLeftX : targetRightX;
        ty = ghost.targetSide === 'left' ? targetLeftY : targetRightY;
        ghost.screenX = tx;
        ghost.screenY = ty;
        ghost.dir = 'wave';
      } else if (ghost.state === 'tracking' && ghost.trackingEntryId === urgentEntry.id) {
        tx = ghost.targetSide === 'left' ? targetLeftX : targetRightX;
        ty = ghost.targetSide === 'left' ? targetLeftY : targetRightY;
        var dx = tx - gx;
        var dy = ty - gy;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < GHOST_REACH_DIST) {
          ghost.state = 'waving';
          ghost.screenX = tx;
          ghost.screenY = ty;
          ghost.dir = 'wave';
        } else if (dist > 0) {
          ghost.screenX = gx + (dx / dist) * GHOST_SPEED_TRACKING;
          ghost.screenY = gy + (dy / dist) * GHOST_SPEED_TRACKING;
          ghost.dir = getGhostMoveDir(dx, dy);
        }
      } else {
        ghost.state = 'tracking';
        ghost.trackingEntryId = urgentEntry.id;
        ghost.targetSide = gx > tagCenterX ? 'right' : 'left';
        tx = ghost.targetSide === 'left' ? targetLeftX : targetRightX;
        ty = ghost.targetSide === 'left' ? targetLeftY : targetRightY;
        var dx = tx - gx;
        var dy = ty - gy;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < GHOST_REACH_DIST) {
          ghost.state = 'waving';
          ghost.screenX = tx;
          ghost.screenY = ty;
          ghost.dir = 'wave';
        } else if (dist > 0) {
          ghost.screenX = gx + (dx / dist) * GHOST_SPEED_TRACKING;
          ghost.screenY = gy + (dy / dist) * GHOST_SPEED_TRACKING;
          ghost.dir = getGhostMoveDir(dx, dy);
        }
      }
    }
    if (ghost.state === 'wandering') {
      ghost.screenX = Math.max(minX, Math.min(maxX, ghost.screenX));
      ghost.screenY = Math.max(minY, Math.min(maxY, ghost.screenY));
    }
  }

  function drawGhost() {
    if (!ghost.spawned) return;
    var frame = (Math.floor(performance.now() / GHOST_FLIP_MS) % 2) + 1;
    var dir = ghost.dir === 'wave' ? 'wave' : ghost.dir;
    var key = 'ghost_' + (dir === 'wave' ? 'wave' : 'move_' + dir) + '_' + frame;
    var img = arAssets[key];
    if (img && img.complete && img.naturalWidth > 0) {
      overlayCtx.drawImage(img, ghost.screenX - GHOST_SIZE / 2, ghost.screenY - GHOST_SIZE / 2, GHOST_SIZE, GHOST_SIZE);
    }
  }

  function drawAROverlay() {
    overlayCtx.clearRect(0, 0, viewW, viewH);
    updateGhost();
    for (const entry of activeProducts.values()) {
      drawSingleARTag(entry);
    }
    drawGhost();
  }

  // --- 購入モーダル・タップ判定 ---
  const purchaseModal = document.getElementById('purchaseModal');
  const purchaseModalTitle = document.getElementById('purchaseModalTitle');
  const purchaseModalMessage = document.getElementById('purchaseModalMessage');
  const purchaseModalActions = document.getElementById('purchaseModalActions');
  const purchaseModalYes = document.getElementById('purchaseModalYes');
  const purchaseModalNo = document.getElementById('purchaseModalNo');
  const purchaseModalBack = document.getElementById('purchaseModalBack');
  const purchaseModalBackBtn = document.getElementById('purchaseModalBackBtn');

  let selectedPurchaseId = null;
  let modalOpen = false;

  function isPointInTag(px, py, entry) {
    const centerX = entry.smoothedCenterX;
    const centerY = entry.smoothedCenterY + TAG_OFFSET_Y;
    const angle = entry.smoothedAngle;
    const dx = px - centerX;
    const dy = py - centerY;
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    const localX = dx * cosA - dy * sinA;
    const localY = dx * sinA + dy * cosA;
    const hw = TAG_WIDTH / 2;
    const hh = TAG_HEIGHT / 2;
    return localX >= -hw && localX <= hw && localY >= -hh && localY <= hh;
  }

  function getCanvasCoords(e) {
    const rect = overlayCanvas.getBoundingClientRect();
    const scaleX = overlayCanvas.width / rect.width;
    const scaleY = overlayCanvas.height / rect.height;
    const clientX = e.clientX != null ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const clientY = e.clientY != null ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  function openPurchaseModal(itemId, productName) {
    selectedPurchaseId = itemId;
    modalOpen = true;
    purchaseModalTitle.textContent = '購入しますか？';
    purchaseModalMessage.textContent = productName ? productName + ' を購入しますか？' : 'この商品を購入しますか？';
    purchaseModalActions.classList.remove('hidden');
    purchaseModalBack.classList.add('hidden');
    purchaseModal.classList.remove('hidden');
  }

  function closePurchaseModal() {
    purchaseModal.classList.add('hidden');
    modalOpen = false;
    selectedPurchaseId = null;
  }

  function showPurchaseResult(success, message) {
    purchaseModalTitle.textContent = success ? '購入完了' : '';
    purchaseModalMessage.textContent = message;
    purchaseModalActions.classList.add('hidden');
    purchaseModalBack.classList.remove('hidden');
  }

  function onOverlayPointerDown(e) {
    if (modalOpen) return;
    const coords = getCanvasCoords(e);
    for (const entry of activeProducts.values()) {
      if (isPointInTag(coords.x, coords.y, entry)) {
        e.preventDefault();
        const name = (entry.productInfo && entry.productInfo.name) ? entry.productInfo.name : 'この商品';
        openPurchaseModal(entry.id, name);
        return;
      }
    }
  }

  purchaseModalYes.addEventListener('click', function() {
    if (!selectedPurchaseId) return;
    const url = API_BASE + '/' + encodeURIComponent(selectedPurchaseId) + '/purchase';
    fetch(url, { method: 'POST' })
      .then(function(res) {
        if (res.ok) {
          showPurchaseResult(true, 'レスキュー成功！ありがとうございます！');
          activeProducts.delete(selectedPurchaseId);
        } else {
          return res.json().then(function(body) {
            showPurchaseResult(false, '申し訳ありません、在庫がなくなりました');
          }, function() {
            showPurchaseResult(false, '申し訳ありません、在庫がなくなりました');
          });
        }
      })
      .catch(function() {
        showPurchaseResult(false, '申し訳ありません、通信に失敗しました');
      });
  });

  purchaseModalNo.addEventListener('click', function() {
    purchaseModalActions.classList.add('hidden');
    purchaseModalBack.classList.remove('hidden');
    purchaseModalMessage.textContent = 'キャンセルしました。スキャンに戻ります。';
  });

  purchaseModalBackBtn.addEventListener('click', function() {
    closePurchaseModal();
  });

  overlayCanvas.addEventListener('pointerdown', onOverlayPointerDown);

  // --- Main Loop (detection + tick) ---
  function tick() {
    if (!videoEl || videoEl.readyState < 2) {
      requestAnimationFrame(tick);
      return;
    }

    drawVideoToDetectCanvas();
    drawVideoToCameraCanvas();

    const now = performance.now();
    frameCount += 1;
    const scanMode = frameCount % 4;
    const scanW = Math.round(detectW * 0.75);
    const scanH = Math.round(detectH * 0.75);
    let dx = 0, dy = 0;
    if (scanMode === 0) { dx = 0; dy = 0; }
    else if (scanMode === 1) { dx = Math.round(detectW * 0.3); dy = 0; }
    else if (scanMode === 2) { dx = 0; dy = Math.round(detectH * 0.3); }
    else { dx = Math.round(detectW * 0.3); dy = Math.round(detectH * 0.3); }

    const imageData = detectCtx.getImageData(dx, dy, scanW, scanH);
    const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 1 });

    if (code && code.location) {
      const loc = code.location;
      const adjustedLocation = {
        topLeftCorner:     { x: loc.topLeftCorner.x + dx, y: loc.topLeftCorner.y + dy },
        topRightCorner:    { x: loc.topRightCorner.x + dx, y: loc.topRightCorner.y + dy },
        bottomRightCorner: { x: loc.bottomRightCorner.x + dx, y: loc.bottomRightCorner.y + dy },
        bottomLeftCorner:  { x: loc.bottomLeftCorner.x + dx, y: loc.bottomLeftCorner.y + dy }
      };
      const qrId = code.data;
      const { cx, cy, angle } = getQRCenterAndAngle(adjustedLocation);
      const sc = detectToScreen(cx, cy);
      const tl = detectToScreen(adjustedLocation.topLeftCorner.x, adjustedLocation.topLeftCorner.y);
      const tr = detectToScreen(adjustedLocation.topRightCorner.x, adjustedLocation.topRightCorner.y);
      const br = detectToScreen(adjustedLocation.bottomRightCorner.x, adjustedLocation.bottomRightCorner.y);
      const bl = detectToScreen(adjustedLocation.bottomLeftCorner.x, adjustedLocation.bottomLeftCorner.y);

      let entry = activeProducts.get(qrId);

      if (entry) {
        entry.smoothedCenterX = lerp(entry.smoothedCenterX, sc.x, LERP_NEW);
        entry.smoothedCenterY = lerp(entry.smoothedCenterY, sc.y, LERP_NEW);
        entry.smoothedAngle = lerp(entry.smoothedAngle, angle, LERP_NEW);
        entry.smoothedCorners = {
          tl: { x: lerp(entry.smoothedCorners.tl.x, tl.x, LERP_NEW), y: lerp(entry.smoothedCorners.tl.y, tl.y, LERP_NEW) },
          tr: { x: lerp(entry.smoothedCorners.tr.x, tr.x, LERP_NEW), y: lerp(entry.smoothedCorners.tr.y, tr.y, LERP_NEW) },
          br: { x: lerp(entry.smoothedCorners.br.x, br.x, LERP_NEW), y: lerp(entry.smoothedCorners.br.y, br.y, LERP_NEW) },
          bl: { x: lerp(entry.smoothedCorners.bl.x, bl.x, LERP_NEW), y: lerp(entry.smoothedCorners.bl.y, bl.y, LERP_NEW) }
        };
        entry.lastSeenTime = now;
      } else {
        entry = {
          id: qrId,
          productInfo: null,
          remainingMinutes: null,
          smoothedCorners: { tl, tr, br, bl },
          smoothedCenterX: sc.x,
          smoothedCenterY: sc.y,
          smoothedAngle: angle,
          lastSeenTime: now,
          isFetching: true
        };
        activeProducts.set(qrId, entry);
        fetchProductInfo(qrId)
          .then(function(product) {
            entry.productInfo = product;
            entry.remainingMinutes = (product && product.expiry_time) ? getRemainingMinutes(product.expiry_time) : null;
            entry.isFetching = false;
          })
          .catch(function() {
            entry.productInfo = { name: '取得失敗' };
            entry.remainingMinutes = null;
            entry.isFetching = false;
          });
      }
    }

    if (now - lastExpiryUpdateTime >= EXPIRY_UPDATE_INTERVAL_MS) {
      lastExpiryUpdateTime = now;
      for (const entry of activeProducts.values()) {
        if (entry.productInfo && entry.productInfo.expiry_time) {
          entry.remainingMinutes = getRemainingMinutes(entry.productInfo.expiry_time);
        }
      }
    }

    for (const [qrId, entry] of activeProducts.entries()) {
      if (now - entry.lastSeenTime > AR_TIMEOUT_MS) {
        activeProducts.delete(qrId);
      }
    }

    detectCtx.save();
    detectCtx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
    detectCtx.lineWidth = 2;
    detectCtx.setLineDash([4, 4]);
    detectCtx.strokeRect(dx, dy, scanW, scanH);
    detectCtx.restore();

    drawAROverlay();
    requestAnimationFrame(tick);
  }

  // --- ARアセットプリロード ---
  function loadArAssets() {
    return Promise.all(Object.keys(ASSET_URLS).map(function(key) {
      return new Promise(function(resolve) {
        const img = new Image();
        img.onload = function() { arAssets[key] = img; resolve(); };
        img.onerror = resolve;
        img.src = ASSET_URLS[key];
      });
    }));
  }

  // --- Camera & Init ---
  async function startCamera() {
    try {
      await loadArAssets();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      videoEl.srcObject = stream;
      await new Promise(function(resolve, reject) {
        videoEl.onloadedmetadata = resolve;
        videoEl.onerror = reject;
      });
      videoEl.play();
      updateCoordinateTransform();
      loadingEl.style.display = 'none';
      tick();
    } catch (err) {
      loadingEl.innerHTML = '<p class="text-red-400">カメラを利用できません</p>';
      console.error(err);
    }
  }

  window.addEventListener('resize', function() {
    updateCoordinateTransform();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startCamera);
  } else {
    startCamera();
  }
})();
