#!/usr/bin/env node
/* =============================================================================
 * console-server.js —— 课表同步 · 本地网页控制台
 * -----------------------------------------------------------------------------
 * 作用：在本机起一个只监听 127.0.0.1 的小服务，把 sync_kcb.js 包成图形界面。
 *       双击 开始同步.bat（或 node console-server.js）会自动打开浏览器。
 *
 * 提供的接口（全部仅本机可访问）：
 *   GET  /                    控制台界面
 *   GET  /kcb                 课程表页面
 *   GET  /api/status          账号 / 课表 / 运行状态
 *   GET  /api/schedule        当前课表全部课程
 *   POST /api/account         保存学号密码
 *   DELETE /api/account       清除已存账号
 *   POST /api/sync            开始同步 { dryRun, noAccount }
 *   GET  /api/stream          SSE 实时日志与进度
 *
 * 参数：
 *   --no-open    启动后不自动打开浏览器
 *   --port N     指定端口（默认 7788）
 * ============================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sync = require('./sync_kcb.js');

process.chdir(__dirname); // 保证 sync_kcb.js 的相对路径都落在项目目录

const HOST = '127.0.0.1';
const UI_FILE = '同步控制台.html';
const argv = process.argv.slice(2);
const argOf = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const PORT = parseInt(argOf('--port'), 10) || 7788;
const AUTO_OPEN = !argv.includes('--no-open');

/* -------------------------------- 运行状态 -------------------------------- */
const STATE_FILE = '.kcb-last-sync.json';
let running = false;
let cancelRequested = false;
let currentPhase = { phase: 'idle', text: '待命' };
const streamClients = new Set();
const logBuffer = [];           // 最近日志，刷新页面后还能看到刚才的过程

function loadLastSync() {
    try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), STATE_FILE), 'utf8')); }
    catch (e) { return null; }
}
function saveLastSync(info) {
    try { fs.writeFileSync(path.join(process.cwd(), STATE_FILE), JSON.stringify(info), 'utf8'); }
    catch (e) { /* 写不进去不影响主流程 */ }
}
let lastSyncInfo = loadLastSync();

function pushLog(line) {
    logBuffer.push(line);
    if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 500);
    broadcast('log', { line });
}

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streamClients) {
        try { res.write(payload); } catch (e) { streamClients.delete(res); }
    }
}

/* -------------------------------- 状态汇总 -------------------------------- */
function readData() {
    try { return sync.readExistingData(path.join(process.cwd(), sync.CONFIG.dataFile)); }
    catch (e) { return null; }
}

function buildStatus() {
    const acc = sync.loadAccount();
    const data = readData();
    const dataPath = path.join(process.cwd(), sync.CONFIG.dataFile);
    let mtime = null;
    try { mtime = fs.statSync(dataPath).mtime.toISOString(); } catch (e) { /* 文件不存在 */ }
    return {
        hasAccount: !!acc,
        user: acc ? acc.user : '',
        running,
        phase: currentPhase,
        courses: data ? data.courses.length : 0,
        semesterStart: data ? data.semester_start : '',
        maxWeek: data ? data.max_week : 0,
        dataUpdated: mtime,
        lastSync: lastSyncInfo,
        rawExists: fs.existsSync(path.join(process.cwd(), sync.CONFIG.rawHtmlFile)),
        backupExists: fs.existsSync(path.join(process.cwd(), sync.CONFIG.backupFile)),
    };
}

/* -------------------------------- 同步执行 -------------------------------- */
async function startSync(body) {
    if (running) return { ok: false, error: '正在同步中，请稍候' };
    running = true;
    cancelRequested = false;
    currentPhase = { phase: 'fetch', text: '准备中' };
    lastSyncInfo = null;
    logBuffer.length = 0;
    broadcast('state', { running: true, phase: currentPhase });

    // 接管脚本日志：终端里也留一份，同时推给网页
    sync.setLogHook(line => { pushLog(line); process.stdout.write(line + '\n'); });
    sync.setEventHook((type, payload) => {
        if (type === 'phase') { currentPhase = payload; broadcast('phase', payload); }
        else if (type === 'diff') { broadcast('diff', payload); }
    });

    try {
        const flags = ['node', 'sync'];
        if (body.dryRun) flags.push('--dry-run');
        if (body.noAccount) flags.push('--no-account');
        // 可选：直接解析已另存的网页（排查用，界面默认不传）
        if (body.html) {
            const safe = path.resolve(process.cwd(), String(body.html));
            if (!safe.startsWith(process.cwd())) throw new Error('只允许解析本项目目录内的文件');
            flags.push('--html', safe);
        }
        const args = sync.parseArgs(flags);
        if (body.timeoutMin) args.timeoutMin = Math.max(1, Math.min(60, Number(body.timeoutMin) || 10));
        // 让抓取循环能听到「取消」：每次轮询都会问一遍
        args.shouldStop = () => cancelRequested;

        const res = await sync.runSync(args);
        lastSyncInfo = {
            time: new Date().toISOString(),
            ok: true,
            written: res.written,
            total: res.diff.added.length + res.diff.removed.length + res.diff.changed.length,
        };
        saveLastSync(lastSyncInfo);
        running = false;
        currentPhase = { phase: 'done', text: res.written ? '同步完成' : '试运行完成' };
        broadcast('state', Object.assign({ running: false }, buildStatus(), { result: lastSyncInfo }));
        return { ok: true };
    } catch (e) {
        lastSyncInfo = { time: new Date().toISOString(), ok: false, message: e.message };
        saveLastSync(lastSyncInfo);
        running = false;
        currentPhase = { phase: 'error', text: e.message };
        pushLog('  ❌ ' + e.message);
        broadcast('state', Object.assign({ running: false, error: e.message }, buildStatus(), { result: lastSyncInfo }));
        return { ok: false, error: e.message };
    } finally {
        cancelRequested = false;
        sync.setLogHook(null);
        sync.setEventHook(null);
    }
}

/* -------------------------------- 静态文件 -------------------------------- */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};
const STATIC_WHITELIST = new Set([
    UI_FILE, '课程表.html', 'kcb-data.js', '教务系统同步-使用说明.md', 'kcb-data-格式说明.md',
]);

function sendFile(res, file) {
    const full = path.join(process.cwd(), file);
    if (!fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(full).pipe(res);
}

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', c => { raw += c; if (raw.length > 1e6) reject(new Error('body too large')); });
        req.on('end', () => {
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
        });
        req.on('error', reject);
    });
}

/* --------------------------------- 路由 ---------------------------------- */
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = decodeURIComponent(url.pathname);

    // 防 DNS rebinding / 跨站：只接受本机来源
    const host = (req.headers.host || '').split(':')[0];
    if (host !== HOST && host !== 'localhost') { res.writeHead(403); return res.end('forbidden'); }

    if (p === '/' || p === '/index') return sendFile(res, UI_FILE);
    if (p === '/kcb' || p === '/课程表.html') return sendFile(res, '课程表.html');
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (p === '/api/status') return sendJson(res, 200, buildStatus());

    // 门户探活：让界面能直接告诉你"学校站点现在开没开"
    if (p === '/api/health') {
        const r = await sync.probeService(sync.CONFIG.portalUrl);
        return sendJson(res, 200, {
            state: r.state, host: r.host, ms: r.ms, detail: r.detail,
            advice: sync.probeAdvice(r),
            checkedAt: new Date().toISOString(),
        });
    }

    if (p === '/api/schedule') {
        const d = readData();
        if (!d) return sendJson(res, 404, { error: '还没有 kcb-data.js' });
        return sendJson(res, 200, {
            courses: d.courses, semester_start: d.semester_start, max_week: d.max_week,
        });
    }

    if (p === '/api/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ running, phase: currentPhase })}\n\n`);
        streamClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 20000);
        req.on('close', () => { clearInterval(ping); streamClients.delete(res); });
        return;
    }

    if (p === '/api/account' && req.method === 'POST') {
        const body = await readBody(req);
        const user = String(body.user || '').trim();
        const pass = String(body.pass || '').trim();
        if (!user || !pass) return sendJson(res, 400, { ok: false, error: '学号和密码都要填' });
        fs.writeFileSync(path.join(process.cwd(), sync.CONFIG.accountFile),
            JSON.stringify({ user, pass }, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, hasAccount: true, user });
    }

    if (p === '/api/account' && req.method === 'DELETE') {
        const f = path.join(process.cwd(), sync.CONFIG.accountFile);
        if (fs.existsSync(f)) fs.unlinkSync(f);
        return sendJson(res, 200, { ok: true, hasAccount: false });
    }

    if (p === '/api/sync' && req.method === 'POST') {
        const body = await readBody(req);
        if (running) return sendJson(res, 409, { ok: false, error: '正在同步中' });
        // 立刻回应，同步在后台跑，进度通过 SSE 推
        sendJson(res, 202, { ok: true, started: true });
        startSync(body).catch(e => {
            // 兜底：绝不让未捕获的异常把整个控制台进程带走
            running = false;
            currentPhase = { phase: 'error', text: e.message };
            pushLog('  ❌ ' + e.message);
            broadcast('state', Object.assign({ running: false, error: e.message }, buildStatus()));
        });
        return;
    }

    if (p === '/api/cancel' && req.method === 'POST') {
        if (!running) return sendJson(res, 200, { ok: true, note: '当前没有进行中的同步' });
        cancelRequested = true;
        pushLog('  ⏹ 收到取消请求，正在关闭浏览器…');
        return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/log') return sendJson(res, 200, { lines: logBuffer });

    // 其余仅放行白名单静态文件
    const name = p.replace(/^\/+/, '');
    if (STATIC_WHITELIST.has(name)) return sendFile(res, name);

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
});

/* -------------------------------- 启动 ----------------------------------- */
function openBrowser(url) {
    try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) { /* 打不开就让用户手动点 */ }
}

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        const url = `http://${HOST}:${PORT}/`;
        console.log(`控制台似乎已经在运行，直接打开：${url}`);
        if (AUTO_OPEN) openBrowser(url);
        setTimeout(() => process.exit(0), 500);
        return;
    }
    console.error('启动失败：', err.message);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/`;
    console.log('');
    console.log('  ┌────────────────────────────────────────────┐');
    console.log('  │   课表同步 · 网页控制台已启动              │');
    console.log('  └────────────────────────────────────────────┘');
    console.log('');
    console.log('   地址：' + url);
    console.log('   （关掉这个窗口即可关闭控制台）');
    console.log('');
    if (AUTO_OPEN) setTimeout(() => openBrowser(url), 300);
});

process.on('SIGINT', () => { console.log('\n控制台已关闭。'); process.exit(0); });

// 任何漏网异常都只记录、不退出——控制台崩了用户就只能干瞪眼
process.on('uncaughtException', e => {
    console.error('[未捕获异常]', (e && e.stack) || e);
});
process.on('unhandledRejection', e => {
    console.error('[未处理拒绝]', (e && e.stack) || e);
});
