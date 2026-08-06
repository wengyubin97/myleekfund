import { ViewColumn, window } from 'vscode';
import { buildEqualWeightCurve, CurvePoint, getMinuteRecords } from '../statusbar/groupChart';

/**
 * 打开可交互分时图面板：
 * - 鼠标左键拖动 = 平移曲线
 * - 滚轮 = 以鼠标位置为中心缩放
 * - 面板边框可拖动调整大小
 */
export async function openTrendChart(codes: Array<string>, title: string): Promise<void> {
  const records = await getMinuteRecords(codes);
  const curve = buildEqualWeightCurve(records);
  if (curve.length < 2) {
    window.showWarningMessage('暂无分时数据（收盘或接口不可用）');
    return;
  }
  const panel = window.createWebviewPanel('leekTrendChart', title, ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = buildHtml(curve);
}

function buildHtml(curve: Array<CurvePoint>): string {
  const data = JSON.stringify(curve);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;" />
  <title>分时图</title>
  <style>
    html, body { margin: 0; padding: 0; background: #1e1e1e; }
    #chart { display: block; width: 100%; cursor: grab; }
    #chart.dragging { cursor: grabbing; }
    #tip {
      position: fixed; top: 8px; right: 12px; color: #888; font-size: 12px;
      font-family: -apple-system, sans-serif; user-select: none;
    }
  </style>
</head>
<body>
  <canvas id="chart"></canvas>
  <div id="tip">拖动平移 · 滚轮缩放</div>
  <script>
    (function () {
      var curve = ${data};
      var FAST = 0.15, FULL = 0.6;
      var GRAY = [150, 150, 150], UP = [240, 82, 82], DOWN = [64, 175, 84];
      var padL = 70, padR = 10, padT = 14, padB = 24;

      var canvas = document.getElementById('chart');
      var ctx = canvas.getContext('2d');
      var W = 720, H = 320;
      canvas.width = W; canvas.height = H;

      var pcts = curve.map(function (p) { return p.pct; });
      var minPct = Math.min.apply(null, pcts);
      var maxPct = Math.max.apply(null, pcts);
      var maxAbs = Math.max(Math.abs(minPct), Math.abs(maxPct), 0.5);
      var chartW = W - padL - padR;
      var chartH = H - padT - padB;
      var midY = padT + chartH / 2;
      var scaleY0 = chartH / 2 / maxAbs;
      var N = curve.length;

      var scale = 1, ox = 0, oy = 0;

      function minuteOf(t) {
        var h = parseInt(t.slice(0, 2), 10) || 0;
        var m = parseInt(t.slice(2, 4), 10) || 0;
        return h * 60 + m;
      }

      function toX(i) {
        return padL + (i / (N - 1)) * chartW;
      }

      function sx(i) {
        return padL + (toX(i) - padL) * scale + ox;
      }

      function sy(pct) {
        return midY - pct * scaleY0 * scale + oy;
      }

      function segColor(p0, p1) {
        var diff = p1.pct - p0.pct;
        var mins = minuteOf(p1.time) - minuteOf(p0.time);
        if (mins > 1) return GRAY;
        var speed = Math.abs(diff);
        if (speed < FAST) return GRAY;
        var intensity = Math.min(1, (speed - FAST) / (FULL - FAST));
        var base = diff > 0 ? UP : DOWN;
        return [
          Math.round(GRAY[0] + (base[0] - GRAY[0]) * intensity),
          Math.round(GRAY[1] + (base[1] - GRAY[1]) * intensity),
          Math.round(GRAY[2] + (base[2] - GRAY[2]) * intensity)
        ];
      }

      function lastSignal() {
        if (N < 2) return null;
        var p0 = curve[N - 2], p1 = curve[N - 1];
        if (minuteOf(p1.time) - minuteOf(p0.time) > 1) return null;
        var diff = p1.pct - p0.pct;
        var speed = Math.abs(diff);
        if (speed < FAST) return null;
        return {
          level: speed >= FULL ? 'extreme' : 'fast',
          direction: diff > 0 ? 'up' : 'down'
        };
      }

      function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

      function draw() {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, W, H);

        // 网格：零轴 + 1/4 线
        ctx.lineWidth = 1;
        drawDashed(sx(0), sy(0), sx(N - 1), sy(0), 'rgba(255,255,255,0.7)', [4, 3]);
        drawDashed(sx(0), sy(maxPct), sx(N - 1), sy(maxPct), 'rgba(255,255,255,0.35)', [4, 3]);
        drawDashed(sx(0), sy(minPct), sx(N - 1), sy(minPct), 'rgba(255,255,255,0.35)', [4, 3]);

        // 曲线（分段着色）
        ctx.lineWidth = 2;
        for (var i = 0; i < N - 1; i++) {
          var color = segColor(curve[i], curve[i + 1]);
          ctx.strokeStyle = rgb(color);
          ctx.beginPath();
          ctx.moveTo(sx(i), sy(curve[i].pct));
          ctx.lineTo(sx(i + 1), sy(curve[i + 1].pct));
          ctx.stroke();
        }

        // 当前点
        ctx.fillStyle = curve[N - 1].pct >= 0 ? rgb(UP) : rgb(DOWN);
        ctx.beginPath();
        ctx.arc(sx(N - 1), sy(curve[N - 1].pct), 4, 0, Math.PI * 2);
        ctx.fill();

        // 标注
        ctx.font = '11px -apple-system, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText('MAX ' + fmt(maxPct), 4, sy(maxPct));
        ctx.fillText('MIN ' + fmt(minPct), 4, sy(minPct));
        ctx.fillText('0', 4, sy(0));
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.textBaseline = 'top';
        ctx.fillText(curve[0].time, padL, H - padB + 6);
        ctx.fillText(curve[Math.floor(N / 2)].time, W / 2 - 12, H - padB + 6);
        ctx.fillText(curve[N - 1].time, W - padR - 30, H - padB + 6);

        // 信号徽标
        var signal = lastSignal();
        if (signal) {
          var text = (signal.level === 'extreme' ? 'SPIKE ' : 'FAST ') +
            (signal.direction === 'up' ? 'UP' : 'DOWN');
          var bw = ctx.measureText(text).width + 10;
          ctx.fillStyle = 'rgba(16,16,16,0.8)';
          ctx.fillRect(W - padR - bw - 4, padT - 8, bw + 8, 18);
          ctx.fillStyle = signal.direction === 'up' ? rgb([255, 96, 96]) : rgb([70, 190, 96]);
          ctx.textBaseline = 'middle';
          ctx.fillText(text, W - padR - bw + 1, padT + 1);
        }
      }

      function fmt(v) {
        return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
      }

      function drawDashed(x0, y0, x1, y1, style, dash) {
        ctx.strokeStyle = style;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 交互：拖动平移
      var dragging = false, startX = 0, startY = 0, startOx = 0, startOy = 0;
      canvas.addEventListener('mousedown', function (e) {
        dragging = true;
        canvas.classList.add('dragging');
        startX = e.clientX; startY = e.clientY;
        startOx = ox; startOy = oy;
      });
      window.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        ox = startOx + (e.clientX - startX);
        oy = startOy + (e.clientY - startY);
        draw();
      });
      window.addEventListener('mouseup', function () {
        dragging = false;
        canvas.classList.remove('dragging');
      });

      // 滚轮缩放（以鼠标为中心）
      canvas.addEventListener('wheel', function (e) {
        e.preventDefault();
        var rect = canvas.getBoundingClientRect();
        var mx = (e.clientX - rect.left) / rect.width * W;
        var my = (e.clientY - rect.top) / rect.height * H;
        var factor = e.deltaY < 0 ? 1.12 : 0.89;
        var ns = Math.min(10, Math.max(0.2, scale * factor));
        factor = ns / scale;
        scale = ns;
        ox = ox + (mx - padL - ox) * (1 - factor);
        oy = oy + (my - midY - oy) * (1 - factor);
        draw();
      }, { passive: false });

      draw();
    })();
  </script>
</body>
</html>`;
}

export default openTrendChart;
