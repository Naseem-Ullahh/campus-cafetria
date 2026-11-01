// Component test harness: serves client/ from a tiny static server and answers
// every /api request with a fake reply, so each page can be tested on its own
// in a real browser, in any state, without Flask or MySQL.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const CLIENT = path.join(__dirname, '../../client');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

function startServer() {
    const server = http.createServer((req, res) => {
        const file = path.join(CLIENT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!file.startsWith(CLIENT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Shared browser + server for a test file
async function setup() {
    const server = await startServer();
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
        headless: 'new',
        args: ['--no-sandbox']
    });
    const base = `http://127.0.0.1:${server.address().port}/`;
    return {
        base,
        browser,
        async close() { await browser.close(); server.close(); },
        // open(path, api): api = { 'GET /auth/me': [200, {...}] or (call) => [status, body] }
        open: (pagePath, api, options) => openPage(browser, base, pagePath, api, options)
    };
}

async function openPage(browser, base, pagePath, api = {}, { width = 1280, height = 900, before } = {}) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width, height });
    const calls = [];
    const errors = [];
    const unmocked = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => (page.dialogAnswer === false ? d.dismiss() : d.accept(page.promptAnswer)));
    await page.setRequestInterception(true);
    page.on('request', request => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) {
            // Only our own files and the CDNs the pages need; skip images to keep tests fast
            if (request.resourceType() === 'image' && url.origin + '/' !== base) return request.respond({ status: 204 });
            return request.continue();
        }
        const apiPath = url.pathname.slice(4) + url.search;
        const key = `${request.method()} ${url.pathname.slice(4)}`;
        const body = request.postData() ? JSON.parse(request.postData()) : undefined;
        const call = { method: request.method(), path: apiPath, key, body, headers: request.headers() };
        calls.push(call);
        let reply = api[key];
        if (typeof reply === 'function') reply = reply(call);
        if (!reply) {
            unmocked.push(key);
            reply = [404, { error: 'not mocked: ' + key }];
        }
        request.respond({ status: reply[0], contentType: 'application/json', body: JSON.stringify(reply[1]) });
    });
    if (before) await before(page);
    await page.goto(base + pagePath, { waitUntil: 'networkidle2' });
    return { page, calls, errors, unmocked, context };
}

// ---------- sample data ----------
const at = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();

const USERS = {
    customer: { user_id: 10, university_id: 'STU2026', full_name: 'Naseem Ullah', email: 'naseem@university.edu', phone: '03001234567', user_type: 'student', role: 'customer' },
    admin: { user_id: 1, university_id: 'EMP-0001', full_name: 'Cafeteria Admin', email: 'admin@university.edu', phone: '03000000001', user_type: 'staff', role: 'admin' },
    cashier: { user_id: 2, university_id: 'EMP-0002', full_name: 'Counter Cashier', email: 'cashier@university.edu', phone: '03000000002', user_type: 'staff', role: 'cashier' },
    kitchen: { user_id: 3, university_id: 'EMP-0003', full_name: 'Head Chef', email: 'kitchen@university.edu', phone: '03000000003', user_type: 'staff', role: 'kitchen' }
};
const me = role => (role ? [200, { user: USERS[role] }] : [401, { error: 'Please sign in first' }]);

const MENU = [
    { item_id: 1, item_name: 'Classic Burger', description: 'Beef patty', price: 120, image_url: null, category_id: 2, category_name: 'Lunch', stock_quantity: 3, can_order: 1 },
    { item_id: 2, item_name: 'French Fries', description: 'Crispy', price: 60, image_url: null, category_id: 3, category_name: 'Snacks', stock_quantity: 0, can_order: 0 },
    { item_id: 3, item_name: 'Coffee', description: 'Hot <b>brewed</b>', price: 50, image_url: null, category_id: 4, category_name: 'Beverages', stock_quantity: 100, can_order: 1 },
    { item_id: 4, item_name: 'Pancakes', description: 'With syrup', price: 90, image_url: null, category_id: 1, category_name: 'Breakfast', stock_quantity: 20, can_order: 1 }
];

function order(overrides = {}) {
    return {
        order_id: 7, status: 'Received', order_date: at(-3), requested_pickup_time: at(60), estimated_ready_time: null,
        cancellation_deadline: at(40), acceptance_deadline: at(7), close_reason: null, total_amount: 290,
        special_instructions: null, user_id: 10, university_id: 'STU2026', full_name: 'Naseem Ullah', phone: '03001234567',
        user_type: 'student', payment_method: 'Cash', payment_status: 'Pending', transaction_reference: null,
        verified_at: null, verified_by_name: null, item_count: 3,
        lines: [
            { item_id: 1, item_name: 'Classic Burger', category_name: 'Lunch', quantity: 2, unit_price: 120, line_total: 240 },
            { item_id: 3, item_name: 'Coffee', category_name: 'Beverages', quantity: 1, unit_price: 50, line_total: 50 }
        ],
        history: [{ old_status: null, new_status: 'Received', note: null, changed_at: at(-3), changed_by: 'Customer' }],
        ...overrides
    };
}

module.exports = { setup, USERS, me, MENU, order, at };
