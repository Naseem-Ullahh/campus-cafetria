// Helpers for regression tests that run against the real Flask server + MySQL.
//   Start the server first:  server/.venv/bin/python server/app.py
//   Then:                    cd tests && npm run regression
// WARNING: the tests reinstall the campus_cafeteria database.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000/';
const ROOT = path.join(__dirname, '../..');
const PYTHON = process.env.PYTHON || path.join(ROOT, 'server/.venv/bin/python');

function resetDatabase() {
    const result = spawnSync(PYTHON, [path.join(ROOT, 'server/init_db.py'), '--reset'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Database reset failed:\n' + result.stderr + result.stdout);
}

async function launch() {
    try {
        await fetch(BASE);
    } catch (e) {
        throw new Error(`The Flask server isn't running at ${BASE} - start it with server/.venv/bin/python server/app.py`);
    }
    return puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
}

// A separate browser session (own cookies) that records problems
async function session(browser, name, { width = 1366, height = 860 } = {}) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width, height });
    const problems = [];
    page.on('pageerror', e => problems.push(`${name}: JS error: ${e.message}`));
    page.on('response', r => {
        // Missing files on our own server (the logo is optional until it's added)
        if (r.status() === 404 && r.url().startsWith(BASE) && !r.url().endsWith('/assets/logo.png')) problems.push(`${name}: 404 ${r.url()}`);
        if (r.status() >= 500) problems.push(`${name}: ${r.status()} ${r.url()}`);
    });
    page.on('dialog', d => d.accept());
    page.problems = problems;
    return page;
}

// Sign in through the API from inside the page, so the cookie lands in this session
async function signIn(page, login, password, staff = false) {
    await page.goto(BASE + 'pages/student/login.html', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async (login, password, staff) => {
        const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password, staff }) });
        return r.status;
    }, login, password, staff);
    if (result !== 200) throw new Error(`login ${login} failed: ${result}`);
}

// Next pickup slot the server accepts: >= 45 min ahead, inside 8 AM - 10 PM (Pakistan time)
function pickupTime(minutes = 45) {
    const pkt = new Date(Date.now() + minutes * 60000 + 5 * 3600000);     // shift to read PKT clock fields in UTC
    if (pkt.getUTCHours() < 8) pkt.setUTCHours(8, 0, 0, 0);
    else if (pkt.getUTCHours() >= 22) { pkt.setUTCDate(pkt.getUTCDate() + 1); pkt.setUTCHours(8, 0, 0, 0); }
    return new Date(pkt.getTime() - 5 * 3600000).toISOString();
}

async function placeOrder(page, items, method = 'Cash', reference = null) {
    return page.evaluate(async (items, method, reference, pickup) => {
        const r = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, pickup_time: pickup, payment_method: method, transaction_reference: reference }) });
        return (await r.json()).order.order_id;
    }, items, method, reference, pickupTime());
}

async function staffAction(page, orderId, action, body = {}) {
    return page.evaluate(async (orderId, action, body) => {
        const r = await fetch(`/api/staff/orders/${orderId}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return r.status;
    }, orderId, action, body);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

module.exports = { BASE, ROOT, resetDatabase, launch, session, signIn, placeOrder, staffAction, pickupTime, wait };
