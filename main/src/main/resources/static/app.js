(() => {
    const { Observable, Subject, BehaviorSubject, from, fromEvent, of, EMPTY, merge, defer } = rxjs;
    const { map, tap, filter, takeUntil, switchMap, mergeMap, concatMap, groupBy, bufferTime, catchError, finalize, share } = rxjs.operators;

    const GEN_HTTP = window.GEN_HTTP || 'http://localhost:8080';

    const btnConnect = document.getElementById('btnConnect');
    const btnDisconnect = document.getElementById('btnDisconnect');
    const btnAddSensor = document.getElementById('btnAddSensor');
    const btnReloadSensors = document.getElementById('btnReloadSensors');

    const statusEl = document.getElementById('status');
    const genHttpLabel = document.getElementById('genHttpLabel');
    if (genHttpLabel) genHttpLabel.textContent = GEN_HTTP;

    const fTemp = document.getElementById('fTemp');
    const fHum = document.getElementById('fHum');
    const fMot = document.getElementById('fMot');

    const windowSecEl = document.getElementById('windowSec');
    const cardsRoot = document.getElementById('cards');
    const emptyState = document.getElementById('emptyState');

    const dlgSensor = document.getElementById('dlgSensor');
    const sensorForm = document.getElementById('sensorForm');
    const inpName = document.getElementById('inpName');
    const selType = document.getElementById('selType');
    const inpDeviceId = document.getElementById('inpDeviceId');
    const inpPeriodSec = document.getElementById('inpPeriodSec');

    const btnCancelSensor = document.getElementById('btnCancelSensor');
    const btnCreateSensor = document.getElementById('btnCreateSensor');

    const inpDevicePick = document.getElementById('inpDevicePick');
    const btnApply = document.getElementById('btnApply');
    const devicePickInfo = document.getElementById('devicePickInfo');

    const WINDOW_MS = 60_000;
    if (windowSecEl) windowSecEl.textContent = String(WINDOW_MS / 1000);
    const MAX_LOG_LINES = 200;

    const sensorsUI = new Map();
    const sensorsMeta = new Map();
    const blockedSensors = new Set();
    const cardSubs = new Map();

    const actions$ = new Subject();
    const ui$ = new Subject();
    const online$ = new BehaviorSubject(false);

    let deviceExpr = '';
    let deviceRanges = [];

    function parseDeviceRanges(expr) {
        const s = String(expr || '').trim();
        if (!s) return [];

        const parts = s.split(',').map(x => x.trim()).filter(Boolean);
        const ranges = [];

        for (const p of parts) {
            const dash = p.indexOf('-');
            if (dash >= 0) {
                const a0 = p.slice(0, dash).trim();
                const b0 = p.slice(dash + 1).trim();
                const a = parseInt(a0, 10);
                const b = parseInt(b0, 10);
                if (Number.isFinite(a) && Number.isFinite(b)) {
                    const lo = Math.min(a, b);
                    const hi = Math.max(a, b);
                    ranges.push({ a: lo, b: hi });
                }
            } else {
                const v = parseInt(p, 10);
                if (Number.isFinite(v)) ranges.push({ a: v, b: v });
            }
        }

        if (!ranges.length) return ranges;

        ranges.sort((x, y) => x.a - y.a);
        const merged = [];
        for (const r of ranges) {
            const last = merged[merged.length - 1];
            if (!last) merged.push({ ...r });
            else if (r.a <= last.b + 1) last.b = Math.max(last.b, r.b);
            else merged.push({ ...r });
        }
        return merged;
    }

    function setDeviceFilter(expr) {
        deviceExpr = String(expr || '').trim();
        deviceRanges = parseDeviceRanges(deviceExpr);
        if (devicePickInfo) {
            devicePickInfo.textContent = deviceRanges.length
                ? `devices: ${deviceExpr}`
                : `devices: (all blocked - set filter first)`;
        }
        refreshVisibility();
    }

    function hasDeviceFilter() { return deviceRanges.length > 0; }

    function deviceAllowed(deviceId) {
        if (!deviceRanges.length) return false;
        const v = parseInt(String(deviceId || '').trim(), 10);
        if (!Number.isFinite(v)) return false;
        for (const r of deviceRanges) if (v >= r.a && v <= r.b) return true;
        return false;
    }

    function typeAllowed(type) {
        if (type === 'THERMOMETER') return !!(fTemp && fTemp.checked);
        if (type === 'HUMIDITY') return !!(fHum && fHum.checked);
        if (type === 'MOTION') return !!(fMot && fMot.checked);
        return true;
    }

    function setStatus(online, text) {
        if (!statusEl) return;
        statusEl.textContent = text || (online ? 'ONLINE' : 'OFFLINE');
        statusEl.classList.toggle('ok', !!online);
        statusEl.classList.toggle('bad', !online);
    }

    if (btnConnect) fromEvent(btnConnect, 'click').subscribe(() => actions$.next({ type: 'connect' }));
    if (btnDisconnect) fromEvent(btnDisconnect, 'click').subscribe(() => actions$.next({ type: 'disconnect' }));
    if (btnReloadSensors) fromEvent(btnReloadSensors, 'click').subscribe(() => actions$.next({ type: 'reload' }));

    if (btnAddSensor) {
        fromEvent(btnAddSensor, 'click').subscribe(() => { if (dlgSensor) dlgSensor.showModal(); });
    }

    if (btnCancelSensor) {
        fromEvent(btnCancelSensor, 'click').subscribe(e => {
            e.preventDefault();
            if (dlgSensor) dlgSensor.close();
        });
    }

    if (btnCreateSensor) {
        fromEvent(btnCreateSensor, 'click').subscribe(e => {
            e.preventDefault();
            actions$.next({ type: 'add' });
        });
    }

    if (btnApply) {
        fromEvent(btnApply, 'click').subscribe(e => {
            e.preventDefault();
            actions$.next({ type: 'apply' });
        });
    }

    if (fTemp) fromEvent(fTemp, 'change').subscribe(() => refreshVisibility());
    if (fHum) fromEvent(fHum, 'change').subscribe(() => refreshVisibility());
    if (fMot) fromEvent(fMot, 'change').subscribe(() => refreshVisibility());

    function sse$(url) {
        return new Observable(sub => {
            const es = new EventSource(url);
            es.onopen = () => sub.next({ __type: 'open' });
            es.onerror = err => sub.next({ __type: 'error', err });
            es.onmessage = evt => sub.next({ __type: 'message', data: evt.data });
            return () => es.close();
        }).pipe(share());
    }

    function parseReading(jsonText) {
        const r = JSON.parse(jsonText);
        r._t = Date.parse(r.ts || r.time || r.timestamp || new Date().toISOString());
        return r;
    }

    function addLogLine(logEl, text) {
        if (!logEl) return;
        const div = document.createElement('div');
        div.className = 'logline';
        div.textContent = text;
        logEl.prepend(div);
        while (logEl.childNodes.length > MAX_LOG_LINES) logEl.removeChild(logEl.lastChild);
    }

    function pushPoint(ui, nowMs, v) {
        if (ui.pointsStart == null) ui.pointsStart = 0;
        ui.points.push({ t: nowMs, v });

        const fromT = nowMs - WINDOW_MS;
        let i = ui.pointsStart;
        while (i < ui.points.length && ui.points[i].t < fromT) i++;
        ui.pointsStart = i;

        // compact the array occasionally
        if (ui.pointsStart > 256 && ui.pointsStart > (ui.points.length >> 1)) {
            ui.points = ui.points.slice(ui.pointsStart);
            ui.pointsStart = 0;
        }
    }

    const dirtyUIs = new Set();
    let rafId = 0;
    function scheduleRedraw(ui) {
        dirtyUIs.add(ui);
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            for (const u of dirtyUIs) redraw(u);
            dirtyUIs.clear();
        });
    }

    function clear(ctx, w, h) { ctx.clearRect(0, 0, w, h); }

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

    function drawLineChart(canvas, points, startIdx, yMin, yMax) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;

        clear(ctx, w, h);
        drawAxes(ctx, w, h, yMin, yMax);

        const start = Math.max(0, startIdx || 0);
        if (points.length - start <= 0) return;

        const t0 = points[start].t;
        const t1 = points[points.length - 1].t;
        const span = Math.max(1, t1 - t0);

        const pad = 16;
        const x0 = pad, x1 = w - pad;
        const y0 = pad, y1 = h - pad;

        ctx.save();
        ctx.lineWidth = 2;
        ctx.beginPath();

        let first = true;
        for (let i = start; i < points.length; i++) {
            const p = points[i];
            const x = x0 + ((p.t - t0) / span) * (x1 - x0);
            const y = y1 - ((p.v - yMin) / (yMax - yMin)) * (y1 - y0);
            if (first) { ctx.moveTo(x, y); first = false; }
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

    function drawBarChart(canvas, points, startIdx) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;

        clear(ctx, w, h);
        drawAxes(ctx, w, h, 0, 1);

        const start = Math.max(0, startIdx || 0);
        if (points.length - start <= 0) return;

        const t0 = points[start].t;
        const t1 = points[points.length - 1].t;
        const span = Math.max(1, t1 - t0);

        const pad = 16;
        const x0 = pad, x1 = w - pad;
        const y0 = pad, y1 = h - pad;
        const usableW = (x1 - x0);
        const visible = Math.max(1, points.length - start);
        const barW = Math.max(2, Math.floor(usableW / Math.min(visible, 240)));

        ctx.save();
        for (let i = start; i < points.length; i++) {
            const p = points[i];
            if (p.v <= 0) continue;
            const x = x0 + ((p.t - t0) / span) * usableW;
            const bh = (y1 - y0);
            ctx.fillRect(x, y1 - bh, barW, bh);
        }
        ctx.restore();
    }

    function titleForType(type) {
        if (type === 'THERMOMETER') return 'Температура';
        if (type === 'HUMIDITY') return 'Влажность';
        if (type === 'MOTION') return 'Движение';
        return type;
    }

    function rangeForType(type) {
        if (type === 'THERMOMETER') return { kind: 'line', yMin: 15, yMax: 35, unit: '°C' };
        if (type === 'HUMIDITY') return { kind: 'line', yMin: 50, yMax: 70, unit: '' };
        if (type === 'MOTION') return { kind: 'bar', yMin: 0, yMax: 1, unit: '' };
        return { kind: 'line', yMin: 0, yMax: 1, unit: '' };
    }

    function genFetch$(path, options) {
        return defer(() => {
            const url = `${GEN_HTTP}${path}`;
            return from(fetch(url, options)).pipe(
                mergeMap(resp => {
                    if (!resp.ok) {
                        return from(resp.text()).pipe(
                            mergeMap(t => {
                                const err = new Error(`${resp.status} ${resp.statusText}: ${t}`);
                                err.status = resp.status;
                                throw err;
                            })
                        );
                    }
                    return from(resp.json());
                })
            );
        });
    }

    function loadSensorsMeta$() {
        return genFetch$('/iot/list').pipe(
            tap(list => {
                sensorsMeta.clear();
                for (const s of list) sensorsMeta.set(s.id, s);

                for (const ui of sensorsUI.values()) {
                    const meta = sensorsMeta.get(ui.section.dataset.sensorId);
                    if (meta) applyMetaToCard(ui, meta);
                }
            })
        );
    }

    function createSensorFromForm$() {
        const name = String(inpName?.value || '').trim();
        const type = String(selType?.value || 'THERMOMETER');
        const deviceId = String(inpDeviceId?.value || '').trim();
        const periodSec = Math.max(0.001, Number(inpPeriodSec?.value || 1));
        const periodIso = `PT${periodSec}S`;

        const body = { name, type, deviceId, period: periodIso };


        return genFetch$('/iot/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function deleteSensor$(sensorId) {
        return defer(() => from(fetch(`${GEN_HTTP}/iot/${encodeURIComponent(sensorId)}`, { method: 'DELETE' }))).pipe(
            mergeMap(resp => {
                if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
                return of(true);
            })
        );
    }

    function adjust$(sensorId, delta) {
        return genFetch$(`/iot/${encodeURIComponent(sensorId)}/adjust?delta=${encodeURIComponent(delta)}`, { method: 'POST' });
    }

    function applyMetaToCard(ui, meta) {
        if (!meta) return;
        ui.titleEl.textContent = `${titleForType(meta.type)} · ${meta.name || meta.id}`;
        ui.metaEl.textContent = `id: ${meta.id} · deviceId: ${meta.deviceId ?? ''} · period: ${meta.period ?? ''}`;
    }

    function createSensorCard(sensorId, deviceId, type) {
        const section = document.createElement('section');
        section.className = 'card';
        section.dataset.sensorId = sensorId;
        section.dataset.type = type;

        // header row
        const headerRow = document.createElement('div');
        headerRow.className = 'cardHeader';

        const titleWrap = document.createElement('div');

        const titleEl = document.createElement('div');
        titleEl.className = 'mono';
        titleEl.textContent = `${titleForType(type)} · ${sensorId}`;

        const metaEl = document.createElement('div');
        metaEl.className = 'muted mono';
        metaEl.textContent = `id: ${sensorId} · deviceId: ${deviceId}`;

        titleWrap.appendChild(titleEl);
        titleWrap.appendChild(metaEl);

        const typePill = document.createElement('span');
        typePill.className = 'pill';
        typePill.textContent = type;

        headerRow.appendChild(titleWrap);
        headerRow.appendChild(typePill);

        // panel: chart + log
        const panel = document.createElement('div');
        panel.className = 'panel';

        const chartBox = document.createElement('div');
        chartBox.className = 'chartBox';

        const canvas = document.createElement('canvas');
        canvas.width = 520;
        canvas.height = 180;
        chartBox.appendChild(canvas);

        const logBox = document.createElement('div');
        logBox.className = 'logBox';

        const logEl = document.createElement('div');
        logEl.className = 'log mono';
        logBox.appendChild(logEl);

        panel.appendChild(chartBox);
        panel.appendChild(logBox);

        // footer/actions
        const footerRow = document.createElement('div');
        footerRow.className = 'cardHeader';

        const left = document.createElement('div');
        left.className = 'muted mono';
        left.textContent = `deviceId: ${deviceId}`;

        const actions = document.createElement('div');
        actions.className = 'actions';

        const biasEl = document.createElement('span');
        biasEl.className = 'muted mono';
        biasEl.textContent = 'bias: 0.0';
        biasEl.dataset.bias = '0';

        const deltaInput = document.createElement('input');
        deltaInput.type = 'number';
        deltaInput.value = '1';
        deltaInput.min = '0.1';
        deltaInput.step = '0.1';
        deltaInput.className = 'deltaInput';

        const btnMinus = document.createElement('button');
        btnMinus.textContent = '−';
        btnMinus.className = 'btnSmall';

        const btnPlus = document.createElement('button');
        btnPlus.textContent = '+';
        btnPlus.className = 'btnSmall';

        const btnDel = document.createElement('button');
        btnDel.textContent = 'delete';
        btnDel.className = 'btnSmall btnDanger';

        actions.appendChild(biasEl);
        actions.appendChild(deltaInput);
        actions.appendChild(btnMinus);
        actions.appendChild(btnPlus);
        actions.appendChild(btnDel);

        footerRow.appendChild(left);
        footerRow.appendChild(actions);

        section.appendChild(headerRow);
        section.appendChild(panel);
        section.appendChild(footerRow);

        cardsRoot.prepend(section);

        const plus$ = fromEvent(btnPlus, 'click').pipe(
            tap(e => e.preventDefault()),
            map(() => Math.abs(Number(deltaInput.value || 1))),
            map(d => ({ type: 'adjust', sensorId, delta: +d }))
        );

        const minus$ = fromEvent(btnMinus, 'click').pipe(
            tap(e => e.preventDefault()),
            map(() => Math.abs(Number(deltaInput.value || 1))),
            map(d => ({ type: 'adjust', sensorId, delta: -d }))
        );

        const del$ = fromEvent(btnDel, 'click').pipe(
            tap(e => e.preventDefault()),
            map(() => ({ type: 'delete', sensorId }))
        );

        const cardActions$ = merge(plus$, minus$, del$);

        const ui = { section, canvas, logEl, points: [], pointsStart: 0, _lastLogT: 0, type, deviceId, titleEl, metaEl, biasEl };
        const meta = sensorsMeta.get(sensorId);
        if (meta) applyMetaToCard(ui, meta);

        addLogLine(logEl, `[open] sensor card created`);
        return { ui, cardActions$ };
    }

    function ensureSensorUI(reading) {
        if (blockedSensors.has(reading.sensorId)) return null;
        if (!deviceAllowed(reading.deviceId)) return null;

        let ui = sensorsUI.get(reading.sensorId);
        if (!ui) {
            const created = createSensorCard(reading.sensorId, reading.deviceId, reading.type);
            ui = created.ui;
            sensorsUI.set(reading.sensorId, ui);

            const sub = created.cardActions$.subscribe(actions$);
            cardSubs.set(reading.sensorId, sub);
        }
        return ui;
    }

    function redraw(ui) {
        const range = rangeForType(ui.type);
        const start = ui.pointsStart || 0;
        if (range.kind === 'line') drawLineChart(ui.canvas, ui.points, start, range.yMin, range.yMax);
        else drawBarChart(ui.canvas, ui.points, start);
    }

    function onReading(r) {
        const ui = ensureSensorUI(r);
        if (!ui) return;

        if (!typeAllowed(r.type)) return;

        const now = r._t;
        const v = (r.type === 'MOTION') ? (r.value >= 1 ? 1 : 0) : r.value;

        pushPoint(ui, now, v);
        scheduleRedraw(ui);

        const suffix = (r.type === 'THERMOMETER') ? '°C' : '';
        if (!ui._lastLogT || (now - ui._lastLogT) >= 1000) {
            ui._lastLogT = now;
            addLogLine(ui.logEl, `[${r.type}] ${Number.isFinite(r.value) ? r.value.toFixed(1) : r.value}${suffix} @ ${r.ts}`);
        }
    }

    function refreshVisibility() {
        for (const ui of sensorsUI.values()) {
            const ok = typeAllowed(ui.type) && deviceAllowed(ui.deviceId);
            ui.section.style.display = ok ? '' : 'none';
        }
        if (emptyState) {
            emptyState.style.display = sensorsUI.size ? 'none' : '';
        }
    }

    // init filter from localStorage
    try {
        const saved = localStorage.getItem('devicePickExpr');
        if (saved && inpDevicePick) inpDevicePick.value = saved;
        setDeviceFilter(inpDevicePick ? inpDevicePick.value : saved);
    } catch (_) {
        setDeviceFilter(inpDevicePick ? inpDevicePick.value : '');
    }

    let sessionId = 0;

    const session$ = actions$.pipe(
        filter(a => a.type === 'connect' || a.type === 'apply'),
        tap(a => {
            if (a.type === 'apply') {
                const expr = inpDevicePick ? inpDevicePick.value : '';
                setDeviceFilter(expr);
                try { localStorage.setItem('devicePickExpr', deviceExpr); } catch (_) {}
            }
        }),
        filter(() => hasDeviceFilter()),
        tap(() => {
            setStatus(false, 'CONNECTING...');
            if (btnConnect) btnConnect.disabled = true;
            if (btnDisconnect) btnDisconnect.disabled = false;
            online$.next(true);
        }),
        switchMap(() => {
            const mySession = ++sessionId;
            const stop$ = actions$.pipe(filter(a => a.type === 'disconnect'));

            const meta$ = loadSensorsMeta$().pipe(takeUntil(stop$));

            const qs = encodeURIComponent(deviceExpr);
            const url = `/api/stream?devices=${qs}`;

            const stream$ = sse$(url).pipe(
                takeUntil(stop$),
                tap(evt => {
                    if (evt.__type === 'open') setStatus(true, 'ONLINE');
                    if (evt.__type === 'error') setStatus(false, 'RECONNECTING...');
                }),
                filter(evt => evt.__type === 'message'),
                map(evt => parseReading(evt.data)),
                tap(r => onReading(r)),
                catchError(e => {
                    ui$.next({ type: 'toast', level: 'error', text: `SSE error: ${e?.message || e}` });
                    return EMPTY;
                })
            );

            const crudBase$ = actions$.pipe(
                takeUntil(stop$),
                filter(a => a.type === 'reload' || a.type === 'add' || a.type === 'delete'),
                mergeMap(a => {
                    if (a.type === 'reload') return loadSensorsMeta$();

                    if (a.type === 'add') {
                        return createSensorFromForm$().pipe(
                            tap(() => {
                                if (dlgSensor) dlgSensor.close();
                                if (sensorForm) sensorForm.reset();
                                if (inpPeriodSec) inpPeriodSec.value = '1';
                            }),
                            switchMap(() => loadSensorsMeta$()),
                            catchError(err => {
                                ui$.next({ type: 'toast', level: 'error', text: `Ошибка создания сенсора: ${err.message}` });
                                return EMPTY;
                            })
                        );
                    }

                    if (a.type === 'delete') {
                        const sensorId = a.sensorId;
                        blockedSensors.add(sensorId);

                        return deleteSensor$(sensorId).pipe(
                            tap(() => {
                                const sub = cardSubs.get(sensorId);
                                if (sub) sub.unsubscribe();
                                cardSubs.delete(sensorId);

                                const existing = sensorsUI.get(sensorId);
                                if (existing) {
                                    existing.section.remove();
                                    sensorsUI.delete(sensorId);
                                }

                                sensorsMeta.delete(sensorId);
                                refreshVisibility();
                            }),
                            catchError(err => {
                                const ui = sensorsUI.get(sensorId);
                                if (ui) addLogLine(ui.logEl, `[delete] ERROR: ${err.message}`);
                                ui$.next({ type: 'toast', level: 'error', text: `Ошибка удаления сенсора: ${err.message}` });
                                blockedSensors.delete(sensorId);
                                return EMPTY;
                            })
                        );
                    }

                    return EMPTY;
                })
            );

            const adjustReq$ = actions$.pipe(
                takeUntil(stop$),
                filter(a => a.type === 'adjust'),
                groupBy(a => a.sensorId),
                mergeMap(group$ => group$.pipe(
                    tap(a => {
                        const ui = sensorsUI.get(a.sensorId);
                        if (!ui || !ui.biasEl) return;
                        const cur = Number(ui.biasEl.dataset.bias || '0') || 0;
                        const next = cur + Number(a.delta || 0);
                        ui.biasEl.dataset.bias = String(next);
                        ui.biasEl.textContent = `bias: ${next.toFixed(2)}`;
                    }),
                    bufferTime(150),
                    map(list => list.reduce((sum, a) => sum + Number(a.delta || 0), 0)),
                    filter(sum => sum !== 0),
                    concatMap(sum => {
                        const sensorId = group$.key;
                        const ui = sensorsUI.get(sensorId);

                        return adjust$(sensorId, sum).pipe(
                            tap(json => {
                                if (ui && ui.biasEl && json && typeof json.bias === 'number') {
                                    ui.biasEl.dataset.bias = String(json.bias);
                                    ui.biasEl.textContent = `bias: ${json.bias.toFixed(2)}`;
                                }
                                if (ui) addLogLine(ui.logEl, `[adjust] delta=${sum} => bias=${json?.bias}`);
                            }),
                            catchError(err => {
                                if (ui) addLogLine(ui.logEl, `[adjust] ERROR: ${err.message}`);
                                ui$.next({ type: 'toast', level: 'error', text: `Ошибка adjust: ${err.message}` });
                                return EMPTY;
                            })
                        );
                    })
                ))
            );

            const crud$ = merge(crudBase$, adjustReq$);

            return merge(meta$, stream$, crud$).pipe(
                finalize(() => {
                    if (mySession === sessionId) {
                        setStatus(false, 'OFFLINE');
                        if (btnConnect) btnConnect.disabled = false;
                        if (btnDisconnect) btnDisconnect.disabled = true;
                        online$.next(false);
                    }
                })
            );
        })
    );

    session$.subscribe();

    setStatus(false, 'OFFLINE');
    if (btnDisconnect) btnDisconnect.disabled = true;

    // auto-connect if filter exists
    if (hasDeviceFilter()) actions$.next({ type: 'connect' });
})();
