#!/usr/bin/env node
/* =============================================================================
 * sync_kcb.js —— 教务系统课表同步脚本（四川工业科技学院 · 正方系统）
 * -----------------------------------------------------------------------------
 * 作用：从学校教务系统抓取「课表查询」页面，解析成课程数组，
 *       自动生成/更新同目录的 kcb-data.js（课程表.html 的数据源）。
 *       每次同步会输出「调课变更报告」，换教室/调课一目了然。
 *
 * 为什么需要这个脚本：
 *   教务系统要登录（学号+密码+验证码）、没有开放 API、且浏览器有同源策略，
 *   所以 课程表.html 这类网页无法"直接连"教务系统，只能靠本机脚本当桥梁。
 *
 * 用法（在课程表目录下执行）：
 *   node sync_kcb.js --save-account           先存一次学号密码（存本机，之后自动登录）
 *   node sync_kcb.js                          模式一：Playwright 全自动（推荐）
 *                                               有账号 → 自动填表登录（遇验证码补一下）；
 *                                               无账号 → 手动登录一次，登录态自动复用。
 *   node sync_kcb.js --cookie "JSESSIONID=xx" --url "http://jwgl.scit.cn/jsxsd/xskb/xskb_list.do"
 *                                              模式二：Cookie 轻量抓取
 *   node sync_kcb.js --html kcb_raw.html      模式三：解析本地 HTML（零依赖兜底）
 *
 * 通用参数：
 *   --dry-run              只解析并打印报告，不写文件
 *   --debug                打印每个单元格的原始文本（解析错位时用）
 *   --no-account           本次忽略已保存的账号，改用手动登录
 *   --force                跳过"门户探活"直接打开浏览器（怀疑误判时用）
 *   --semester-start DATE  覆盖开学日期，如 2027-02-27（默认继承现有 kcb-data.js）
 *   --max-week N           覆盖学期总周数（默认继承现有 kcb-data.js）
 *   --timeout-min N        模式一等待的超时分钟数（默认 10）
 * ============================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------------ 可配置项 ---------------------------------- */
const CONFIG = {
    // 教务系统（正方 eas.scit.cn）——课表的真正来源，直接登录这里
    jwglUrl: 'https://eas.scit.cn',
    // 融合门户（登录后可进办事大厅；教务系统不走它的单点登录，仅作兜底入口）
    portalUrl: 'https://ai.scit.cn',
    // 正方系统课表查询页常见路径（模式二按顺序尝试，也可用 --url 指定）
    schedulePaths: [
        '/jsxsd/xskb/xskb_list.do',
        '/jwglxt/xskb/xskb_list.do',
        '/xskbcx.aspx',
    ],
    rawHtmlFile: 'kcb_raw.html',        // 抓取下来的原始课表页 HTML
    dataFile: 'kcb-data.js',            // 生成的数据文件
    backupFile: 'kcb-data.js.bak',      // 覆盖前的备份
    userDataDir: '.kcb-browser-profile',// Playwright 登录态保存目录
    accountFile: '.kcb-account.json',   // 学号密码（明文本地保存，勿外传/勿提交 git）
};

/* ------------------------------ 参数解析 ---------------------------------- */
function parseArgs(argv) {
    const args = { dryRun: false, debug: false, cookie: '', url: '', html: '', timeoutMin: 10, semesterStart: '', maxWeek: 0, saveAccount: false, noAccount: false, force: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--debug') args.debug = true;
        else if (a === '--save-account') args.saveAccount = true;
        else if (a === '--no-account') args.noAccount = true;
        else if (a === '--force') args.force = true;
        else if (a === '--cookie') args.cookie = argv[++i] || '';
        else if (a === '--url') args.url = argv[++i] || '';
        else if (a === '--html') args.html = argv[++i] || '';
        else if (a === '--timeout-min') args.timeoutMin = parseInt(argv[++i], 10) || 10;
        else if (a === '--semester-start') args.semesterStart = argv[++i] || '';
        else if (a === '--max-week') args.maxWeek = parseInt(argv[++i], 10) || 0;
    }
    return args;
}

/* --------------------------- 工具：终端彩色输出 ---------------------------- */
// cmd 默认控制台对 ANSI 支持一般，设置 NO_COLOR=1 可关闭颜色（bat 启动时已设）
const NO_COLOR = !!process.env.NO_COLOR;
const paint = (code, s) => NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`;
const C = {
    red: s => paint(31, s), green: s => paint(32, s),
    yellow: s => paint(33, s), blue: s => paint(34, s),
    cyan: s => paint(36, s), gray: s => paint(90, s),
    bold: s => paint(1, s),
};

/* ------------------- 日志出口（可被前端控制台接管） -----------------------
 * 默认打到终端；被 console-server.js 接管后，每行实时推给网页界面。
 * 另外支持结构化事件（进度/阶段），用 setEventHook 注入。
 * ------------------------------------------------------------------------ */
let LOG_HOOK = null;
let EVENT_HOOK = null;
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
function setLogHook(fn) { LOG_HOOK = typeof fn === 'function' ? fn : null; }
function setEventHook(fn) { EVENT_HOOK = typeof fn === 'function' ? fn : null; }
function emitEvent(type, payload) { if (EVENT_HOOK) EVENT_HOOK(type, payload || {}); }
function log(...args) {
    const text = args.join(' ');
    if (LOG_HOOK) { LOG_HOOK(stripAnsi(text)); return; }
    process.stdout.write(text + '\n');
}

/* ============================================================================
 * 一、课表 HTML 解析器（正方系统结构，带容错）
 * ========================================================================== */
let cheerioLoad = null;
function loadCheerio() {
    if (!cheerioLoad) {
        const mod = require('cheerio');
        cheerioLoad = typeof mod === 'function' ? mod : mod.load; // cheerio 1.x 导出 { load }
    }
    return cheerioLoad;
}

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

/** 在整页 HTML 里找"最像课表"的表格：表头含 星期一~星期日，且单元格数量最多 */
function findScheduleTable($) {
    let best = null, bestScore = 0;
    $('table').each((_, t) => {
        const $t = $(t);
        const rows = $t.find('tr');
        if (rows.length < 4) return;
        // 表头可能占前两行（标题行 + 星期行），合并判断
        const headerText = rows.toArray().slice(0, 2)
            .map(tr => $(tr).find('th,td').map((i, el) => $(el).text().trim()).get().join(' '))
            .join(' ');
        const hasDayHeader = /星期[一二三四五六日]|周[一二三四五六日]/.test(headerText);
        if (!hasDayHeader) return;
        const score = $t.find('td').length + (hasDayHeader ? 100 : 0);
        if (score > bestScore) { bestScore = score; best = $t; }
    });
    return best;
}

/** 表头列索引 → 星期几（1=周一）。返回 Map<列索引, day> */
function mapDayColumns($, $table) {
    const rows = $table.find('tr').toArray().slice(0, 2); // 表头可能是前两行
    const colToDay = new Map();
    for (const tr of rows) {
        $(tr).find('th,td').each((i, el) => {
            const text = $(el).text().replace(/\s/g, '');
            const m = text.match(/(?:星期|周)([一二三四五六日])/);
            if (m) colToDay.set(i, DAY_NAMES.indexOf(m[1]) + 1);
        });
    }
    return colToDay;
}

/** 把单元格 HTML 拆成多行文本（按 <br> 和块级标签） */
function splitCellLines($, td) {
    let html = $(td).html() || '';
    html = html.replace(/<(div|p|tr|li)[^>]*>/gi, '<br>');
    return html
        .split(/<br\s*\/?>/i)
        .map(s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim())
        .filter(s => s.length > 0);
}

/** 周次文本归一化："第2-4,6周" / "2-18(双)" / "２－４" → "2-4,6" / "2-18双" */
function normalizeWeeks(raw) {
    if (!raw) return '';
    let s = String(raw)
        .replace(/[（）()]/g, m => (m === '（' || m === '(' ? '(' : ')'))
        .replace(/第|周|节/g, '')
        .replace(/[~～—–]/g, '-')
        .replace(/\s+/g, '')
        .replace(/星期.*$/, '');
    // "2-18(双)" / "2-18双" → "2-18双"
    s = s.replace(/\((\d+)(单|双)\)/g, '$1$2').replace(/\((\d+)-(\d+)(单|双)\)/g, '$1-$2$3');
    // 去掉括号
    s = s.replace(/[()]/g, '');
    // 中文顿号/斜杠 → 逗号
    s = s.replace(/[、/]/g, ',');
    return s;
}

/** 判断一行文本是不是"周次行" */
function looksLikeWeeks(text) {
    return /(^|[^0-9])\d{1,2}\s*-\s*\d{1,2}/.test(text) && /周|单|双|周次/.test(text)
        || /^\d{1,2}(-\d{1,2})?(单|双)?(,\d{1,2}(-\d{1,2})?(单|双)?)*$/.test(text);
}

/** 判断一行文本是不是"教室行" */
function looksLikeRoom(text) {
    return /毓秀|汽实|教学楼|[A-Za-z]\d{3,4}|操场|机房|实验室|\d+楼|第?\d+室/.test(text);
}

/** 判断一行文本是不是"教师行"（注意：含数字的一律不是人名，避免误杀"周艳梅"这类姓名） */
function looksLikeTeacher(text) {
    if (/\d/.test(text)) return false;                       // 含数字 → 是周次/教室行
    if (/毓秀|汽实|操场|教学楼|实验室|机房|楼|室/.test(text)) return false;
    return /老师$|教授$|讲师$|副教授$|助教$/.test(text) || /^[\u4e00-\u9fa5]{2,4}$/.test(text);
}

/** 解析单个课程单元格 → course 对象（可能一格多门课，返回数组） */
function parseCourseCell($, td, day, start, span) {
    const lines = splitCellLines($, td);
    if (lines.length === 0) return [];
    const courses = [];
    let cur = null;
    for (const line of lines) {
        const w = normalizeWeeks(line);
        if (cur && looksLikeWeeks(line)) { cur.weeks = w; continue; }
        if (cur && cur.weeks && !cur.room && looksLikeRoom(line)) { cur.room = line; continue; }
        if (cur && !cur.teacher && looksLikeTeacher(line)) { cur.teacher = line; continue; }
        if (cur && !cur.room && looksLikeRoom(line)) { cur.room = line; continue; }
        // 新课程名（清理调课/合班标记）
        const name = line.replace(/^\[.*?\]|【.*?】|\(调\)|（调）/g, '').trim();
        if (!name) continue;
        cur = { day, start, span, name, teacher: '', room: '', weeks: '1-18' };
        courses.push(cur);
    }
    return courses;
}

/** 主解析入口：整页 HTML → { courses, semesterText, tableFound } */
function parseScheduleHtml(html, debug = false) {
    const $ = loadCheerio()(html);
    const $table = findScheduleTable($);
    if (!$table) {
        return { courses: [], semesterText: '', tableFound: false };
    }
    // 学期信息（页面上"2026-2027学年 第1学期"之类的文本）
    const pageText = $('body').text().replace(/\s+/g, ' ');
    const semM = pageText.match(/(\d{4}-\d{4}学年[^,，;；]{0,12}学期)/);
    const semesterText = semM ? semM[1].trim() : '';

    const colToDay = mapDayColumns($, $table);
    const rows = $table.find('tr').toArray();
    const courses = [];
    const occupied = new Map(); // "row,col" → true（被 rowspan 占用）
    let rowIdx = 0;

    for (const tr of rows) {
        const cells = $(tr).find('td').toArray();
        if (cells.length === 0) continue; // 跳过表头行/说明行
        rowIdx++;
        // 行首单元格一般是节次信息（"1-2" / "第3-4节" / "上午1-2节"），决定本行起始节次
        const firstText = $(cells[0]).text().replace(/\s/g, '');
        // 表头行（星期一是 td 而非 th 的版本）与"上午/下午"分组行：首列没有节次数字，跳过。
        // 不跳过的话，"星期一"会被当成一门课名解析出来。
        if (!/\d/.test(firstText)) continue;
        let rowStart = rowIdx, rowSpan = 1;
        const mRange = firstText.match(/(\d{1,2})\s*[-~—–]\s*(\d{1,2})/);
        if (mRange) { rowStart = +mRange[1]; rowSpan = +mRange[2] - +mRange[1] + 1; }
        else {
            const mSingle = firstText.match(/(\d{1,2})/);
            if (mSingle) { rowStart = +mSingle[1]; rowSpan = 1; }
        }
        let col = 0;
        for (const td of cells) {
            // 跳过被上方 rowspan 占用的列
            while (occupied.get(`${rowIdx},${col}`)) col++;
            const day = colToDay.get(col);
            const rs = parseInt($(td).attr('rowspan') || '1', 10);
            const span = !isNaN(rs) && rs > 1 ? rs : rowSpan;
            if (day) {
                const parsed = parseCourseCell($, td, day, rowStart, span);
                if (debug && parsed.length) {
                    log(C.gray(`  [调试] 行${rowIdx} 列${col}(周${'一二三四五六日'[day - 1]}) span=${span} 原文: `) +
                        JSON.stringify(splitCellLines($, td)));
                }
                courses.push(...parsed);
            }
            // 登记 rowspan 占用
            if (rs > 1) {
                for (let r = 1; r < rs; r++) {
                    for (let c = col; c < col + (parseInt($(td).attr('colspan') || '1', 10) || 1); c++) {
                        occupied.set(`${rowIdx + r},${c}`, true);
                    }
                }
            }
            col += parseInt($(td).attr('colspan') || '1', 10) || 1;
        }
    }
    return { courses, semesterText, tableFound: true };
}

/* ============================================================================
 * 二、周次工具与 diff
 * ========================================================================== */
/** "2-4,6,8-16单" → Set{2,3,4,6,8,9,...} */
function expandWeeks(weeksStr) {
    const set = new Set();
    if (!weeksStr) return set;
    for (const part of String(weeksStr).split(',')) {
        const p = part.trim();
        if (!p) continue;
        let m = p.match(/^(\d+)(?:-(\d+))?(单|双)?$/);
        if (!m) continue;
        const a = +m[1], b = m[2] ? +m[2] : a;
        const parity = m[3];
        for (let w = a; w <= b; w++) {
            if (parity === '单' && w % 2 === 0) continue;
            if (parity === '双' && w % 2 === 1) continue;
            set.add(w);
        }
    }
    return set;
}

function weeksEqual(a, b) {
    const sa = expandWeeks(a), sb = expandWeeks(b);
    if (sa.size !== sb.size) return false;
    for (const w of sa) if (!sb.has(w)) return false;
    return true;
}

const courseKey = c => `${c.day}|${c.start}|${c.span}|${c.name}`;
const courseLabel = c =>
    `周${'一二三四五六日'[c.day - 1]} 第${c.start}${c.span > 1 ? '-' + (c.start + c.span - 1) : ''}节 《${c.name}》`;

/** 对比新旧课表，输出变更报告 */
function diffCourses(oldArr, newArr) {
    const oldMap = new Map(oldArr.map(c => [courseKey(c), c]));
    const newMap = new Map(newArr.map(c => [courseKey(c), c]));
    const added = [], removed = [], changed = [];
    for (const [k, c] of newMap) {
        if (!oldMap.has(k)) added.push(c);
        else {
            const o = oldMap.get(k);
            const diffs = [];
            if (!weeksEqual(o.weeks, c.weeks)) diffs.push(`周次 ${o.weeks || '全'} → ${c.weeks || '全'}`);
            if ((o.teacher || '') !== (c.teacher || '')) diffs.push(`教师 ${o.teacher || '?'} → ${c.teacher || '?'}`);
            if ((o.room || '') !== (c.room || '')) diffs.push(`教室 ${o.room || '?'} → ${c.room || '?'}`);
            if (diffs.length) changed.push({ course: c, diffs });
        }
    }
    for (const [k, c] of oldMap) if (!newMap.has(k)) removed.push(c);
    return { added, removed, changed };
}

function printDiffReport(diff) {
    const { added, removed, changed } = diff;
    if (!added.length && !removed.length && !changed.length) {
        log(C.green('  ✅ 与现有课表完全一致，无调课变化'));
        return;
    }
    for (const c of added) log(C.blue(`  🔵 新增：${courseLabel(c)} ${c.teacher} ${c.room} [${c.weeks}]`));
    for (const c of removed) log(C.red(`  🔴 删除：${courseLabel(c)} ${c.teacher} ${c.room} [${c.weeks}]`));
    for (const { course: c, diffs } of changed) {
        log(C.yellow(`  🟡 变更：${courseLabel(c)}`));
        for (const d of diffs) log(C.yellow(`         ${d}`));
    }
    const total = added.length + removed.length + changed.length;
    log(C.bold(`  📊 共 ${total} 处变化（新增 ${added.length} / 删除 ${removed.length} / 变更 ${changed.length}）`));
}

/** 把 diff 转成前端友好的结构（给网页控制台用） */
function serializeDiff(diff) {
    const lab = c => ({
        day: c.day, dayName: '一二三四五六日'[c.day - 1],
        start: c.start, span: c.span,
        time: `第${c.start}${c.span > 1 ? '-' + (c.start + c.span - 1) : ''}节`,
        name: c.name, teacher: c.teacher || '', room: c.room || '', weeks: c.weeks || '',
    });
    return {
        added: diff.added.map(lab),
        removed: diff.removed.map(lab),
        changed: diff.changed.map(x => Object.assign(lab(x.course), { diffs: x.diffs })),
        total: diff.added.length + diff.removed.length + diff.changed.length,
    };
}

/* ============================================================================
 * 三、读取 / 生成 kcb-data.js
 * ========================================================================== *//** 在 vm 沙箱里执行现有 kcb-data.js，取出 KCB_DATA（拿它的作息/分组配置） */
function readExistingData(file) {
    if (!fs.existsSync(file)) return null;
    try {
        const code = fs.readFileSync(file, 'utf8');
        const sandbox = { window: {} };
        vm.runInNewContext(code, sandbox, { timeout: 3000 });
        return sandbox.window.KCB_DATA || null;
    } catch (e) {
        log(C.yellow(`  ⚠️ 读取现有 ${file} 失败（${e.message}），将使用默认作息配置`));
        return null;
    }
}

function generateKcbDataJs(data) {
    const lines = [];
    lines.push('/* ================================================================');
    lines.push(' * KCB 校历配置插件文件（由 sync_kcb.js 自动生成于 ' + new Date().toLocaleString('zh-CN') + '）');
    lines.push(' * ----------------------------------------------------------------');
    lines.push(' * 数据来源：学校教务系统课表查询页；手动修改会被下次同步覆盖，');
    lines.push(' * 如需长期手改，请改用课程表.html 内嵌校历。');
    lines.push(' * 用法：与 课程表.html 同目录即生效；删除本文件回退内置校历。');
    lines.push(' * ================================================================ */');
    lines.push('(function (g) {');
    lines.push('    g.KCB_DATA = {');
    lines.push(`        synced_at: '${new Date().toISOString()}',`);
    lines.push('        courses: [');
    for (const c of data.courses) {
        lines.push(`            { day: ${c.day}, start: ${c.start}, span: ${c.span}, name: '${c.name.replace(/'/g, "\\'")}', teacher: '${(c.teacher || '').replace(/'/g, "\\'")}', room: '${(c.room || '').replace(/'/g, "\\'")}', weeks: '${c.weeks}' },`);
    }
    lines.push('        ],');
    lines.push(`        semester_start: '${data.semester_start}',`);
    lines.push(`        max_week: ${data.max_week},`);
    lines.push('        normal_times: {');
    const nt = Object.entries(data.normal_times);
    for (let i = 0; i < nt.length; i += 2) {
        const chunk = nt.slice(i, i + 2).map(([k, v]) => `${k}: { start: '${v.start}', end: '${v.end}' }`);
        lines.push('            ' + chunk.join(', ') + (i + 2 < nt.length ? ',' : ''));
    }
    lines.push('        },');
    const sp = Object.entries(data.special_pm_times || {});
    lines.push('        special_pm_times: {');
    for (let i = 0; i < sp.length; i += 2) {
        const chunk = sp.slice(i, i + 2).map(([k, v]) => `${k}: { start: '${v.start}', end: '${v.end}' }`);
        lines.push('            ' + chunk.join(', ') + (i + 2 < sp.length ? ',' : ''));
    }
    lines.push('        },');
    lines.push('        period_labels: [');
    for (const p of data.period_labels) {
        lines.push(`            { label: '${p.label}', icon: '${p.icon}', periods: [${p.periods.join(', ')}] },`);
    }
    lines.push('        ]');
    lines.push('    };');
    lines.push('})(window);');
    return lines.join('\n') + '\n';
}

/* ============================================================================
 * 三·五、学号密码自动登录（可选增强）
 *   密码只存在本机 .kcb-account.json，由脚本读取后交给真实浏览器填表，
 *   绝不写进 课程表.html（网页里做登录框会被 CORS/SameSite 挡住，且有泄密风险）。
 * ========================================================================== */
const readline = require('readline');

function loadAccount() {
    const f = path.join(process.cwd(), CONFIG.accountFile);
    if (!fs.existsSync(f)) return null;
    try {
        const acc = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (acc.user && acc.pass) return acc;
    } catch (e) {
        log(C.yellow(`  ⚠️ ${CONFIG.accountFile} 格式有误，已忽略（应为 {"user":"学号","pass":"密码"}）`));
    }
    return null;
}

/** 交互式录入账号密码并保存到本机（可复用外部传入的 readline 实例） */
async function promptSaveAccount(rl, ask) {
    const own = !rl;
    if (!rl) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        ask = q => new Promise(res => rl.question(q, res));
    }
    log(C.bold('\n🔐 保存教务系统账号（仅存本机 ' + CONFIG.accountFile + '，不会上传任何地方）\n'));
    const user = (await ask('  学号/工号：')).trim();
    const pass = (await ask('  密码（输入时会明文显示，注意身后没人）：')).trim();
    if (own) rl.close();
    if (!user || !pass) { log(C.yellow('  未输入完整，已取消。')); return; }
    fs.writeFileSync(path.join(process.cwd(), CONFIG.accountFile), JSON.stringify({ user, pass }, null, 2), 'utf8');
    log(C.green(`  ✅ 已保存到 ${CONFIG.accountFile}（备份/分享项目时请排除它）\n`));
}

/** 判断当前页是不是登录页（有可见的密码框） */
async function isLoginPage(page) {
    try {
        return await page.evaluate(() => {
            const pw = document.querySelector('input[type="password"]');
            if (!pw) return false;
            const r = pw.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
    } catch (e) { return false; }
}

/** 从登录页上抓一句错误提示（密码错、验证码错、账号锁定之类），抓不到就返回空串 */
async function readLoginError(page) {
    try {
        return await page.evaluate(() => {
            const sels = ['.el-message', '.el-message__content', '.ant-message-notice-content',
                '.error', '.err-msg', '.error-msg', '[class*="error"]', '[class*="tip"]'];
            for (const s of sels) {
                for (const el of document.querySelectorAll(s)) {
                    const t = (el.innerText || el.textContent || '').trim();
                    if (t && t.length <= 60 && /错|失败|不正确|已锁定|过期|验证码|不存在|为空|必填/.test(t)) return t;
                }
            }
            const body = (document.body.innerText || '').replace(/\s+/g, ' ');
            const m = body.match(/[^。\n]{0,18}(密码|验证码|账号|用户)[^。\n]{0,18}(错误|不正确|失败|已锁定|过期|不存在|为空|必填)[^。\n]{0,10}/);
            return m ? m[0].trim() : '';
        });
    } catch (e) { return ''; }
}

/**
 * 精确点击「登录」按钮。
 * 坑：登录框顶部有「账号登录 / 扫码登录」两个标签页，模糊匹配 /登录/ 会先命中
 * `<span>账号登录</span>`，点它只会把表单重新渲染并清空输入 —— 永远提交不了。
 * 所以这里只认真实的 <button>，且文字必须完全等于「登录」。
 */
async function clickLoginButton(page) {
    const STRATEGIES = [
        () => page.getByRole('button', { name: /^\s*登\s*录\s*$/ }),
        () => page.locator('button.el-button--primary', { hasText: /^\s*登\s*录\s*$/ }),
        () => page.locator('button', { hasText: /^\s*登\s*录\s*$/ }),
    ];
    for (const make of STRATEGIES) {
        try {
            const loc = make();
            const n = await loc.count();
            for (let i = 0; i < n; i++) {
                const el = loc.nth(i);
                if (!(await el.isVisible().catch(() => false))) continue;
                const t = (await el.innerText().catch(() => '')).trim();
                if (/扫码|账号登录|忘记|注册|新用户/.test(t)) continue;
                await el.click({ timeout: 4000 });
                return t || '登录';
            }
        } catch (e) { /* 换下一个策略 */ }
    }
    return '';
}

/** 回读输入框，确认账号密码真的填进去了（框架偶尔会吞掉赋值） */
async function readFilledValues(page) {
    try {
        return await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            const pw = inputs.find(i => i.type === 'password');
            const text = inputs.find(i => {
                const r = i.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && ['text', 'tel', 'number', ''].includes((i.type || '').toLowerCase());
            });
            return { user: text ? text.value : '', pass: pw ? pw.value : '' };
        });
    } catch (e) { return { user: '', pass: '' }; }
}

/** 查登录页有没有验证码（输入框 / 验证码图片 + "验证码"字样），返回 {index, hasImg, text} */
async function findCaptcha(page) {
    try {
        return await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            const index = inputs.findIndex(el => {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                const sig = `${el.placeholder || ''} ${el.name || ''} ${el.id || ''} ${el.className || ''}`;
                return /验证码|captcha|checkcode|verifycode|vcode/i.test(sig);
            });
            const hasImg = Array.from(document.querySelectorAll('img')).some(im => {
                const r = im.getBoundingClientRect();
                return r.width >= 30 && r.width <= 220 && r.height >= 14 && r.height <= 90
                    && /captcha|checkcode|verify|vcode/i.test(im.src || '');
            });
            return { index, hasImg, text: /验证码/.test(document.body.innerText || '') };
        });
    } catch (e) { return { index: -1, hasImg: false, text: false }; }
}

/** 用真实鼠标点击课表入口。SPA 只认真实事件，evaluate 里的 el.click() 往往点了没反应 */
async function clickScheduleEntry(page) {
    const LABELS = [/^\s*查看课表\s*$/, /^\s*今日课表\s*$/, /^\s*课表查询\s*$/, /^\s*我的课表\s*$/, /^\s*学生课表\s*$/];
    for (const re of LABELS) {
        try {
            const loc = page.getByText(re).first();
            if ((await loc.count()) === 0) continue;
            if (!(await loc.isVisible().catch(() => false))) continue;
            const label = (await loc.innerText().catch(() => '')).trim();
            await loc.click({ timeout: 3500 });
            await page.waitForTimeout(1500);
            return label || String(re);
        } catch (e) { /* 试下一个 */ }
    }
    return '';
}

/** 记住上次成功抓到课表的页面地址，下次直接跳过去 */
function readScheduleUrl() {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.kcb-schedule-url.json'), 'utf8'));
        return j && j.url ? j.url : '';
    } catch (e) { return ''; }
}
function writeScheduleUrl(url) {
    if (!url || /^about:blank/.test(url)) return;
    try {
        fs.writeFileSync(path.join(process.cwd(), '.kcb-schedule-url.json'),
            JSON.stringify({ url, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch (e) { /* 记住失败不影响本次同步 */ }
}

/** 连续失败计数：防止自动登录反复试错把账号锁掉 */
function readLoginState() {
    try {
        return JSON.parse(fs.readFileSync(path.join(process.cwd(), '.kcb-login-state.json'), 'utf8')) || { fails: 0 };
    } catch (e) { return { fails: 0 }; }
}
function writeLoginState(state) {
    try {
        fs.writeFileSync(path.join(process.cwd(), '.kcb-login-state.json'), JSON.stringify(state, null, 2), 'utf8');
    } catch (e) { /* 写不了就算了，不影响同步 */ }
}

/**
 * 自动填表登录。返回：
 *   'filled'  → 已填并点了登录，接下来等跳转
 *   'captcha' → 已填账号密码，但页面有验证码，需要人工补一下
 *   'skip'    → 不是登录页（可能已登录）
 * 说明：用真实浏览器执行，页面若有 JS 加密/打码也能正常走。
 */
async function autoFillLogin(page, acc) {
    if (!(await isLoginPage(page))) return 'skip';

    // 1) 先填密码（Playwright 原生键盘输入，兼容 Vue/React 受控组件）
    const pwInput = page.locator('input[type="password"]').first();
    await pwInput.click({ timeout: 5000 }).catch(() => {});
    await pwInput.fill('', { timeout: 5000 }).catch(() => {});
    await pwInput.type(acc.pass, { delay: 25 });

    // 2) 找密码框之前最近的文本输入框填学号（原生 setter + input 事件，兼容框架）
    await page.evaluate((user) => {
        const pw = document.querySelector('input[type="password"]');
        if (!pw) return;
        const inputs = Array.from(document.querySelectorAll('input'));
        const idx = inputs.indexOf(pw);
        for (let i = idx - 1; i >= 0; i--) {
            const t = (inputs[i].type || 'text').toLowerCase();
            if (['text', 'tel', 'number', ''].includes(t)) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(inputs[i], user);
                inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
        }
    }, acc.user);

    // 3) 检测验证码：有就**绝不盲提交**（盲提交只会白白消耗登录次数、还可能锁账号）
    const cap = await findCaptcha(page);
    if (cap.index >= 0 || (cap.hasImg && cap.text)) {
        if (cap.index >= 0) {
            await page.locator('input').nth(cap.index).click({ timeout: 3000 }).catch(() => {});
        }
        return 'captcha';
    }

    // 4) 提交前回读：确认账号密码真的在框里，别把一个空表单发出去
    let filled = await readFilledValues(page);
    if (!filled.pass) {
        // 塞不进去（受控组件把赋值吞了）：改用真实键盘输入
        await pwInput.click({ timeout: 4000 }).catch(() => {});
        await pwInput.pressSequentially(acc.pass, { delay: 30 }).catch(() => {});
        filled = await readFilledValues(page);
    }
    if (!filled.pass) return 'nofill';

    // 5) 点登录按钮（必须精确匹配，别点到「账号登录」标签页）
    const clicked = await clickLoginButton(page);
    if (!clicked) return 'nobtn';
    return 'filled';
}

/**
 * 正方教务系统登录页（eas.scit.cn/default2.aspx）自动填表。
 * 字段：txtUserName 学号 / TextBox2 密码 / txtSecretCode 验证码 / RadioButtonList1 身份 / Button1 登录
 * 注意：密码由页面自己的 JS 做 RSA 加密，所以必须用真实输入 + 点按钮，不能自己拼请求。
 * 验证码基本每次登录都要填，所以这里填完账号密码就把光标放到验证码框，交给人补 4 位。
 */
async function autoFillZhengfang(page, acc) {
    const userBox = page.locator('#txtUserName');
    if ((await userBox.count().catch(() => 0)) === 0) return 'skip';

    // 身份选「学生」
    await page.locator('#RadioButtonList1_2').check({ timeout: 3000 }).catch(() => {});
    await userBox.fill(acc.user, { timeout: 5000 }).catch(() => {});
    await page.locator('#TextBox2').fill(acc.pass, { timeout: 5000 }).catch(() => {});

    const capBox = page.locator('#txtSecretCode');
    if ((await capBox.count().catch(() => 0)) > 0) {
        await capBox.click({ timeout: 3000 }).catch(() => {});
        return 'captcha';   // 验证码交给人填，填完点【登录】
    }
    const btn = page.locator('#Button1');
    if ((await btn.count().catch(() => 0)) > 0) {
        await btn.click({ timeout: 4000 }).catch(() => {});
        return 'filled';
    }
    return 'nobtn';
}

/** 正方登录后，点菜单里的「课表查询」。老版正方是 frameset，菜单在单独的 frame 里，所以每帧都找 */
async function clickZhengfangSchedule(page) {
    const LABELS = [/课表查询/, /学生课表/, /我的课表/];
    for (const frame of page.frames()) {
        for (const re of LABELS) {
            try {
                const loc = frame.getByText(re).first();
                if ((await loc.count()) === 0) continue;
                if (!(await loc.isVisible().catch(() => false))) continue;
                await loc.click({ timeout: 3500 });
                await page.waitForTimeout(2000);
                return String(re).replace(/[\^$\/]/g, '');
            } catch (e) { /* 试下一个 */ }
        }
    }
    return '';
}


/* ============================================================================
 * 四、三种抓取模式
 * ========================================================================== */
/** 模式一：Playwright（默认用本机 Edge，无需下载浏览器；有账号则自动登录） */
async function fetchWithBrowser(args) {
    let pw;
    try { pw = require('playwright'); } catch (e) {
        log(C.red('  ❌ 未安装 playwright。可选：'));
        log('     1) 完整模式：npm install playwright   （推荐，一劳永逸）');
        log('     2) 轻量模式：node sync_kcb.js --cookie "..." --url "课表页地址"');
        log('     3) 兜底模式：把课表页另存为 HTML 后 node sync_kcb.js --html 文件');
        throw new Error('未安装 playwright（界面模式请运行 npm install playwright）');
    }
    const profileDir = path.join(process.cwd(), CONFIG.userDataDir);

    // 0. 先探活：站点关着就直接讲清楚，别开浏览器干等十分钟
    if (!args.force) {
        const p = await probeService(CONFIG.jwglUrl);
        if (p.state === 'ok') {
            log(C.green(`  ✅ 教务系统可访问（${p.ms}ms）`));
        } else {
            const advice = probeAdvice(p);
            log(C.red(`  ❌ ${advice}`));
            throw new Error(p.state === 'connect-fail'
                ? `连不上教务系统（${p.detail}），请检查网络或是否需要校园网/VPN`
                : '教务系统当前无法访问（疑似夜间维护关站），请白天再同步');
        }
    }

    log(C.cyan('  🌐 正在打开浏览器（正方教务系统 eas.scit.cn）…'));
    log(C.gray(`  （等待上限 ${args.timeoutMin} 分钟；登录态会保存，下次通常不用再登）`));

    let context;
    try {
        context = await pw.chromium.launchPersistentContext(profileDir, {
            channel: 'msedge', headless: false, viewport: null,
            args: ['--start-maximized'],
        });
    } catch (e) {
        log(C.gray('  （未检测到 Edge，改用 Playwright 自带 Chromium）'));
        context = await pw.chromium.launchPersistentContext(profileDir, {
            headless: false, viewport: null,
        });
    }

    const page = await context.newPage();
    // launchPersistentContext 自带一个 about:blank 空白标签页，留着会干扰"当前页面"的判断，先关掉
    for (const p of context.pages()) {
        if (p !== page && /^about:blank/.test(p.url())) await p.close().catch(() => {});
    }
    let browserClosed = false;
    context.on('close', () => { browserClosed = true; }); // 浏览器被关/崩溃
    let navOk = true;
    // 上次成功抓过课表就直接跳过去；否则先去教务系统首页
    const entryUrl = readScheduleUrl() || CONFIG.jwglUrl;
    if (readScheduleUrl()) log(C.cyan('  🔗 有上次的课表页地址，先直接试它'));
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(e => {
            navOk = false;
            log(C.yellow(`  ⚠️ 页面打不开：${String(e.message).split('\n')[0].slice(0, 120)}`));
        });
    if (!navOk) {
        log(C.yellow('  👉 教务系统通常只能在校园网 / 学校 VPN 下访问。连上后重试，或手动把课表页存成 HTML。'));
    }
    await page.waitForTimeout(2500); // 等 Vue 页面渲染出登录框

    // —— 有保存的账号：尝试自动登录 ——
    const acc = args.noAccount ? null : loadAccount();
    const loginState = readLoginState();
    if (acc && loginState.fails >= 3) {
        log(C.yellow(`  ⛔ 之前已连续 ${loginState.fails} 次自动登录失败，为免把账号锁掉，本次不再自动提交。`));
        log(C.yellow('  👉 请在弹出的浏览器里手动登录一次（成功后计数会自动清零，下次恢复自动登录）。'));
    } else if (acc) {
        log(C.cyan(`  🔑 检测到已保存账号（${acc.user}），尝试自动登录…`));
        // 正方教务系统优先；不是正方登录页再退回融合门户的登录逻辑
        let r = await autoFillZhengfang(page, acc).catch(() => 'skip');
        if (r === 'skip') r = await autoFillLogin(page, acc).catch(() => 'skip');
        if (r === 'filled') {
            log(C.green('  ✅ 已自动填写并提交登录，等待页面跳转…'));
            await page.waitForTimeout(5000);
            // 还停在登录页 → 密码错/需验证码/风控，明确说出来，别让人对着日志干等十分钟
            if (await isLoginPage(page)) {
                const cap2 = await findCaptcha(page);
                const needCap = cap2.index >= 0 || (cap2.hasImg && cap2.text);
                const hint = await readLoginError(page);
                if (needCap) {
                    log(C.yellow('  ⚠️ 这次学校要求输入验证码，脚本不能替你输（会挡住机器人登录）。'));
                    log(C.yellow('  👉 我已经把光标放到验证码框，请看浏览器窗口：填 4 位验证码 → 点【登录】。'));
                    log(C.gray('  　 登录成功后我这边会自动接着抓课表，不用回来点按钮。'));
                } else if (hint) {
                    log(C.yellow(`  ⚠️ 登录失败：${hint}`));
                    log(C.yellow('  👉 这多半是账号或密码不对。请点界面上的「手动登录」，自己在浏览器里登一次最稳妥。'));
                } else {
                    log(C.yellow('  ⚠️ 登录似乎没有成功，页面仍停在登录页（页面没有明显报错）。'));
                    log(C.yellow('  👉 请在浏览器窗口里手动登录一次，登录成功后我会自动继续。'));
                }
                await page.bringToFront().catch(() => {});
                emitEvent('need-login', { url: page.url(), hint, captcha: needCap });
                // 失败计数：只统计"确实报错"的情况，验证码等待不算失败
                if (!needCap) writeLoginState({ fails: (loginState.fails || 0) + 1, last: new Date().toISOString(), hint });
            } else {
                writeLoginState({ fails: 0, last: new Date().toISOString(), hint: 'ok' }); // 登录通了，清零
            }
        } else if (r === 'captcha') {
            log(C.yellow('  👉 账号密码和身份「学生」已填好，但正方要验证码。光标已放到验证码框：'));
            log(C.yellow('     请在浏览器窗口里照着图上字符填进去 → 点【登录】。登录成功后我自动接着抓课表。'));
            await page.bringToFront().catch(() => {});
            emitEvent('need-login', { url: page.url(), captcha: true });
        } else if (r === 'nofill') {
            log(C.yellow('  ⚠️ 账号密码没能填进输入框（页面可能屏蔽了脚本输入）。'));
            log(C.yellow('  👉 请在浏览器窗口里手动登录一次，登录态会被记住，下次就不用再登了。'));
            await page.bringToFront().catch(() => {});
            emitEvent('need-login', { url: page.url() });
        } else if (r === 'nobtn') {
            log(C.yellow('  ⚠️ 已填好账号密码，但没找到「登录」按钮。'));
            log(C.yellow('  👉 请在浏览器窗口里点一下【登录】。'));
            await page.bringToFront().catch(() => {});
            emitEvent('need-login', { url: page.url() });
        } else {
            log(C.gray('  （当前不是登录页，可能已有登录态：直接用）'));
        }
    } else {
        log(C.yellow('  👉 请在浏览器中登录，并进入【课表查询】页面，然后什么都别做，等我抓取。'));
        log(C.gray('  （想以后免手动登录：先运行 node sync_kcb.js --save-account 存一次账号）'));
    }

    // —— 上次成功抓过课表：直接跳回那个地址，省得每次找菜单 ——
    const savedUrl = readScheduleUrl();
    if (savedUrl) {
        log(C.cyan('  🔗 检测到上次的课表页地址，直接访问…'));
        await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2500);
    }

    const deadline = Date.now() + args.timeoutMin * 60 * 1000;
    const startedAt = Date.now();
    const navCount = new Map(); // 每个页面自动点击「课表查询」的次数（最多 2 次，避免误点后不再重试）
    const totalSec = args.timeoutMin * 60;
    let html = '';
    let htmlUrl = '';
    let tick = 0;
    let lastBeat = -1;
    let emptyTicks = 0; // 连续「没有任何页面」的次数
    let shotLogged = false; // 截图提示只打一次

    log(C.gray(`  ⏳ 开始等待课表页，最多 ${args.timeoutMin} 分钟；界面上可随时点「取消同步」`));
    emitEvent('tick', { elapsed: 0, left: totalSec, url: '' });

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        tick++;

        // 用户在界面上点了「取消」——立刻收摊
        if (args.shouldStop && args.shouldStop()) {
            log(C.yellow('  ⏹ 已取消本次同步，浏览器窗口已关闭'));
            await context.close().catch(() => {});
            throw new Error('已取消');
        }

        const pages = context.pages().filter(p => !p.isClosed());
        // 浏览器被关掉：别让用户对着转圈干等。连续 3 次（约 6 秒）都空才判定，避免启动瞬间误判
        if (pages.length === 0) {
            emptyTicks++;
            if (emptyTicks >= 3) {
                await context.close().catch(() => {});
                throw new Error(browserClosed
                    ? '浏览器窗口被关闭了，同步已中止（重开即可重试）'
                    : '浏览器意外退出，同步已中止（请重试）');
            }
        } else {
            emptyTicks = 0;
        }

        for (const p of pages) {
            // 主文档 + 所有 iframe 都查一遍（门户常把教务系统套在 iframe 里）
            const docs = [];
            try { docs.push(await p.content()); } catch (e) { /* 页面跳转中 */ }
            for (const f of p.frames()) {
                if (f === p.mainFrame()) continue;
                try { docs.push(await f.content()); } catch (e) { /* 跨域 frame */ }
            }
            for (const content of docs) {
                if (!content) continue;
                try {
                    if (findScheduleTable(loadCheerio()(content))) { html = content; htmlUrl = p.url(); break; }
                } catch (e) { /* 解析失败忽略 */ }
            }
            if (html) break;

            // 每 14 秒尝试点一次课表入口，最多 2 次（用真实鼠标点击，SPA 路由才认）
            const tries = navCount.get(p) || 0;
            if (tick % 7 === 0 && tries < 2) {
                let clicked = await clickScheduleEntry(p).catch(() => '');
                if (!clicked) clicked = await clickZhengfangSchedule(p).catch(() => '');
                if (clicked) {
                    navCount.set(p, tries + 1);
                    log(C.gray(`  → 已自动点击「${clicked}」（第 ${tries + 1} 次尝试）`));
                }
            }
        }
        if (html) break;

        // 每 10 秒报一次进度，让人知道它还活着
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        if (elapsed - lastBeat >= 10) {
            lastBeat = elapsed;
            const open = context.pages().filter(p => !p.isClosed());
            const urls = open.map(p => p.url()).filter(u => u && !/^about:blank/.test(u));
            const main = urls[0] || '';
            const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            log(C.gray(`  ⏳ 已等待 ${elapsed}s，剩余 ${left}s${describePage(main)}`));
            // 多标签时把其它标签的地址也打出来（门户常在登录后新开一个标签）
            urls.slice(1).forEach((u, i) => {
                log(C.gray(`      标签${i + 2}：${u.replace(/^https?:\/\//, '').slice(0, 88)}`));
            });
            emitEvent('tick', { elapsed, left, url: main, pages: urls });
        }

        // 卡住时自动留证：约每 20 秒给每个标签页各拍一张，事后一眼看出停在哪一步
        if (tick % 10 === 0) {
            try {
                const shots = context.pages().filter(p => !p.isClosed());
                const dir = path.join(process.cwd(), '.kcb-debug');
                fs.mkdirSync(dir, { recursive: true });
                let n = 0;
                for (const pg of shots) {
                    n++;
                    await pg.screenshot({ path: path.join(dir, `page-${n}.png`) }).catch(() => {});
                }
                // 顺手把页面 URL 也记下来
                fs.writeFileSync(path.join(dir, 'pages.txt'),
                    shots.map((pg, i) => `#${i + 1} ${pg.url()}`).join('\n'), 'utf8');
                if (!shotLogged) {
                    shotLogged = true;
                    log(C.gray(`  📸 已定时保存 ${n} 个标签页截图 → .kcb-debug/page-*.png（卡住时发我）`));
                }
            } catch (e) { /* 截图失败不影响同步 */ }
        }
    }
    await context.close();
    if (!html) {
        log(C.red('  ❌ 超时未检测到课表页面。'));
        log(C.yellow('  👉 两个办法：① 下次同步时在浏览器里手动点到【课表查询】页；'));
        log(C.yellow('     ② 在课表页按 Ctrl+S 存成 HTML，用 `node sync_kcb.js --html 文件名` 解析。'));
        throw new Error('超时未检测到课表页面（请在浏览器里手动打开【课表查询】页）');
    }
    // 成功抓到课表 → 说明登录是通的，把失败计数清零；同时记住这个页面地址
    writeLoginState({ fails: 0, last: new Date().toISOString(), hint: 'synced' });
    writeScheduleUrl(htmlUrl);
    if (htmlUrl) log(C.gray(`  🔗 已记住课表页地址，下次直接跳过去：${htmlUrl.replace(/^https?:\/\//, '').slice(0, 70)}`));
    return html;
}

/** 把当前 URL 翻译成人话，告诉用户卡在哪一步 */
function describePage(url) {
    if (!url) return '｜当前页面：空白';
    if (/^(chrome-error|edge-error)/.test(url)) return '｜页面打不开（学校站点可能关着，或需要校园网 / VPN）';
    if (/^about:blank/.test(url)) return '｜当前页面：空白';
    if (/login|auth|sso|cas|passport|oauth/i.test(url)) return '｜当前在登录页，请在浏览器里完成登录';
    return '｜当前页面：' + url.replace(/^https?:\/\//, '').slice(0, 70);
}

/* -----------------------------------------------------------------------------
 * 门户探活：区分「你没网」和「学校那边关了」
 * 这三种状态的含义完全不同，处理方式也完全不同，所以必须分清楚：
 *   ok           拿到 HTTP 响应 → 服务活着，可以正常同步
 *   silent       TCP / TLS 都通了，但服务端一个字节都不回 → 学校服务关着（夜间维护/故障）
 *   connect-fail 连 TCP 都建不起来 → 没网 / DNS 异常 / 需要校园网或学校 VPN
 * --------------------------------------------------------------------------- */
function probeService(urlStr, timeoutMs = 9000) {
    const net = require('net');
    const tlsMod = require('tls');
    return new Promise(resolve => {
        let u;
        try { u = new URL(urlStr); } catch (e) {
            return resolve({ state: 'connect-fail', host: urlStr, detail: '地址格式不对', ms: 0 });
        }
        const host = u.hostname;
        const isHttps = u.protocol === 'https:';
        const port = Number(u.port) || (isHttps ? 443 : 80);
        const started = Date.now();
        let done = false;
        let socket;
        const finish = (state, detail) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch (e) { /* 已关闭 */ }
            resolve({ state, host, port, detail: detail || '', ms: Date.now() - started });
        };
        const sendRequest = () => {
            try {
                socket.write(
                    `GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${host}\r\n` +
                    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n' +
                    'Accept: text/html,application/xhtml+xml,*/*\r\nConnection: close\r\n\r\n'
                );
            } catch (e) { finish('connect-fail', '发送请求失败'); }
        };
        try {
            socket = isHttps
                ? tlsMod.connect({ host, port, servername: host, rejectUnauthorized: false })
                : net.connect({ host, port });
        } catch (e) {
            return resolve({ state: 'connect-fail', host, port, detail: e.message, ms: 0 });
        }
        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => finish('connect-fail', '连接超时'));
        socket.on('error', e => finish('connect-fail', e.code === 'ENOTFOUND' ? '域名解析失败' : (e.code || e.message)));
        if (isHttps) socket.on('secureConnect', sendRequest);
        else socket.on('connect', sendRequest);
        socket.on('data', buf => {
            const head = buf.toString('latin1');
            if (/^HTTP\/\d/.test(head)) finish('ok', head.split('\r\n')[0]);
            else finish('silent', '收到非 HTTP 内容');
        });
        socket.on('close', () => finish('silent', '服务端没返回任何内容就关闭了连接'));
    });
}

/** 把探活结果翻译成用户能看懂的诊断 + 该怎么做 */
function probeAdvice(p) {
    if (p.state === 'ok') return '';
    if (p.state === 'connect-fail') {
        return `连不上 ${p.host}（${p.detail}）。请检查：本机网络是否正常、是否需要先连校园网或学校 VPN。`;
    }
    return `${p.host} 的端口能连上，但服务端不返回任何网页内容 —— 学校那边现在是关着的。` +
        '最常见的原因是夜间维护关站（很多高校在 23:00 到次日 06:00 前后停止对外服务），也可能是临时故障。建议白天再同步。';
}

/** 模式二：Cookie 轻量抓取（适合不想装 playwright 时） */
async function fetchWithCookie(args) {
    const url = args.url || (CONFIG.jwglUrl + CONFIG.schedulePaths[0]);
    log(C.cyan(`  🌐 正在抓取 ${url}`));
    const resp = await fetch(url, {
        headers: {
            'Cookie': args.cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
            'Referer': CONFIG.jwglUrl + '/',
        },
        redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    // 正方系统常见 GBK 编码，自动探测
    let html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (/\uFFFD/.test(html)) html = new TextDecoder('gbk').decode(buf);
    if (!/星期|周[一二三四五六日]/.test(html)) {
        throw new Error('抓到的页面不像课表页（Cookie 可能已失效，或 --url 地址不对）');
    }
    return html;
}

/* ============================================================================
 * 门户课表接口模式（推荐，不需要正方验证码）
 * ----------------------------------------------------------------------------
 * 融合门户的课表页（lightapp/pcapp.html#/home/searchcourse）背后是
 *   /normalservice/course/selectCourse
 * 每切换一周就请求一次，返回 JSON：courseName / teacherName / classroomName /
 * weekDay / startTime / endTime / week。所以这里驱动页面从当前周往前、往后各翻一遍，
 * 边翻边截获 JSON，最后按"同一门课"合并出 1-16 这样的周次串。
 * 比解析 HTML 稳得多，也不受正方验证码影响。
 * ========================================================================== */

/** 把周次数组压成 "1-16" / "1-15单" / "3,7-17" 这种写法 */
function compressWeeks(nums) {
    const a = [...new Set(nums.map(Number).filter(n => n > 0))].sort((x, y) => x - y);
    if (!a.length) return '';
    // 等差 2（全单或全双）且至少 3 项 → 15单 / 2-16双
    if (a.length >= 3 && a.every((n, i) => i === 0 || n - a[i - 1] === 2)) {
        return `${a[0]}-${a[a.length - 1]}${a[0] % 2 ? '单' : '双'}`;
    }
    const parts = [];
    let i = 0;
    while (i < a.length) {
        let j = i;
        while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
        parts.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`);
        i = j + 1;
    }
    return parts.join(',');
}

/** 把接口返回的多周课程合并成 kcb-data 的课程结构 */
function mergePortalWeeks(weekMap) {
    const buckets = new Map();
    for (const [startDay, list] of weekMap) {
        for (const it of list) {
            const name = (it.courseName || '').trim();
            if (!name) continue;
            const day = Number(it.weekDay);
            const start = Number(it.startTime);
            const end = Number(it.endTime);
            if (!(day >= 1 && day <= 7) || !(start >= 1) || !(end >= start)) continue;
            const key = [name, it.teacherName || '', it.classroomName || '', day, start, end].join('|');
            if (!buckets.has(key)) {
                buckets.set(key, {
                    name, teacher: (it.teacherName || '').trim(), room: (it.classroomName || '').trim(),
                    day, start, span: end - start + 1, weekNums: [], startDay,
                });
            }
            const b = buckets.get(key);
            const w = Number(it.week);
            if (w > 0) b.weekNums.push(w);
            if (startDay < b.startDay) b.startDay = startDay;
        }
    }
    const courses = [];
    for (const b of buckets.values()) {
        courses.push({
            name: b.name, teacher: b.teacher, room: b.room,
            day: b.day, start: b.start, span: b.span,
            weeks: compressWeeks(b.weekNums),
        });
    }
    courses.sort((a, b) => a.day - b.day || a.start - b.start);
    return courses;
}

/** 登录融合门户（复用已存账号；有验证码就交给人工） */
async function loginPortal(page, args) {
    const acc = args.noAccount ? null : loadAccount();
    if (!(await isLoginPage(page))) return 'ok';
    if (!acc) {
        log(C.yellow('  👉 请在浏览器里登录融合门户，登录成功后我会自动继续。'));
        await page.bringToFront().catch(() => {});
        return 'manual';
    }
    log(C.cyan(`  🔑 用已保存账号（${acc.user}）自动登录门户…`));
    const r = await autoFillLogin(page, acc).catch(() => 'skip');
    if (r === 'captcha') {
        log(C.yellow('  👉 门户要验证码：光标已在验证码框，请在浏览器里填完点【登录】。'));
        await page.bringToFront().catch(() => {});
    } else if (r === 'filled') {
        log(C.green('  ✅ 已提交登录，等待进入门户…'));
    } else if (r === 'nofill' || r === 'nobtn') {
        log(C.yellow('  👉 自动填表没成功，请在浏览器里手动登录一次。'));
        await page.bringToFront().catch(() => {});
    }
    return 'trying';
}

/** 门户接口模式主函数：返回 { courses, semesterStart, maxWeek, raw } */
async function fetchViaPortal(args) {
    let pw;
    try { pw = require('playwright'); } catch (e) {
        throw new Error('未安装 playwright（请先 npm install playwright）');
    }
    const probe = await probeService(CONFIG.portalUrl);
    if (probe.state !== 'ok' && !args.force) throw new Error(probeAdvice(probe));

    log(C.cyan('  🌐 打开融合门户（走自带课表页，避开正方验证码）…'));
    let context;
    try {
        context = await pw.chromium.launchPersistentContext(path.join(process.cwd(), CONFIG.userDataDir), {
            channel: 'msedge', headless: false, viewport: null, args: ['--start-maximized'],
        });
    } catch (e) {
        context = await pw.chromium.launchPersistentContext(path.join(process.cwd(), CONFIG.userDataDir), {
            headless: false, viewport: null,
        });
    }

    // —— 截获 selectCourse 接口 ——
    const weekMap = new Map();   // startDay -> list
    let apiMaxWeek = 0;
    let sawApi = false;
    let lastStartDay = '';       // 最近一次响应对应的周（用来判断"还能不能翻"）
    context.on('response', resp => {
        const u = resp.url();
        if (!/normalservice\/course\/selectCourse/i.test(u)) return;
        resp.text().then(body => {
            try {
                const j = JSON.parse(body);
                const c = j.content || {};
                if (!Array.isArray(c.list) || !c.startDay) return;
                weekMap.set(c.startDay, c.list);
                lastStartDay = c.startDay;
                sawApi = true;
                if (c.maxWeek) apiMaxWeek = Math.max(apiMaxWeek, Number(c.maxWeek) || 0);
            } catch (e) { /* 非 JSON 忽略 */ }
        }).catch(() => {});
    });

    try {
        const page = await context.newPage();
        for (const p of context.pages()) {
            if (p !== page && /^about:blank/.test(p.url())) await p.close().catch(() => {});
        }
        await page.goto(CONFIG.portalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // 1) 登录（若需要）
        await loginPortal(page, args);

        // 2) 等进入门户（登录页消失），最多等 timeoutMin
        const loginDeadline = Date.now() + args.timeoutMin * 60 * 1000;
        while (Date.now() < loginDeadline) {
            if (args.shouldStop && args.shouldStop()) throw new Error('已取消');
            if (!(await isLoginPage(page))) break;
            await page.waitForTimeout(2000);
        }
        if (await isLoginPage(page)) throw new Error('门户登录没有完成（请重试，或先手动登录一次）');

        // 3) 点「查看课表」打开课表页
        const pagesBefore = context.pages().length;
        const opened = await page.getByText(/^\s*查看课表\s*$/).first()
            .click({ timeout: 8000 }).then(() => true).catch(() => false);
        if (!opened) log(C.yellow('  ⚠️ 没找到「查看课表」入口，看看是不是停在别的页面。'));
        await page.waitForTimeout(5000);

        let tab = context.pages().filter(p => !p.isClosed()).slice(-1)[0];
        if (context.pages().length === pagesBefore) {
            // 没开新标签，可能就是当前页
            tab = page;
        }
        await tab.waitForTimeout(2000);

        // 4) 等第一周的接口数据
        const apiDeadline = Date.now() + 30000;
        while (!sawApi && Date.now() < apiDeadline) {
            if (args.shouldStop && args.shouldStop()) throw new Error('已取消');
            await tab.waitForTimeout(1000);
        }
        if (!sawApi) throw new Error('课表页没有返回数据（可能没进到课表页）');
        log(C.green(`  ✅ 已连上课表接口（本周 ${weekMap.size} 周数据）`));

        // 5) 往前翻到翻不动（连续 2 次周次不变才算到头）
        const clickWeek = async (re) => {
            const loc = tab.getByText(re).first();
            if ((await loc.count().catch(() => 0)) === 0) return false;
            if (!(await loc.isVisible().catch(() => false))) return false;
            await loc.click({ timeout: 4000 }).catch(() => {});
            await tab.waitForTimeout(1200);
            return true;
        };
        const prevRe = /^\s*上一周\s*$/;
        let stuck = 0;
        for (let i = 0; i < 30 && stuck < 2; i++) {
            if (args.shouldStop && args.shouldStop()) throw new Error('已取消');
            const before = lastStartDay;
            if (!(await clickWeek(prevRe))) break;
            stuck = lastStartDay === before ? stuck + 1 : 0;
        }
        log(C.gray(`  ← 已翻到最早：${[...weekMap.keys()].sort()[0] || '?'}`));

        // 6) 往后翻：一直翻到 maxWeek 或连续 2 次翻不动（注意"没新增数据"不算翻不动，
        //    因为回程会经过已经取过的周）
        const nextRe = /^\s*下一周\s*$/;
        const want = apiMaxWeek || 20;
        stuck = 0;
        for (let i = 0; i < 40 && stuck < 2; i++) {
            if (args.shouldStop && args.shouldStop()) throw new Error('已取消');
            const before = lastStartDay;
            if (!(await clickWeek(nextRe))) break;
            stuck = lastStartDay === before ? stuck + 1 : 0;
            if (weekMap.size >= want && i > want) break; // 已经够了，别多翻
        }
        log(C.green(`  ✅ 共取到 ${weekMap.size} 周课表数据（学期共 ${apiMaxWeek || '?'} 周）`));

        const courses = mergePortalWeeks(weekMap);
        if (!courses.length) throw new Error('接口有数据但没解析出课程');

        // 开学日 = 最早那一周的 startDay（第 1 周）
        const starts = [...weekMap.keys()].sort();
        const semesterStart = starts[0] || '';
        const raw = {
            weeks: [...weekMap.keys()].sort(),
            maxWeek: apiMaxWeek,
            capturedAt: new Date().toISOString(),
            courses,
        };
        return { courses, semesterStart, maxWeek: apiMaxWeek, raw };
    } finally {
        await context.close().catch(() => {});
    }
}

/* ============================================================================
 * 五、主流程
 * ========================================================================== */
/** 交互菜单（双击 bat 或直接运行且不带参数时进入；纯中文输出放在 node 里，避开 bat 编码坑） */
async function runInteractive() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(res => rl.question(q, res));
    for (;;) {
        log('');
        log(C.bold('  ╔══════════════════════════════════════════╗'));
        log(C.bold('  ║            教务系统课表同步              ║'));
        log(C.bold('  ╚══════════════════════════════════════════╝'));
        log('');
        log('    1. 保存学号密码（第一次用，存一次以后自动登录）');
        log('    2. 同步课表（日常用这个）');
        log('    3. 试运行（只看解析结果，不改任何文件）');
        log('    4. 手动登录（不存密码，登录态会记住）');
        log('    0. 退出');
        log('');
        const ans = (await ask('  请输入序号后回车：')).trim();
        if (ans === '' || ans === '0') { rl.close(); return; }
        if (ans === '1') { await promptSaveAccount(rl, ask); await ask('  按回车返回菜单…'); continue; }
        if (ans === '2') { rl.close(); return runSync(parseArgs(['node', 'sync'])); }
        if (ans === '3') { rl.close(); return runSync(parseArgs(['node', 'sync', '--dry-run'])); }
        if (ans === '4') { rl.close(); return runSync(parseArgs(['node', 'sync', '--no-account'])); }
        log(C.yellow('  ⚠️ 没有这个选项，请重新输入。'));
    }
}

/** 执行一次同步 */
async function runSync(args) {
    log(C.bold('\n📅 教务系统课表同步 ' + new Date().toLocaleString('zh-CN') + '\n'));

    // 1. 获取课表页 HTML
    emitEvent('phase', { phase: 'fetch', text: '正在打开浏览器 / 抓取课表页' });
    let html = null;
    let portal = null;
    if (args.html) {
        log(C.cyan(`  📂 模式三：解析本地文件 ${args.html}`));
        html = fs.readFileSync(args.html, 'utf8');
    } else if (args.cookie) {
        log(C.cyan('  🍪 模式二：Cookie 抓取'));
        html = await fetchWithCookie(args);
    } else {
        // 优先走门户接口模式：结构化数据、不需要正方验证码
        try {
            portal = await fetchViaPortal(args);
        } catch (e) {
            if (/已取消/.test(e.message)) throw e;
            log(C.yellow(`  ⚠️ 门户接口模式没成功：${e.message}`));
            log(C.yellow('  ↪ 改用正方教务系统页面模式（需要验证码）…'));
            html = await fetchWithBrowser(args);
        }
    }

    // 2. 拿到课程数组
    emitEvent('phase', { phase: 'parse', text: '正在整理课程数据' });
    let courses, semesterText, tableFound, portalMaxWeek = 0;
    if (portal) {
        courses = portal.courses;
        tableFound = courses.length > 0;
        portalMaxWeek = portal.maxWeek || 0;
        semesterText = portal.semesterStart ? `第 1 周从 ${portal.semesterStart} 开始` : '';
        fs.writeFileSync(path.join(process.cwd(), CONFIG.rawHtmlFile), JSON.stringify(portal.raw, null, 2), 'utf8');
        log(C.green(`  💾 接口原始数据已保存 → ${CONFIG.rawHtmlFile}`));
        log(C.green(`  ✅ 整理出 ${courses.length} 门课`));
    } else {
        fs.writeFileSync(path.join(process.cwd(), CONFIG.rawHtmlFile), html, 'utf8');
        log(C.green(`  💾 原始页面已保存 → ${CONFIG.rawHtmlFile}（解析错位时把它发给我调规则）`));
        const parsed = parseScheduleHtml(html, args.debug);
        courses = parsed.courses;
        semesterText = parsed.semesterText;
        tableFound = parsed.tableFound;
        if (!tableFound || courses.length === 0) {
            log(C.red('  ❌ 没在页面里找到课表表格。'));
            log('  可能原因：还没点到【课表查询】页 / 页面是空框架 / 结构太特殊。');
            log(`  请把 ${CONFIG.rawHtmlFile} 发给我，我来适配解析规则。`);
            throw new Error('没在页面里找到课表表格');
        }
        if (semesterText) log(C.cyan(`  🏫 检测到学期：${semesterText}`));
        log(C.green(`  ✅ 解析到 ${courses.length} 门课`));
    }
    // 按 周一→周日、节次升序 排列，和手写版风格一致，也方便 diff 阅读
    courses.sort((a, b) => a.day - b.day || a.start - b.start);

    // 3. 读取现有配置（继承作息/分组，支持 CLI 覆盖）
    const existing = readExistingData(path.join(process.cwd(), CONFIG.dataFile));
    const data = {
        courses,
        semester_start: args.semesterStart || (portal && portal.semesterStart) || (existing && existing.semester_start) || '2026-08-31',
        max_week: args.maxWeek || portalMaxWeek || (existing && existing.max_week) || 18,
        normal_times: (existing && existing.normal_times) || {
            1: { start: '8:20', end: '9:05' }, 2: { start: '9:15', end: '10:00' },
            3: { start: '10:30', end: '11:15' }, 4: { start: '11:25', end: '12:10' },
            5: { start: '14:00', end: '14:45' }, 6: { start: '14:55', end: '15:40' },
            7: { start: '16:10', end: '16:55' }, 8: { start: '17:05', end: '17:50' },
            9: { start: '19:00', end: '19:45' }, 10: { start: '19:55', end: '20:40' },
        },
        special_pm_times: (existing && existing.special_pm_times) || {},
        period_labels: (existing && existing.period_labels) || [
            { label: '上午', icon: 'sun', periods: [1, 2, 3, 4] },
            { label: '下午', icon: 'cloud_sun', periods: [5, 6, 7, 8] },
            { label: '晚上', icon: 'moon', periods: [9, 10] },
        ],
    };

    // 4. diff 报告
    log(C.bold('\n  ── 调课变更报告 ──'));
    const diff = diffCourses((existing && existing.courses) || [], courses);
    printDiffReport(diff);
    emitEvent('diff', { diff: serializeDiff(diff) });

    if (args.dryRun) {
        log(C.yellow('\n  [dry-run] 未写入任何文件。解析结果如下：'));
        for (const c of courses) {
            log(C.gray(`    ${courseLabel(c)}  ${c.teacher || '-'}  ${c.room || '-'}  [${c.weeks}]`));
        }
        emitEvent('phase', { phase: 'done', text: '试运行结束，未改动文件' });
        return { courses, diff, written: false };
    }

    // 5. 备份 + 写入
    emitEvent('phase', { phase: 'write', text: '正在写入 kcb-data.js' });
    const dataPath = path.join(process.cwd(), CONFIG.dataFile);
    if (fs.existsSync(dataPath)) {
        fs.copyFileSync(dataPath, path.join(process.cwd(), CONFIG.backupFile));
        log(C.gray(`\n  📦 旧数据已备份 → ${CONFIG.backupFile}`));
    }
    fs.writeFileSync(dataPath, generateKcbDataJs(data), 'utf8');
    log(C.green(`  ✅ 已写入 ${CONFIG.dataFile}，刷新 课程表.html 即可看到最新课表\n`));
    emitEvent('phase', { phase: 'done', text: '同步完成' });
    return { courses, diff, written: true, data };
}

/** 程序入口：无参数进菜单；带参数直接执行 */
async function main() {
    const args = parseArgs(process.argv);
    if (process.argv.length <= 2) return runInteractive();
    if (args.saveAccount) { await promptSaveAccount(); return; }
    return runSync(args);
}

// 作为命令行脚本运行时执行主流程；被 require 时只导出函数（便于单元测试）
if (require.main === module) {
    main().catch(e => {
        console.error(C.red(`\n  ❌ 运行失败：${e.message}`));
        process.exit(1);
    });
}

module.exports = {
    parseScheduleHtml, findScheduleTable, autoFillLogin, isLoginPage,
    loadAccount, diffCourses, expandWeeks, normalizeWeeks, generateKcbDataJs, CONFIG,
    runSync, parseArgs, readExistingData, serializeDiff, courseLabel,
    setLogHook, setEventHook, log, probeService, probeAdvice,
    fetchViaPortal, mergePortalWeeks, compressWeeks,
};
