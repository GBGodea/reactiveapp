let sessionSub = null;
let disconnect$ = null;

(() => {
    const { Observable, Subject } = rxjs;
    const { map, tap, filter, share, takeUntil } = rxjs.operators;

    // UI
    const btnConnect = document.getElementById('btnConnect');
    const btnDisconnect = document.getElementById('btnDisconnect');
    const statusEl = document.getElementById('status');

    const fTemp = document.getElementById('fTemp');
    const fHum  = document.getElementById('fHum');
    const fMot  = document.getElementById('fMot');

    const windowSecEl = document.getElementById('windowSec');
    const cardsRoot = document.getElementById('cards');

    let disconnect$ = new Subject();

    // Settings
    const WINDOW_MS = 60_000;
    windowSecEl.textContent = String(WINDOW_MS / 1000);
    const MAX_LOG_LINES = 200;

    // In-memory UI state (per sensorId)
    // sensorId -> { type, deviceId, canvas, logEl, points: [{t,v}] }
    const sensorsUI = new Map();

    function setStatus(online, text) {
        statusEl.textContent = text;
        statusEl.classList.toggle('ok', online);
        statusEl.classList.toggle('bad', !online);
    }

    // ---- SSE -> Observable ----
    function sse$(url) {
        return new Observable(subscriber => {
            const es = new EventSource(url);

            es.onopen = () => subscriber.next({ __type: 'open' });
            es.onmessage = (evt) => subscriber.next({ __type: 'message', data: evt.data });
            es.onerror = (err) => subscriber.next({ __type: 'error', err });

            return () => es.close();
        });
    }

    function parseReading(jsonStr) {
        const r = JSON.parse(jsonStr);
        r.value = Number(r.value);
        r._t = Date.parse(r.ts);
        return r;
    }

    function typeAllowed(type) {
        if (type === 'THERMOMETER') return fTemp.checked;
        if (type === 'HUMIDITY') return fHum.checked;
        if (type === 'MOTION') return fMot.checked;
        return true;
    }

    function formatValue(r) {
        if (r.type === 'MOTION') return String(r.value >= 1 ? 1 : 0);
        return Number.isFinite(r.value) ? r.value.toFixed(1) : String(r.value);
    }

    // ---- Logs ----
    function addLogLine(logEl, text) {
        const div = document.createElement('div');
        div.className = 'logline mono';
        div.textContent = text;
        logEl.prepend(div);

        while (logEl.childNodes.length > MAX_LOG_LINES) {
            logEl.removeChild(logEl.lastChild);
        }
    }

    // ---- Data window ----
    function keepWindow(points, nowMs) {
        const from = nowMs - WINDOW_MS;
        let i = 0;
        while (i < points.length && points[i].t < from) i++;
        return i === 0 ? points : points.slice(i);
    }

    // ---- Canvas drawing ----
    function clear(ctx, w, h) {
        ctx.clearRect(0, 0, w, h);
    }

    function drawAxes(ctx, w, h, yMin, yMax) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

        ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono"';
        ctx.fillText(String(yMax), 6, 14);
        ctx.fillText(String(yMin), 6, h - 6);
        ctx.restore();
    }

    function drawLineChart(canvas, points, yMin, yMax) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        clear(ctx, w, h);
        drawAxes(ctx, w, h, yMin, yMax);
        if (!points.length) return;

        const t0 = points[0].t;
        const t1 = points[points.length - 1].t;
        const span = Math.max(1, t1 - t0);

        const pad = 16;
        const x0 = pad, x1 = w - pad;
        const y0 = pad, y1 = h - pad;

        ctx.save();
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const x = x0 + ((p.t - t0) / span) * (x1 - x0);
            const y = y1 - ((p.v - yMin) / (yMax - yMin)) * (y1 - y0);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        const last = points[points.length - 1];
        const lx = x0 + ((last.t - t0) / span) * (x1 - x0);
        const ly = y1 - ((last.v - yMin) / (yMax - yMin)) * (y1 - y0);

        ctx.beginPath();
        ctx.arc(lx, ly, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function drawBarChart(canvas, points) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        clear(ctx, w, h);
        drawAxes(ctx, w, h, 0, 1);
        if (!points.length) return;

        const t0 = points[0].t;
        const t1 = points[points.length - 1].t;
        const span = Math.max(1, t1 - t0);

        const pad = 16;
        const x0 = pad, x1 = w - pad;
        const y0 = pad, y1 = h - pad;
        const usableW = (x1 - x0);

        const barW = Math.max(2, Math.floor(usableW / Math.min(points.length, 240)));

        ctx.save();
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (p.v <= 0) continue;
            const x = x0 + ((p.t - t0) / span) * usableW;
            const bh = (y1 - y0);
            ctx.fillRect(x, y1 - bh, barW, bh);
        }
        ctx.restore();
    }

    // ---- Dynamic cards per sensor ----
    function titleForType(type) {
        if (type === 'THERMOMETER') return 'Температура';
        if (type === 'HUMIDITY') return 'Влажность';
        if (type === 'MOTION') return 'Движение';
        return type;
    }

    function rangeForType(type) {
        if (type === 'THERMOMETER') return { kind: 'line', yMin: 15, yMax: 35, unit: '°C' };
        if (type === 'HUMIDITY') return { kind: 'line', yMin: 50, yMax: 70, unit: '' };
        if (type === 'MOTION') return { kind: 'bar',  yMin: 0,  yMax: 1,  unit: '' };
        return { kind: 'line', yMin: 0, yMax: 1, unit: '' };
    }

    function createSensorCard(sensorId, deviceId, type) {
        const section = document.createElement('section');
        section.className = 'card';
        section.dataset.sensorId = sensorId;
        section.dataset.type = type;

        const header = document.createElement('div');
        header.className = 'cardHeader';

        const left = document.createElement('div');
        left.innerHTML = `
      <h3 style="margin:0;">${titleForType(type)} · <span class="mono">${sensorId}</span></h3>
      <div class="muted">deviceId: <span class="mono">${deviceId ?? ''}</span> · последние ${WINDOW_MS/1000}s</div>
    `;

        const right = document.createElement('div');
        right.className = 'pill mono';
        right.textContent = type;

        header.appendChild(left);
        header.appendChild(right);

        const panel = document.createElement('div');
        panel.className = 'panel';

        const chartBox = document.createElement('div');
        chartBox.className = 'chartBox';

        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 260;

        const range = rangeForType(type);
        const hint = document.createElement('div');
        hint.className = 'muted';
        hint.style.marginTop = '6px';
        hint.textContent =
            range.kind === 'line'
                ? `Диапазон: ${range.yMin}–${range.yMax} ${range.unit} · Линия`
                : `0/1 · Столбики`;

        chartBox.appendChild(canvas);
        chartBox.appendChild(hint);

        const logBox = document.createElement('div');
        logBox.className = 'logBox';

        const logEl = document.createElement('div');
        logEl.className = 'log';
        logBox.appendChild(logEl);

        panel.appendChild(chartBox);
        panel.appendChild(logBox);

        section.appendChild(header);
        section.appendChild(panel);

        // Добавляем карточку в начало списка (новые сверху)
        cardsRoot.prepend(section);

        return { section, canvas, logEl, points: [], type, deviceId };
    }

    function ensureSensorUI(r) {
        let ui = sensorsUI.get(r.sensorId);
        if (!ui) {
            ui = createSensorCard(r.sensorId, r.deviceId, r.type);
            sensorsUI.set(r.sensorId, ui);
            addLogLine(ui.logEl, `[open] sensor card created`);
        } else {
            // если вдруг deviceId/type пришли позже — обновим
            ui.type = ui.type || r.type;
            ui.deviceId = ui.deviceId || r.deviceId;
        }
        return ui;
    }

    function redraw(ui) {
        const range = rangeForType(ui.type);
        if (range.kind === 'line') {
            drawLineChart(ui.canvas, ui.points, range.yMin, range.yMax);
        } else {
            drawBarChart(ui.canvas, ui.points);
        }
    }

    function onReading(r) {
        const ui = ensureSensorUI(r);

        // если тип отключён чекбоксом — просто не обновляем (карточку можно скрывать, если захочешь)
        if (!typeAllowed(r.type)) return;

        const now = r._t;
        const v = (r.type === 'MOTION') ? (r.value >= 1 ? 1 : 0) : r.value;

        ui.points = keepWindow([...ui.points, { t: now, v }], now);
        redraw(ui);

        const suffix = (r.type === 'THERMOMETER') ? '°C' : '';
        addLogLine(ui.logEl, `[${r.type}] ${formatValue(r)}${suffix} @ ${r.ts}`);
    }

    // ---- Connect logic ----
    function connect() {
        // если уже было подключение — сначала аккуратно закрываем
        disconnect();

        disconnect$ = new rxjs.Subject();

        setStatus(false, 'CONNECTING...');
        btnConnect.disabled = true;
        btnDisconnect.disabled = false;

        const base$ = sse$('/api/stream').pipe(
            takeUntil(disconnect$),
            tap(evt => {
                if (evt.__type === 'open') {
                    setStatus(true, 'ONLINE');
                    // если у тебя отдельные логи по сенсорам — можно логировать только в консоль
                    console.log('[SSE] open');
                }
                if (evt.__type === 'error') {
                    setStatus(false, 'RECONNECTING...');
                    console.log('[SSE] error/reconnecting');
                }
            }),
            filter(evt => evt.__type === 'message'),
            map(evt => parseReading(evt.data)),
            share()
        );

        // ВАЖНО: сохраняем подписку, чтобы потом явно закрыть
        sessionSub = base$.subscribe({
            next: r => onReading(r),     // твой обработчик: создает карточки, рисует, пишет лог
            error: e => console.log('[base$] error', e),
            complete: () => console.log('[base$] complete')
        });
    }

    function disconnect() {
        // 1) завершаем поток
        if (disconnect$) {
            disconnect$.next();
            disconnect$.complete();
            disconnect$ = null;
        }

        // 2) отписываемся (это гарантированно вызовет teardown в sse$ → es.close())
        if (sessionSub) {
            sessionSub.unsubscribe();
            sessionSub = null;
        }

        setStatus(false, 'OFFLINE');
        btnConnect.disabled = false;
        btnDisconnect.disabled = true;
    }

    btnConnect.addEventListener('click', connect);
    btnDisconnect.addEventListener('click', disconnect);

    // можно обновлять видимость карточек при переключении чекбоксов (опционально)
    function refreshVisibility() {
        for (const ui of sensorsUI.values()) {
            const visible = typeAllowed(ui.type);
            ui.section.style.display = visible ? '' : 'none';
        }
    }
    fTemp.addEventListener('change', refreshVisibility);
    fHum.addEventListener('change', refreshVisibility);
    fMot.addEventListener('change', refreshVisibility);

    // auto connect
    connect();
})();
