(() => {
    const { Observable, Subject } = rxjs;
    const { map, tap, filter, scan, share, takeUntil } = rxjs.operators;

    const btnConnect = document.getElementById('btnConnect');
    const btnDisconnect = document.getElementById('btnDisconnect');
    const statusEl = document.getElementById('status');

    const fTemp = document.getElementById('fTemp');
    const fHum  = document.getElementById('fHum');
    const fMot  = document.getElementById('fMot');

    const tbody = document.getElementById('tbody');
    const logEl = document.getElementById('log');

    const disconnect$ = new Subject();

    function setStatus(online, text) {
        statusEl.textContent = text;
        statusEl.classList.toggle('ok', online);
        statusEl.classList.toggle('bad', !online);
    }

    function sse$(url) {
        // Observable, который “реактивно” оборачивает EventSource
        return new Observable(subscriber => {
            const es = new EventSource(url);

            es.onopen = () => subscriber.next({ __type: 'open' });

            es.onmessage = (evt) => {
                subscriber.next({ __type: 'message', data: evt.data });
            };

            es.onerror = (err) => {
                subscriber.next({ __type: 'error', err });
            };

            return () => es.close();
        });
    }

    function parseReading(jsonStr) {
        // Spring SSE отдаёт JSON строкой в data
        const r = JSON.parse(jsonStr);

        // На всякий случай: value может быть int/double — приводим к number
        r.value = Number(r.value);

        // ts — ISO string, оставим как есть для отображения
        return r;
    }

    function typeAllowed(type) {
        if (type === 'THERMOMETER') return fTemp.checked;
        if (type === 'HUMIDITY') return fHum.checked;
        if (type === 'MOTION') return fMot.checked;
        return true;
    }

    function formatValue(r) {
        if (r.type === 'MOTION') return String(r.value); // 0/1
        // temp/humidity красиво с 1 знаком
        return r.value.toFixed(1);
    }

    function addLogLine(text) {
        const div = document.createElement('div');
        div.className = 'logline mono';
        div.textContent = text;

        logEl.prepend(div);

        // держим максимум 200 строк
        while (logEl.childNodes.length > 200) {
            logEl.removeChild(logEl.lastChild);
        }
    }

    function renderTable(latestMap) {
        // latestMap: { sensorId: Reading }
        const rows = Object.values(latestMap)
            .sort((a, b) => (a.sensorId > b.sensorId ? 1 : -1));

        tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="mono">${r.sensorId}</td>
        <td class="mono">${r.deviceId}</td>
        <td>${r.type}</td>
        <td class="mono">${formatValue(r)}</td>
        <td class="mono">${r.ts}</td>
      </tr>
    `).join('');
    }

    function connect() {
        disconnect$.next(); // на всякий случай закрыть прошлое

        setStatus(false, 'CONNECTING...');
        btnConnect.disabled = true;
        btnDisconnect.disabled = false;

        const stream$ = sse$('/api/stream').pipe(
            takeUntil(disconnect$),
            tap(evt => {
                if (evt.__type === 'open') {
                    setStatus(true, 'ONLINE');
                    addLogLine(`[open] connected`);
                }
                if (evt.__type === 'error') {
                    // EventSource сам будет пытаться реконнектиться.
                    setStatus(false, 'RECONNECTING...');
                    addLogLine(`[error] reconnecting...`);
                }
            }),
            filter(evt => evt.__type === 'message'),
            map(evt => parseReading(evt.data)),
            filter(r => typeAllowed(r.type)),
            share()
        );

        // Лог — реактивный
        stream$.subscribe(r => {
            addLogLine(`[${r.type}] sensor=${r.sensorId} value=${formatValue(r)} ts=${r.ts}`);
        });

        // Latest-per-sensor — реактивно через scan
        stream$.pipe(
            scan((acc, r) => {
                // создаём новый объект, чтобы ререндер был простым
                return { ...acc, [r.sensorId]: r };
            }, {})
        ).subscribe(latestMap => {
            renderTable(latestMap);
        });
    }

    function disconnect() {
        disconnect$.next();
        setStatus(false, 'OFFLINE');
        btnConnect.disabled = false;
        btnDisconnect.disabled = true;
        addLogLine(`[close] disconnected`);
    }

    btnConnect.addEventListener('click', connect);
    btnDisconnect.addEventListener('click', disconnect);

    // Автоподключение при загрузке
    connect();
})();
