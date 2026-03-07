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

  const DETECT_WIDTH = 320;
  const LERP_OLD = 0.7;
  const LERP_NEW = 0.3;
  const AR_TIMEOUT_MS = 500;
  /** バックエンドAPI（ローカル: uvicorn 等で 8000 番で起動） */
  const API_BASE = 'http://localhost:8000/api/items';
  const EXPIRY_UPDATE_INTERVAL_MS = 1000;

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

  // --- State (multi-QR tracking) ---
  const activeProducts = new Map();
  let lastExpiryUpdateTime = 0;

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

  // --- AR Drawing ---
  const TAG_OFFSET_Y = -64;
  const TAG_WIDTH = 180;
  const TAG_HEIGHT = 78;

  function applyStatusStyle(ctx, status, isUrgentBlink) {
    const grad = ctx.createLinearGradient(0, 0, TAG_WIDTH, 0);
    if (status === 'discounted') {
      grad.addColorStop(0, '#dc2626');
      grad.addColorStop(0.5, '#ea580c');
      grad.addColorStop(1, '#ca8a04');
      ctx.fillStyle = grad;
      ctx.strokeStyle = '#fbbf24';
    } else if (status === 'urgent') {
      grad.addColorStop(0, '#b91c1c');
      grad.addColorStop(0.5, '#dc2626');
      grad.addColorStop(1, '#ea580c');
      ctx.fillStyle = grad;
      ctx.strokeStyle = isUrgentBlink ? '#fef08a' : '#fbbf24';
      ctx.shadowColor = '#fef08a';
      ctx.shadowBlur = 8;
    } else {
      grad.addColorStop(0, '#0ea5e9');
      grad.addColorStop(1, '#22c55e');
      ctx.fillStyle = grad;
      ctx.strokeStyle = '#67e8a3';
    }
    ctx.lineWidth = 2;
  }

  function roundRect(ctx, x, y, w, h, r) {
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

  function drawSingleARTag(entry) {
    const { smoothedCorners, smoothedCenterX, smoothedCenterY, smoothedAngle, productInfo, remainingMinutes } = entry;
    const centerX = smoothedCenterX;
    const centerY = smoothedCenterY;
    const angle = smoothedAngle;

    if (smoothedCorners) {
      const { tl, tr, br, bl } = smoothedCorners;
      overlayCtx.strokeStyle = '#e11d48';
      overlayCtx.lineWidth = 4;
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

    const status = (productInfo && productInfo.status) ? productInfo.status : 'normal';
    const isUrgentTime = remainingMinutes !== null && remainingMinutes < 60;
    const blinkOn = isUrgentTime && (performance.now() % 500 < 250);
    applyStatusStyle(overlayCtx, status, blinkOn);

    roundRect(overlayCtx, 0, 0, TAG_WIDTH, TAG_HEIGHT, 8);
    overlayCtx.fill();
    if (!isUrgentTime || blinkOn) {
      overlayCtx.stroke();
    }
    overlayCtx.shadowBlur = 0;

    let y = 16;
    const lineHeight = 14;
    overlayCtx.fillStyle = '#fff';
    overlayCtx.textAlign = 'center';

    if (!productInfo || !productInfo.name) {
      overlayCtx.font = 'bold 13px sans-serif';
      overlayCtx.fillText('読み込み中...', TAG_WIDTH / 2, y);
      y += lineHeight + 4;
      overlayCtx.font = 'bold 16px sans-serif';
      overlayCtx.fillText('---', TAG_WIDTH / 2, y + 10);
      overlayCtx.restore();
      return;
    }

    if (productInfo.name === '取得失敗') {
      overlayCtx.font = 'bold 13px sans-serif';
      overlayCtx.fillText('取得失敗', TAG_WIDTH / 2, y);
      overlayCtx.restore();
      return;
    }

    overlayCtx.font = 'bold 12px sans-serif';
    const nameText = productInfo.name.length > 14 ? productInfo.name.slice(0, 13) + '…' : productInfo.name;
    overlayCtx.fillText(nameText, TAG_WIDTH / 2, y);
    y += lineHeight;

    if (isUrgentTime) {
      overlayCtx.fillStyle = '#fef08a';
      overlayCtx.font = 'bold 11px sans-serif';
      overlayCtx.fillText('期限間近！', TAG_WIDTH / 2, y);
      overlayCtx.fillStyle = '#fff';
      y += lineHeight;
    }

    const hasDiscount = productInfo.discount_rate > 0 && productInfo.original_price != null;
    if (hasDiscount) {
      const origText = '¥' + productInfo.original_price;
      overlayCtx.font = '11px sans-serif';
      const origW = overlayCtx.measureText(origText).width;
      const origCenterX = TAG_WIDTH / 2 - 24;
      overlayCtx.fillStyle = 'rgba(255,255,255,0.9)';
      overlayCtx.fillText(origText, origCenterX, y);
      overlayCtx.strokeStyle = '#fff';
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.moveTo(origCenterX - origW / 2, y);
      overlayCtx.lineTo(origCenterX + origW / 2, y);
      overlayCtx.stroke();
      overlayCtx.lineWidth = 2;
      const badgeText = Math.round(productInfo.discount_rate) + '% OFF';
      overlayCtx.font = 'bold 10px sans-serif';
      const badgeW = Math.max(overlayCtx.measureText(badgeText).width + 10, 44);
      const badgeH = 16;
      const badgeLeft = origCenterX + origW / 2 + 4;
      overlayCtx.fillStyle = '#b91c1c';
      roundRect(overlayCtx, badgeLeft, y - 12, badgeW, badgeH, 4);
      overlayCtx.fill();
      overlayCtx.fillStyle = '#fff';
      overlayCtx.fillText(badgeText, badgeLeft + badgeW / 2, y - 2);
      y += lineHeight;
    }

    const currentPrice = productInfo.current_price != null ? productInfo.current_price : productInfo.original_price;
    overlayCtx.fillStyle = '#fff';
    overlayCtx.font = 'bold 20px sans-serif';
    const priceText = currentPrice != null ? '¥' + currentPrice : '---';
    overlayCtx.fillText(priceText, TAG_WIDTH / 2, y + 6);
    y += 22;

    if (productInfo.stock !== undefined && productInfo.stock <= 3) {
      overlayCtx.font = '11px sans-serif';
      overlayCtx.fillText('残りわずか（残り' + productInfo.stock + '個）', TAG_WIDTH / 2, y);
    }

    overlayCtx.restore();
  }

  function drawAROverlay() {
    overlayCtx.clearRect(0, 0, viewW, viewH);
    for (const entry of activeProducts.values()) {
      drawSingleARTag(entry);
    }
  }

  // --- Main Loop (detection + tick) ---
  function tick() {
    if (!videoEl || videoEl.readyState < 2) {
      requestAnimationFrame(tick);
      return;
    }

    drawVideoToDetectCanvas();
    drawVideoToCameraCanvas();

    const imageData = detectCtx.getImageData(0, 0, detectW, detectH);
    const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 1 });

    const now = performance.now();

    if (code && code.location) {
      const qrId = code.data;
      const { cx, cy, angle } = getQRCenterAndAngle(code.location);
      const sc = detectToScreen(cx, cy);
      const tl = detectToScreen(code.location.topLeftCorner.x, code.location.topLeftCorner.y);
      const tr = detectToScreen(code.location.topRightCorner.x, code.location.topRightCorner.y);
      const br = detectToScreen(code.location.bottomRightCorner.x, code.location.bottomRightCorner.y);
      const bl = detectToScreen(code.location.bottomLeftCorner.x, code.location.bottomLeftCorner.y);

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

    drawAROverlay();
    requestAnimationFrame(tick);
  }

  // --- Camera & Init ---
  async function startCamera() {
    try {
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
