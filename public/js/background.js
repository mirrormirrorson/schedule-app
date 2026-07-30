/* ===== 程序化高级背景：主题化实时渲染（暗色=深空星云，浅色=柔和极光） ===== */
(function () {
  var cv = document.getElementById('bgCanvas');
  if (!cv || !cv.getContext) return;
  var ctx = cv.getContext('2d');
  var W = 0, H = 0, dpr = 1, raf = null, running = false, blobs = [];
  var palette = { isDark: false, prim: '#38bdf8', bgc: '#070b16' };

  function hexToRgb(hex) {
    hex = (hex || '').trim();
    if (hex[0] !== '#') {
      var m = hex.match(/\d+/g);
      if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
      return [56, 189, 248];
    }
    var h = hex.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  function readPalette() {
    var cs = getComputedStyle(document.documentElement);
    var theme = document.documentElement.getAttribute('data-theme') || 'pink';
    palette.isDark = (theme === 'dark');
    palette.prim = (cs.getPropertyValue('--primary').trim()) || '#38bdf8';
    palette.bgc = (cs.getPropertyValue('--bg').trim()) || '#070b16';
  }

  function buildBlobs() {
    var cols = palette.isDark
      ? [palette.prim, '#6366f1', '#22d3ee', palette.prim, '#8b5cf6']
      : [palette.prim, '#a5b4fc', '#f9a8d4', '#6ee7b7', '#fcd34d'];
    blobs = cols.map(function (c) {
      return {
        color: c,
        bx: Math.random(), by: Math.random(),
        r: 0.30 + Math.random() * 0.22,
        sx: (Math.random() * 2 - 1) * 0.00005,
        sy: (Math.random() * 2 - 1) * 0.00005,
        ph: Math.random() * Math.PI * 2,
        sp: 0.0005 + Math.random() * 0.0006,
        maxA: palette.isDark ? 0.22 : 0.16
      };
    });
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(now) {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = palette.bgc;
    ctx.fillRect(0, 0, W, H);
    var R = Math.max(W, H);
    ctx.globalCompositeOperation = palette.isDark ? 'lighter' : 'source-over';
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      b.bx += b.sx * 16; b.by += b.sy * 16;
      if (b.bx < -0.25 || b.bx > 1.25) b.sx *= -1;
      if (b.by < -0.25 || b.by > 1.25) b.sy *= -1;
      var pulse = 0.65 + 0.35 * Math.sin(now * b.sp + b.ph);
      var cx = b.bx * W, cy = b.by * H, rad = b.r * R * pulse;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, rgba(b.color, b.maxA));
      g.addColorStop(1, rgba(b.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (palette.isDark) {
      ctx.fillStyle = 'rgba(165,185,235,0.055)';
      var step = 40, off = (now * 0.002) % step;
      for (var x = off; x < W; x += step) {
        for (var y = 0; y < H; y += step) {
          ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    raf = requestAnimationFrame(draw);
  }

  function start() {
    readPalette(); resize(); buildBlobs();
    if (!running) { running = true; raf = requestAnimationFrame(draw); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // 主题切换时同步配色与光斑
  if (window.MutationObserver) {
    new MutationObserver(function () { readPalette(); buildBlobs(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // 视口变化：防抖重算尺寸
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { resize(); buildBlobs(); }, 150);
  });

  // 标签页隐藏时暂停渲染，省电省 CPU
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { running = false; if (raf) cancelAnimationFrame(raf); }
    else if (!running) { running = true; raf = requestAnimationFrame(draw); }
  });
})();
