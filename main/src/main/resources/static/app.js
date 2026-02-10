(() => {
    const {
        Observable,
        Subject,
        BehaviorSubject,
        from,
        fromEvent,
        of,
        EMPTY,
        merge,
        defer
    } = rxjs;

    const {
        map,
        tap,
        filter,
        share,
        takeUntil,
        switchMap,
        mergeMap,
        catchError,
        finalize,
        distinctUntilChanged
    } = rxjs.operators;

    const GEN_HTTP = window.GEN_HTTP || 'http://localhost:8080';

    const btnConnect = document.getElementById('btnConnect');
    const btnDisconnect = document.getElementById('btnDisconnect');
    const btnAddSensor = document.getElementById('btnAddSensor');
    const btnReloadSensors = document.getElementById('btnReloadSensors');

    const statusEl = document.getElementById('status');
    const genHttpLabel = document.getElementById('genHttpLabel');
    if (genHttpLabel) genHttpLabel.textContent = GEN_HTTP;

    const fTemp = document.getElementById('fTemp');
    const fHum  = document.getElementById('fHum');
    const fMot  = document.getElementById('fMot');

    const windowSecEl = document.getElementById('windowSec');
    const cardsRoot = document.getElementById('cards');

    const dlgSensor = document.getElementById('dlgSensor');
    const sensorForm = document.getElementById('sensorForm');
    const inpName = document.getElementById('inpName');
    const selType = document.getElementById('selType');
    const inpDeviceId = document.getElementById('inpDeviceId');
    const inpPeriodSec = document.getElementById('inpPeriodSec');
    const sensorFormError = document.getElementById('sensorFormError');

    const btnCancelSensor = document.getElementById('btnCancelSensor');
    const btnCreateSensor = document.getElementById('btnCreateSensor');

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

    function setStatus(online, text) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle('ok', online);
        statusEl.classList.toggle('bad', !online);
    }

    function showSensorFormError(msg) {
        if (!sensorFormError) return;
        const text = String(msg || '').trim();
        sensorFormError.textContent = text;
        sensorFormError.style.display = text ? '' : 'none';
    }

    function deviceIdExists(deviceId) {
        const d = String(deviceId ?? '').trim();
        if (!d) return false;
        for (const s of sensorsMeta.values()) {
            const sd = String(s?.deviceId ?? '').trim();
            if (sd === d) return true;
        }
        return false;
    }



    function typeAllowed(type) {
        if (type === 'THERMOMETER') return !!fTemp?.checked;
        if (type === 'HUMIDITY') return !!fHum?.checked;
        if (type === 'MOTION') return !!fMot?.checked;
        return true;
    }

    function formatValue(r) {
        if (r.type === 'MOTION') return String(r.value >= 1 ? 1 : 0);
        return Number.isFinite(r.value) ? r.value.toFixed(1) : String(r.value);
    }

    function addLogLine(logEl, text) {
        if (!logEl) return;
        const div = document.createElement('div');
        div.className = 'logline mono';
        div.textContent = text;
        logEl.prepend(div);

        while (logEl.childNodes.length > MAX_LOG_LINES) {
            logEl.removeChild(logEl.lastChild);
        }
    }

    function keepWindow(points, nowMs) {
        const fromT = nowMs - WINDOW_MS;
        let i = 0;
        while (i < points.length && points[i].t < fromT) i++;
        return i === 0 ? points : points.slice(i);
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

        const header = document.createElement('div');
        header.className = 'cardHeader';

        const left = document.createElement('div');

        const titleEl = document.createElement('h3');
        titleEl.style.margin = '0';
        titleEl.textContent = `${titleForType(type)} · ${sensorId}`;

        const metaEl = document.createElement('div');
        metaEl.className = 'muted';
        metaEl.textContent = `id: ${sensorId} · deviceId: ${deviceId ?? ''} · последние ${WINDOW_MS / 1000}s`;

        left.appendChild(titleEl);
        left.appendChild(metaEl);

        const rightBox = document.createElement('div');
        rightBox.className = 'rightBox';

        const typePill = document.createElement('div');
        typePill.className = 'pill mono';
        typePill.textContent = type;

        const actions = document.createElement('div');
        actions.className = 'actions';

        const biasEl = document.createElement('span');
        biasEl.className = 'muted mono';
        biasEl.textContent = 'bias: 0.0';

        const deltaInput = document.createElement('input');
        deltaInput.className = 'deltaInput mono';
        deltaInput.type = 'number';
        deltaInput.step = '0.1';
        deltaInput.value = '1';

        const btnPlus = document.createElement('button');
        btnPlus.className = 'btnSmall';
        btnPlus.textContent = '+Δ';

        const btnMinus = document.createElement('button');
        btnMinus.className = 'btnSmall';
        btnMinus.textContent = '-Δ';

        const btnDel = document.createElement('button');
        btnDel.className = 'btnSmall btnDanger';
        btnDel.textContent = 'Delete';

        actions.appendChild(biasEl);
        actions.appendChild(deltaInput);
        actions.appendChild(btnPlus);
        actions.appendChild(btnMinus);
        actions.appendChild(btnDel);

        rightBox.appendChild(typePill);
        rightBox.appendChild(actions);

        header.appendChild(left);
        header.appendChild(rightBox);

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
        cardsRoot.prepend(section);

        const plus$ = fromEvent(btnPlus, 'click').pipe(
            tap(e => { e.preventDefault(); showSensorFormError(''); }),
            map(() => Math.abs(Number(deltaInput.value || 1))),
            map(d => ({ type: 'adjust', sensorId, delta: +d }))
        );

        const minus$ = fromEvent(btnMinus, 'click').pipe(
            tap(e => { e.preventDefault(); showSensorFormError(''); }),
            map(() => Math.abs(Number(deltaInput.value || 1))),
            map(d => ({ type: 'adjust', sensorId, delta: -d }))
        );

        const del$ = fromEvent(btnDel, 'click').pipe(
            tap(e => { e.preventDefault(); showSensorFormError(''); }),
            map(() => ({ type: 'delete', sensorId }))
        );

        const cardActions$ = merge(plus$, minus$, del$);

        const ui = { section, canvas, logEl, points: [], type, deviceId, titleEl, metaEl, biasEl };
        const meta = sensorsMeta.get(sensorId);
        if (meta) applyMetaToCard(ui, meta);

        addLogLine(logEl, `[open] sensor card created`);
        return { ui, cardActions$ };
    }

    function ensureSensorUI(reading) {
        if (blockedSensors.has(reading.sensorId)) return null;

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
        if (range.kind === 'line') drawLineChart(ui.canvas, ui.points, range.yMin, range.yMax);
        else drawBarChart(ui.canvas, ui.points);
    }

    function onReading(r) {
        const ui = ensureSensorUI(r);
        if (!ui) return;

        if (!typeAllowed(r.type)) return;

        const now = r._t;
        const v = (r.type === 'MOTION') ? (r.value >= 1 ? 1 : 0) : r.value;

        ui.points = keepWindow([...ui.points, { t: now, v }], now);
        redraw(ui);

        const suffix = (r.type === 'THERMOMETER') ? '°C' : '';
        addLogLine(ui.logEl, `[${r.type}] ${formatValue(r)}${suffix} @ ${r.ts}`);
    }

    function refreshVisibility() {
        for (const ui of sensorsUI.values()) {
            ui.section.style.display = typeAllowed(ui.type) ? '' : 'none';
        }
    }

    function genFetch$(path, options) {
        return defer(() => {
            const url = `${GEN_HTTP}${path}`;
            return from(fetch(url, {
                headers: { 'Content-Type': 'application/json' },
                ...options
            }));
        }).pipe(
            mergeMap(res => {
                if (!res.ok) {
                    return from(res.text().catch(() => '')).pipe(
                        mergeMap(text => { throw new Error(`${res.status} ${res.statusText} :: ${text}`); })
                    );
                }
                const ct = res.headers.get('content-type') || '';
                if (ct.includes('application/json')) return from(res.json());
                return of(null);
            })
        );
    }

    function loadSensorsMeta$() {
        return genFetch$('/iot/list', { method: 'GET' }).pipe(
            tap(list => {
                const arr = Array.isArray(list) ? list : [];
                sensorsMeta.clear();
                for (const s of arr) sensorsMeta.set(String(s.id), s);

                for (const [sensorId, ui] of sensorsUI.entries()) {
                    const m = sensorsMeta.get(sensorId);
                    if (m) applyMetaToCard(ui, m);
                }
                console.log('[GEN] sensors loaded:', arr.length);
            }),
            catchError(e => {
                ui$.next({ type: 'toast', level: 'error', text: `Не удалось загрузить список сенсоров: ${e.message}` });
                return EMPTY;
            })
        );
    }

    function adjust$(sensorId, delta) {
        return genFetch$(`/iot/${encodeURIComponent(sensorId)}/adjust?delta=${encodeURIComponent(delta)}`, {
            method: 'POST'
        });
    }

    function deleteSensor$(sensorId) {
        return genFetch$(`/iot/${encodeURIComponent(sensorId)}`, { method: 'DELETE' });
    }

    function createSensorFromForm$() {
        return defer(() => {
            const name = String(inpName?.value || '').trim();
            const type = String(selType?.value || '').trim();
            const deviceId = String(inpDeviceId?.value || '').trim();
            const periodSec = Number(inpPeriodSec?.value);

            if (!name || !type || !deviceId || !(periodSec > 0)) {
                throw new Error('Проверь поля: name/type/deviceId/period');
            }

            if (deviceIdExists(deviceId)) {
                const msg = `Нельзя создать сенсор: deviceId=${deviceId} уже существует`;
                showSensorFormError(msg);
                throw new Error(msg);
            }


            const payload = { name, type, deviceId, period: `PT${periodSec}S` };

            return genFetch$('/iot/add', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        });
    }

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

    const connectClick$ = fromEvent(btnConnect, 'click').pipe(map(() => ({ type: 'connect' })));
    const disconnectClick$ = fromEvent(btnDisconnect, 'click').pipe(map(() => ({ type: 'disconnect' })));
    const reloadClick$ = fromEvent(btnReloadSensors, 'click').pipe(map(() => ({ type: 'reload' })));

    const addOpenClick$ = fromEvent(btnAddSensor, 'click').pipe(
        tap(() => { showSensorFormError(''); dlgSensor && dlgSensor.showModal(); }),
        filter(() => false)
    );

    const addCancelClick$ = btnCancelSensor
        ? fromEvent(btnCancelSensor, 'click').pipe(
            tap((e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dlgSensor) dlgSensor.close();
                if (sensorForm) sensorForm.reset();
                if (inpPeriodSec) inpPeriodSec.value = '1';
                showSensorFormError('');
            }),
            filter(() => false)
        )
        : EMPTY;

    const addSubmit$ = sensorForm
        ? fromEvent(sensorForm, 'submit').pipe(
            tap(e => { e.preventDefault(); showSensorFormError(''); }),
            filter(e => {
                if (e.submitter) return e.submitter === btnCreateSensor;
                return document.activeElement === btnCreateSensor;
            }),
            map(() => ({ type: 'add' }))
        )
        : EMPTY;

    const filters$ = merge(
        fromEvent(fTemp, 'change'),
        fromEvent(fHum, 'change'),
        fromEvent(fMot, 'change')
    ).pipe(
        tap(refreshVisibility),
        filter(() => false)
    );

    const deviceIdHint$ = inpDeviceId
        ? fromEvent(inpDeviceId, 'input').pipe(
            map(() => String(inpDeviceId.value || '').trim()),
            tap(d => {
                if (!dlgSensor || !dlgSensor.open) return;
                if (!d) return showSensorFormError('');
                if (deviceIdExists(d)) showSensorFormError(`deviceId=${d} уже существует`);
                else showSensorFormError('');
            }),
            filter(() => false)
        )
        : EMPTY;


    merge(connectClick$, disconnectClick$, reloadClick$, addSubmit$).subscribe(actions$);

    merge(addOpenClick$, addCancelClick$, filters$, deviceIdHint$).subscribe();

    ui$.pipe(
        filter(x => x.type === 'toast'),
        tap(x => console.log(`[UI:${x.level}] ${x.text}`))
    ).subscribe();

    const session$ = actions$.pipe(
        filter(a => a.type === 'connect'),
        tap(() => {
            setStatus(false, 'CONNECTING...');
            btnConnect.disabled = true;
            btnDisconnect.disabled = false;
            online$.next(true);
        }),
        switchMap(() => {
            const stop$ = actions$.pipe(filter(a => a.type === 'disconnect'));

            const meta$ = loadSensorsMeta$().pipe(takeUntil(stop$));

            const stream$ = sse$('/api/stream').pipe(
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

            const crud$ = actions$.pipe(
                takeUntil(stop$),
                filter(a => a.type === 'reload' || a.type === 'add' || a.type === 'delete' || a.type === 'adjust'),
                mergeMap(a => {
                    if (a.type === 'reload') return loadSensorsMeta$();

                    if (a.type === 'add') {
                        return createSensorFromForm$().pipe(
                            tap(() => {
                                if (dlgSensor) dlgSensor.close();
                                if (sensorForm) sensorForm.reset();
                                if (inpPeriodSec) inpPeriodSec.value = '1';
                                showSensorFormError('');
                            }),
                            switchMap(() => loadSensorsMeta$()),
                            catchError(err => {
                                const raw = String(err?.message || err || '');
                                const msg = (raw.includes('409') || raw.toLowerCase().includes('deviceid'))
                                    ? 'Нельзя создать сенсор: deviceId уже существует'
                                    : `Ошибка создания сенсора: ${raw}`;
                                showSensorFormError(msg);
                                ui$.next({ type: 'toast', level: 'error', text: msg });
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

                    if (a.type === 'adjust') {
                        const sensorId = a.sensorId;
                        const delta = a.delta;
                        const ui = sensorsUI.get(sensorId);

                        return adjust$(sensorId, delta).pipe(
                            tap(json => {
                                if (ui && ui.biasEl && json && typeof json.bias === 'number') {
                                    ui.biasEl.textContent = `bias: ${json.bias.toFixed(2)}`;
                                }
                                if (ui) addLogLine(ui.logEl, `[adjust] delta=${delta} => bias=${json?.bias}`);
                            }),
                            catchError(err => {
                                if (ui) addLogLine(ui.logEl, `[adjust] ERROR: ${err.message}`);
                                ui$.next({ type: 'toast', level: 'error', text: `Ошибка adjust: ${err.message}` });
                                return EMPTY;
                            })
                        );
                    }

                    return EMPTY;
                })
            );

            return merge(meta$, stream$, crud$).pipe(
                finalize(() => {
                    setStatus(false, 'OFFLINE');
                    btnConnect.disabled = false;
                    btnDisconnect.disabled = true;
                    online$.next(false);
                })
            );
        }),
        share()
    );

    session$.subscribe();
    actions$.next({ type: 'connect' });
    online$.pipe(distinctUntilChanged()).subscribe();
})();
