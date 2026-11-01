// Component tests: staff pages, each in isolation with a faked API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, me, MENU, order, at, account } = require('./harness');

let h;
test.before(async () => { h = await setup(); });
test.after(async () => { await h.close(); });

const text = (page, selector) => page.$eval(selector, e => e.textContent.trim());
const wait = ms => new Promise(r => setTimeout(r, ms));

// Rows as the board views return them
const incomingRow = (o = {}) => ({
    order_id: 7, order_date: at(-2), requested_pickup_time: at(60), acceptance_deadline: at(8), minutes_waiting: 2,
    seconds_to_decide: 480, total_amount: 290, full_name: 'Naseem Ullah', university_id: 'STU2026',
    payment_method: 'Cash', payment_status: 'Pending', transaction_reference: null,
    items: '2 x Classic Burger, 1 x Coffee', special_instructions: null, ...o
});
const kitchenRow = (o = {}) => ({
    order_id: 7, status: 'Accepted', requested_pickup_time: at(60), estimated_ready_time: at(55), accepted_at: at(-1),
    preparing_at: null, minutes_until_due: 55, full_name: 'Naseem Ullah', items: '2 x Classic Burger, 1 x Coffee',
    special_instructions: 'Less spicy', ...o
});
const counterRow = (o = {}) => ({
    order_id: 7, ready_at: at(-5), requested_pickup_time: at(10), minutes_waiting: 5, no_show_after: at(40), total_amount: 290,
    full_name: 'Naseem Ullah', university_id: 'STU2026', phone: '03001234567', payment_method: 'Cash',
    payment_status: 'Pending', transaction_reference: null, items: '2 x Classic Burger, 1 x Coffee', ...o
});

// ---------- staff login ----------
for (const [role, home] of [['admin', 'dashboard.html'], ['cashier', 'incoming.html'], ['kitchen', 'kitchen.html']]) {
    test(`staff login: ${role} lands on ${home}`, async () => {
        let signedIn = false;
        const { page, calls } = await h.open('pages/admin/login.html', {
            'GET /auth/me': () => me(signedIn ? role : null),
            'POST /auth/login': () => { signedIn = true; return [200, { user: { role } }]; },
            'GET /admin/dashboard': [200, { today: {}, counts: {}, low_stock: [], recent_orders: [] }],
            'GET /staff/incoming': [200, { orders: [] }], 'GET /staff/kitchen': [200, { orders: [] }]
        });
        await page.type('#username', 'EMP-0001');
        await page.type('#password', 'x');
        await Promise.all([page.waitForNavigation(), page.click('#loginBtn')]);
        await wait(800);     // stays there (the screen accepts this role)
        assert.ok(page.url().endsWith(home), page.url());
        assert.equal(calls.find(c => c.key === 'POST /auth/login').body.staff, true);
    });
}

test('staff login: error shown, back link goes to the student login', async () => {
    const { page } = await h.open('pages/admin/login.html', {
        'GET /auth/me': me(null), 'POST /auth/login': [403, { error: 'This is a customer account. Please use the student login.' }]
    });
    await page.type('#username', 'STU001');
    await page.type('#password', 'x');
    await page.click('#loginBtn');
    await page.waitForFunction(() => document.getElementById('error').innerText.includes('customer account'));
    assert.equal(await page.$eval('#loginBtn', b => b.disabled), false);
    assert.match(await page.$eval('a[href*="student/login"]', a => a.href), /pages\/student\/login\.html$/);
});

// ---------- incoming board ----------
test('incoming: card details, countdown, nav for a cashier', async () => {
    const { page, errors } = await h.open('pages/admin/incoming.html', {
        'GET /auth/me': me('cashier'),
        'GET /staff/incoming': [200, { orders: [incomingRow({ payment_method: 'JazzCash', transaction_reference: 'JC998877', special_instructions: '<i>no onions</i>' })] }]
    });
    await page.waitForSelector('[data-order="7"]');
    assert.equal(await text(page, '.card-number'), '#0007');
    assert.match(await text(page, '.countdown'), /^\d:\d\d left to accept$/);
    assert.match(await text(page, '.card-pay'), /JC998877/);
    assert.ok((await page.$eval('.card-note', e => e.innerHTML)).includes('&lt;i&gt;'), 'instructions escaped');
    assert.deepEqual(await page.$$eval('#boardNav a', a => a.map(x => x.textContent.trim())), ['Incoming', 'Kitchen', 'Counter', 'All orders', 'Receivable']);
    assert.equal(await page.title(), "(1) Incoming orders - Signals Std. Cafe'");
    assert.deepEqual(errors, []);
});

test('incoming: countdown turns urgent and says when time is up', async () => {
    const { page } = await h.open('pages/admin/incoming.html', {
        'GET /auth/me': me('cashier'),
        'GET /staff/incoming': [200, { orders: [incomingRow({ seconds_to_decide: 120 }), incomingRow({ order_id: 8, seconds_to_decide: 0 })] }]
    });
    await page.waitForSelector('[data-order="8"]');
    assert.equal(await page.$eval('[data-order="7"] .countdown', e => e.classList.contains('urgent')), true);
    assert.match(await text(page, '[data-order="8"] .countdown'), /auto-rejected/);
});

test('incoming: ready-by choices are never in the past or after pickup', async () => {
    const { page } = await h.open('pages/admin/incoming.html', {
        'GET /auth/me': me('cashier'), 'GET /staff/incoming': [200, { orders: [incomingRow({ requested_pickup_time: at(12) })] }]
    });
    await page.waitForSelector('.ready-select');
    const values = await page.$$eval('.ready-select option', o => o.map(x => x.value));
    assert.ok(values.length >= 1 && values.length < 4, 'times earlier than now are left out');
    for (const v of values) {
        assert.ok(new Date(v) > Date.now());
        assert.ok(new Date(v) <= new Date(Date.now() + 12 * 60000 + 1000));
    }
});

test('incoming: accept sends the chosen ready time', async () => {
    let accepted = false;
    const { page, calls } = await h.open('pages/admin/incoming.html', {
        'GET /auth/me': me('cashier'),
        'GET /staff/incoming': () => [200, { orders: accepted ? [] : [incomingRow()] }],
        'POST /staff/orders/7/accept': () => { accepted = true; return [200, { order: order({ status: 'Accepted' }) }]; }
    });
    await page.waitForSelector('.ready-select');
    const second = await page.$$eval('.ready-select option', o => o[1].value);
    await page.select('.ready-select', second);
    await page.click('[data-order="7"] .btn-act.primary');
    await page.waitForFunction(() => !document.querySelector('[data-order="7"]'));
    assert.equal(calls.find(c => c.key === 'POST /staff/orders/7/accept').body.estimated_ready_time, second);
    assert.match(await text(page, '#emptyState'), /No new orders/);
});

test('incoming: reject needs a reason; the open form survives refreshes', async () => {
    let orders = [incomingRow()];
    const { page, calls } = await h.open('pages/admin/incoming.html', {
        'GET /auth/me': me('cashier'),
        'GET /staff/incoming': () => [200, { orders }],
        'POST /staff/orders/7/reject': () => { orders = []; return [200, { order: order({ status: 'Rejected' }) }]; }
    });
    await page.waitForSelector('.danger-outline');
    await page.click('.danger-outline');
    await page.click('#reject-7 .btn-act.danger');
    assert.equal(calls.filter(c => c.key === 'POST /staff/orders/7/reject').length, 0, 'empty reason blocked by the form');
    await page.click('#reject-7 .chip:nth-child(2)');
    // Meanwhile a new order arrives AND order 7's payment changes, so its card is redrawn
    orders = [{ ...orders[0], payment_status: 'Confirmed' }, incomingRow({ order_id: 8 })];
    await page.waitForSelector('[data-order="8"].is-new', { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector('[data-order="7"]').dataset.signature.includes('Confirmed'));
    assert.equal(await page.$eval('#reject-7', f => !f.hidden && f.reason.value), "Can't be ready by the pickup time");
    await page.click('#reject-7 .btn-act.danger');
    await page.waitForFunction(() => !document.querySelector('[data-order="7"]'));
    assert.deepEqual(calls.find(c => c.key === 'POST /staff/orders/7/reject').body, { reason: "Can't be ready by the pickup time" });
});

test('incoming: server errors are shown and buttons come back', async () => {
    const { page } = await h.open('pages/admin/incoming.html', {
        'GET /auth/me': me('cashier'), 'GET /staff/incoming': [200, { orders: [incomingRow()] }],
        'POST /staff/orders/7/accept': [400, { error: 'Only new orders can be accepted' }]
    });
    await page.waitForSelector('[data-order="7"] .btn-act.primary');
    await page.click('[data-order="7"] .btn-act.primary');
    await page.waitForSelector('.board-toast.error');
    assert.equal(await text(page, '.board-toast.error'), 'Only new orders can be accepted');
    assert.equal(await page.$eval('[data-order="7"] .btn-act.primary', b => b.disabled), false);
});

test('incoming: shows "offline" when the server stops answering', async () => {
    let up = true;
    const { page } = await h.open('pages/admin/incoming.html', {
        'GET /auth/me': me('cashier'),
        'GET /staff/incoming': () => (up ? [200, { orders: [] }] : [500, { error: 'Something went wrong on the server. Please try again.' }])
    });
    await page.waitForFunction(() => document.getElementById('liveStatus').textContent.includes('Live'));
    up = false;
    await page.waitForSelector('#liveStatus.offline', { timeout: 8000 });
    up = true;
    await page.waitForSelector('#liveStatus:not(.offline)', { timeout: 8000 });
});

test('incoming: the chef is sent back to the kitchen', async () => {
    const { page } = await h.open('pages/admin/incoming.html', { 'GET /auth/me': me('kitchen'), 'GET /staff/kitchen': [200, { orders: [] }] });
    await page.waitForFunction(() => location.pathname.endsWith('kitchen.html'));
});

// ---------- kitchen ----------
test('kitchen: two columns, no payment details, chef-only nav', async () => {
    const { page } = await h.open('pages/admin/kitchen.html', {
        'GET /auth/me': me('kitchen'),
        'GET /staff/kitchen': [200, { orders: [kitchenRow(), kitchenRow({ order_id: 8, status: 'Preparing', minutes_until_due: -4 }), kitchenRow({ order_id: 9, minutes_until_due: 413 })] }]
    });
    await page.waitForSelector('#column-cooking [data-order="8"]');
    assert.equal(await text(page, '#count-todo'), '2');
    assert.equal(await text(page, '#count-cooking'), '1');
    assert.equal(await text(page, '[data-order="8"] .due'), '4 min late');
    assert.equal(await page.$eval('[data-order="8"] .due', e => e.classList.contains('urgent')), true);
    assert.equal(await text(page, '[data-order="9"] .due'), 'Due in 6 h 53 min');
    assert.match(await text(page, '[data-order="7"] .card-note'), /Less spicy/);
    assert.doesNotMatch(await text(page, '.board-columns'), /Rs\.|Cash|JazzCash|Easypaisa/);
    assert.deepEqual(await page.$$eval('#boardNav a', a => a.map(x => x.textContent.trim())), ['Kitchen']);
    assert.equal(await page.$('#emptyState:not([hidden])'), await page.$('#emptyState:not([hidden])'));
});

test('kitchen: start and ready call the right endpoints', async () => {
    const { page, calls } = await h.open('pages/admin/kitchen.html', {
        'GET /auth/me': me('kitchen'),
        'GET /staff/kitchen': [200, { orders: [kitchenRow(), kitchenRow({ order_id: 8, status: 'Preparing' })] }],
        'POST /staff/orders/7/start': [200, { order: {} }], 'POST /staff/orders/8/ready': [200, { order: {} }]
    });
    await page.waitForSelector('[data-order="8"]');
    await page.click('[data-order="7"] .btn-act');
    await page.waitForSelector('.board-toast');
    await page.click('[data-order="8"] .btn-act');
    await wait(300);
    assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.key), ['POST /staff/orders/7/start', 'POST /staff/orders/8/ready']);
});

test('kitchen: empty columns say so', async () => {
    const { page } = await h.open('pages/admin/kitchen.html', { 'GET /auth/me': me('kitchen'), 'GET /staff/kitchen': [200, { orders: [] }] });
    await page.waitForSelector('#column-todo.is-empty');
    assert.equal(await page.$eval('#column-todo', e => getComputedStyle(e, '::before').content), '"Nothing here"');
});

// ---------- counter ----------
test('counter: wallet must be confirmed before handing over', async () => {
    let status = 'Pending';
    const { page, calls } = await h.open('pages/admin/counter.html', {
        'GET /auth/me': me('cashier'),
        'GET /staff/counter': () => [200, { orders: [counterRow({ payment_method: 'Easypaisa', transaction_reference: 'EP556677', payment_status: status })] }],
        'POST /staff/orders/7/confirm-payment': () => { status = 'Confirmed'; return [200, { order: {} }]; },
        'POST /staff/orders/7/complete': [200, { order: {} }]
    });
    await page.waitForSelector('[data-order="7"]');
    assert.match(await text(page, '.card-pay'), /Check Easypaisa for Rs\. 290, ID EP556677/);
    assert.equal(await page.$eval('.btn-act[disabled]', b => b.textContent.trim()), 'Hand over');
    await page.click('.btn-act.primary');
    await page.waitForSelector('.paid');
    await page.click('.btn-act.primary');
    await wait(300);
    assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.key), ['POST /staff/orders/7/confirm-payment', 'POST /staff/orders/7/complete']);
});

test('counter: cash is taken on hand-over', async () => {
    const { page } = await h.open('pages/admin/counter.html', { 'GET /auth/me': me('cashier'), 'GET /staff/counter': [200, { orders: [counterRow()] }] });
    await page.waitForSelector('[data-order="7"]');
    assert.match(await text(page, '.card-pay'), /Collect Rs\. 290 cash/);
    assert.equal(await text(page, '.btn-act.primary'), 'Cash taken - hand over');
    assert.equal(await page.$('.btn-act[disabled]'), null);
});

// ---------- dashboard ----------
const DASHBOARD = {
    today: { orders: 5, completed: 2, revenue: 760 },
    counts: { total_orders: 40, waiting_review: 2, in_kitchen: 1, ready: 1 },
    low_stock: [{ item_id: 2, item_name: 'French Fries', stock_quantity: 0, is_available: 1 }, { item_id: 4, item_name: 'Orange Juice', stock_quantity: 3, is_available: 1 }],
    recent_orders: [{ order_id: 12, full_name: '<b>Ali</b>', total_amount: 290, status: 'No Show', order_date: at(-5), items: 'Coffee' }]
};

test('dashboard: numbers, review bell, low stock, recent orders', async () => {
    const { page, errors } = await h.open('pages/admin/dashboard.html', { 'GET /auth/me': me('admin'), 'GET /admin/dashboard': [200, { ...DASHBOARD }] });
    await page.waitForFunction(() => document.getElementById('todayRevenue').textContent === 'Rs. 760');
    assert.equal(await text(page, '#pendingOrders'), '4');
    assert.equal(await text(page, '#pendingTrend'), '2 to review · 1 in kitchen · 1 ready');
    assert.equal(await page.$eval('#reviewBadge', b => !b.hidden && b.textContent), '2');
    assert.deepEqual(await page.$$eval('.stock-count', s => s.map(x => x.textContent)), ['Out of stock', 'Only 3 left']);
    assert.equal(await page.$eval('#recentOrdersBody', e => e.innerHTML.includes('&lt;b&gt;Ali')), true, 'names escaped');
    assert.equal(await page.$eval('#recentOrdersBody .status-badge', e => e.className), 'status-badge status-no-show');
    assert.equal(await text(page, '#adminName'), 'Cafeteria Admin');
    assert.deepEqual(errors, []);
});

test('dashboard: bell hidden when nothing waits; low-stock box hidden when stock is fine', async () => {
    const quiet = { ...DASHBOARD, counts: { ...DASHBOARD.counts, waiting_review: 0 }, low_stock: [] };
    const { page } = await h.open('pages/admin/dashboard.html', { 'GET /auth/me': me('admin'), 'GET /admin/dashboard': [200, quiet] });
    await page.waitForFunction(() => document.getElementById('todayOrders').textContent === '5');
    assert.equal(await page.$eval('#reviewBadge', b => b.hidden), true);
    assert.equal(await page.$eval('#lowStockAlert', b => b.style.display), 'none');
});

test('dashboard: cashier is sent to their own screen', async () => {
    const { page } = await h.open('pages/admin/dashboard.html', { 'GET /auth/me': me('cashier'), 'GET /staff/incoming': [200, { orders: [] }] });
    await page.waitForFunction(() => location.pathname.endsWith('incoming.html'));
});

// ---------- menu management ----------
const ADMIN_MENU = MENU.map((m, i) => ({ ...m, is_available: i === 3 ? 0 : 1, low_stock_threshold: 5, has_orders: i === 0 ? 1 : 0 }));
const CATEGORIES = [{ category_id: 1, category_name: 'Breakfast' }, { category_id: 2, category_name: 'Lunch' }, { category_id: 3, category_name: 'Snacks' }, { category_id: 4, category_name: 'Beverages' }];

test('menu management: table, low-stock, on/off, delete only when never ordered', async () => {
    const { page } = await h.open('pages/admin/menu-management.html', {
        'GET /auth/me': me('admin'), 'GET /categories': [200, { categories: CATEGORIES }], 'GET /admin/menu': [200, { items: ADMIN_MENU }]
    });
    await page.waitForSelector('#menuTableBody tr .edit-btn');
    const rows = await page.$$eval('#menuTableBody tr', r => r.map(row => ({
        name: row.children[1].querySelector('strong').textContent,
        stock: row.children[4].textContent.trim(),
        on: row.children[5].textContent.trim(),
        canDelete: !!row.querySelector('.delete-btn')
    })));
    assert.deepEqual(rows[0], { name: 'Classic Burger', stock: '3 Low', on: 'On', canDelete: false });
    assert.equal(rows[1].stock, 'Out of stock');
    assert.equal(rows[3].on, 'Off');
    assert.deepEqual(await page.$$eval('#itemCategory option', o => o.map(x => x.textContent)), ['Breakfast', 'Lunch', 'Snacks', 'Beverages']);
});

test('menu management: add sends the right fields; duplicate name error is shown', async () => {
    let attempt = 0;
    const { page, calls } = await h.open('pages/admin/menu-management.html', {
        'GET /auth/me': me('admin'), 'GET /categories': [200, { categories: CATEGORIES }], 'GET /admin/menu': [200, { items: ADMIN_MENU }],
        'POST /admin/menu': () => (++attempt === 1 ? [409, { error: 'A menu item with this name already exists' }] : [201, { item_id: 20 }])
    });
    await page.waitForSelector('.edit-btn');
    await page.click('button[data-bs-target="#addItemModal"]');
    await page.waitForSelector('#addItemModal.show');
    await page.type('#itemName', 'Chai');
    await page.select('#itemCategory', '4');
    await page.type('#itemPrice', '40');
    await page.type('#itemStock', '30');
    await page.click('#saveItemBtn');
    await page.waitForFunction(() => document.body.textContent.includes('already exists'));
    assert.equal(await page.$('#addItemModal.show') !== null, true, 'modal stays open after an error');
    await page.click('#saveItemBtn');
    await page.waitForFunction(() => !document.querySelector('#addItemModal.show'));
    assert.deepEqual(calls.filter(c => c.key === 'POST /admin/menu')[1].body, {
        item_name: 'Chai', category_id: 4, price: 40, stock_quantity: 30, description: '', image_url: '', is_available: true, low_stock_threshold: 5
    });
});

test('menu management: edit fills the form and PUTs', async () => {
    const { page, calls } = await h.open('pages/admin/menu-management.html', {
        'GET /auth/me': me('admin'), 'GET /categories': [200, { categories: CATEGORIES }], 'GET /admin/menu': [200, { items: ADMIN_MENU }],
        'PUT /admin/menu/3': [200, { ok: true }]
    });
    await page.waitForSelector('.edit-btn[data-id="3"]');
    await page.click('.edit-btn[data-id="3"]');
    await page.waitForSelector('#addItemModal.show');
    assert.equal(await page.$eval('#itemName', e => e.value), 'Coffee');
    assert.equal(await page.$eval('#itemCategory', e => e.value), '4');
    await page.$eval('#itemStock', e => { e.value = '0'; });
    await page.click('#saveItemBtn');
    await page.waitForFunction(() => !document.querySelector('#addItemModal.show'));
    assert.equal(calls.find(c => c.key === 'PUT /admin/menu/3').body.stock_quantity, 0);
});

// ---------- all orders ----------
test('all orders: search asks the server; modal shows history and next actions', async () => {
    const rows = [{ ...order({ order_id: 7, status: 'Received' }), items: '2 x Classic Burger' }];
    const { page, calls } = await h.open('pages/admin/orders-management.html', {
        'GET /auth/me': me('cashier'), 'GET /staff/orders': [200, { orders: rows }],
        'GET /orders/7': [200, { order: order({ history: [{ new_status: 'Received', changed_at: at(-3), changed_by: 'Customer', note: null }] }) }],
        'POST /staff/orders/7/reject': [200, { order: {} }]
    });
    await page.waitForSelector('.view-btn');
    await page.type('#searchInput', '#0007');
    await page.waitForFunction(() => true);
    await wait(600);
    assert.ok(calls.some(c => c.path === '/staff/orders?q=%230007'), 'debounced search sent once typing stopped');
    await page.click('.view-btn');
    await page.waitForSelector('#orderDetailsModal.show');
    assert.deepEqual(await page.$$eval('#orderActions .order-action', b => b.map(x => x.textContent.trim())), ['Accept', 'Reject...']);
    assert.match(await text(page, '#orderDetailsContent ul'), /Received · .* · Customer/);
    page.promptAnswer = 'Out of burgers';
    await page.click('#orderActions .order-action[data-action="reject"]');
    await page.waitForFunction(() => !document.querySelector('#orderDetailsModal.show'));
    assert.deepEqual(calls.find(c => c.key === 'POST /staff/orders/7/reject').body, { reason: 'Out of burgers' });
});

for (const [status, expected] of [['Accepted', ['Start cooking']], ['Preparing', ['Mark ready']], ['Ready', ['Take payment & hand over']], ['Completed', []], ['Rejected', []]]) {
    test(`all orders: next action for ${status}`, async () => {
        const { page } = await h.open('pages/admin/orders-management.html', {
            'GET /auth/me': me('admin'), 'GET /staff/orders': [200, { orders: [{ ...order({ status }), items: 'x' }] }],
            'GET /orders/7': [200, { order: order({ status }) }]
        });
        await page.waitForSelector('.view-btn');
        await page.click('.view-btn');
        await page.waitForSelector('#orderDetailsModal.show');
        assert.deepEqual(await page.$$eval('#orderActions .order-action', b => b.map(x => x.textContent.trim())), expected);
    });
}

// ---------- reports ----------
test('reports: summary, one chart point per day, CSV export of the range', async () => {
    const { page, calls } = await h.open('pages/admin/reports.html', {
        'GET /auth/me': me('admin'),
        'GET /admin/reports': call => {
            const params = new URL('http://x' + call.path).searchParams;
            return [200, {
                start: params.get('from'), end: params.get('to'),
                summary: { orders: 12, completed_orders: 8, cancelled_or_rejected: 3, no_shows: 1, revenue: 2400, customers: 5, average_order: 300 },
                daily: [{ day: params.get('to'), revenue: 400, orders: 2 }],
                categories: [{ category_name: 'Lunch', sales: 1500, units: 12 }, { category_name: 'Beverages', sales: 900, units: 18 }],
                top_items: [{ item_name: 'Classic Burger', category_name: 'Lunch', units: 10, sales: 1200 }],
                payment_methods: []
            }];
        },
        'GET /staff/orders': [200, { orders: [{ ...order(), items: '2 x Classic Burger' }] }]
    });
    await page.waitForFunction(() => document.getElementById('totalRevenue').textContent === 'Rs. 2,400');
    assert.equal(await text(page, '#avgOrder'), 'Rs. 300');
    assert.equal(await text(page, '#ordersChange'), '8 collected · 3 cancelled/rejected · 1 no-show');
    assert.equal(await page.evaluate(() => revenueChart.data.labels.length), 30);
    assert.equal(await page.evaluate(() => revenueChart.data.datasets[0].data.at(-1)), 400);
    assert.deepEqual(await page.evaluate(() => categoryChart.data.labels), ['Lunch', 'Beverages']);
    assert.match(await text(page, '#popularItemsBody'), /Classic Burger.*10 sold.*Rs\. 1,200.*Rs\. 120/s);

    await page.evaluate(() => { window.__downloads = []; HTMLAnchorElement.prototype.click = function() { window.__downloads.push(this.download); }; });
    await page.evaluate(() => exportReport());
    await page.waitForFunction(() => window.__downloads.length === 1);
    const exportCall = calls.filter(c => c.key === 'GET /staff/orders').at(-1);
    assert.match(exportCall.path, /from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d/);
});

test('reports: start after end is refused before asking the server', async () => {
    const { page, calls } = await h.open('pages/admin/reports.html', {
        'GET /auth/me': me('admin'),
        'GET /admin/reports': [200, { start: '2026-10-01', end: '2026-10-01', summary: { orders: 0, revenue: 0, customers: 0, average_order: 0 }, daily: [], categories: [], top_items: [], payment_methods: [] }]
    });
    await page.waitForFunction(() => document.getElementById('totalOrders').textContent === '0');
    const before = calls.length;
    await page.$eval('#startDate', e => { e.value = '2026-12-01'; });
    await page.$eval('#endDate', e => { e.value = '2026-01-01'; });
    await page.evaluate(() => applyDateFilter());
    assert.equal(calls.length, before);
    assert.ok(await page.evaluate(() => document.body.textContent.includes('Start date must be before end date')));
});

// ---------- monthly bill on the staff screens ----------
test('counter: a monthly-bill order has nothing to collect and is handed over onto the bill', async () => {
    const { page, calls } = await h.open('pages/admin/counter.html', {
        'GET /auth/me': me('cashier'),
        'GET /staff/counter': [200, { orders: [counterRow({ payment_method: 'Account' })] }],
        'POST /staff/orders/7/complete': [200, { order: {} }]
    });
    await page.waitForSelector('[data-order="7"]');
    assert.match(await text(page, '.card-pay'), /Monthly bill - nothing to collect, Rs\. 290 is added to their bill/);
    assert.equal(await text(page, '.card-actions button'), 'Hand over - add to bill');
    await page.click('.card-actions button');
    await page.waitForFunction(() => document.querySelector('.board-toast'));
    assert.ok(calls.some(c => c.key === 'POST /staff/orders/7/complete'));
});

test('incoming: online bill payments to check are flagged with a link', async () => {
    const { page } = await h.open('pages/admin/incoming.html', {
        'GET /auth/me': me('cashier'), 'GET /staff/incoming': [200, { orders: [incomingRow({ payment_method: 'Account' })], bill_payments_to_verify: 2 }]
    });
    await page.waitForSelector('#billNotice:not([hidden])');
    assert.match(await text(page, '#billNotice'), /2 online bill payments to check/);
    assert.equal(await page.$eval('#billNotice a', a => a.getAttribute('href')), 'receivables.html?show=verify');
    assert.match(await text(page, '.card-pay'), /Monthly bill/);
    assert.doesNotMatch(await text(page, '.card-pay'), /verify at pickup/);
});

for (const [label, overrides, expected] of [
    ['cash No Show', { payment_method: 'Cash', payment_status: 'Billed' }, ['Was collected']],
    ['wallet No Show', { payment_method: 'JazzCash', payment_status: 'Billed', transaction_reference: 'JC77' }, ['JazzCash payment verified', 'Was collected']],
    ['paid No Show', { payment_method: 'JazzCash', payment_status: 'Confirmed', transaction_reference: 'JC77' }, ['Was collected']]
]) {
    test(`orders: ${label} offers ${expected.join(' + ')}`, async () => {
        const o = order({ status: 'No Show', ...overrides });
        const { page, calls } = await h.open('pages/admin/orders-management.html', {
            'GET /auth/me': me('cashier'), 'GET /staff/orders': [200, { orders: [{ ...o, items: 'x' }] }],
            'GET /orders/7': [200, { order: o }], 'POST /staff/orders/7/collected': [200, { order: {} }]
        });
        await page.waitForSelector('.view-btn');
        await page.click('.view-btn');
        await page.waitForSelector('#orderDetailsModal.show');
        assert.deepEqual(await page.$$eval('#orderActions .order-action', b => b.map(x => x.textContent.trim())), expected);
        page.dialogAnswer = false;                                   // "Are you sure?" -> Cancel
        await page.click('#orderActions .order-action:last-child');
        await wait(300);
        assert.equal(calls.filter(c => c.key === 'POST /staff/orders/7/collected').length, 0, 'nothing sent when cancelled');
        page.dialogAnswer = true;
        await page.click('#orderActions .order-action:last-child');
        await page.waitForFunction(() => !document.querySelector('#orderDetailsModal.show'));
        assert.equal(calls.filter(c => c.key === 'POST /staff/orders/7/collected').length, 1);
    });
}

const accountRow = (o = {}) => account(o)[1].account;
const receivable = (accounts, pending = [], totals = {}) => [200, {
    accounts, pending, settings: { accounts_open: 1, due_day: 10, default_monthly_limit: 15000 },
    totals: { outstanding: 0, overdue: 0, customers_owing: 0, customers_blocked: 0, to_verify: pending.length, collected_this_month: 0, ...totals }
}];
const PENDING = [{ account_payment_id: 5, user_id: 10, amount: 500, method: 'JazzCash', transaction_reference: 'JC5555555', created_at: at(-30), full_name: 'Naseem Ullah', university_id: 'STU2026', balance: 1240 }];

test('receivable: totals, overdue rows, filters and search', async () => {
    const { page, calls } = await h.open('pages/admin/receivables.html', {
        'GET /auth/me': me('cashier'),
        'GET /staff/accounts': receivable([accountRow({ balance: 1240, overdue: 1000, spent_this_month: 240, pending_payment_count: 1, full_name: '<b>Naseem</b>' })],
                                          PENDING, { outstanding: 1240, overdue: 1000, customers_owing: 1, customers_blocked: 1, collected_this_month: 3000 })
    });
    await page.waitForSelector('.accounts-table tbody tr');
    assert.equal(await text(page, '#totalOutstanding'), 'Rs. 1,240');
    assert.equal(await text(page, '#totalBlocked'), "1 customer can't order");
    assert.equal(await text(page, '#totalCollected'), 'Rs. 3,000');
    assert.equal(await page.$eval('tbody tr', r => r.classList.contains('is-overdue')), true);
    assert.ok((await page.$eval('tbody', e => e.innerHTML)).includes('&lt;b&gt;Naseem'), 'names escaped');
    assert.match(await text(page, 'tbody'), /Payment to check/);
    assert.equal(await page.$eval('#settingsPanel', e => e.hidden), true, 'cashier sees no billing settings');
    await page.click('.segmented button[data-show="overdue"]');
    await page.type('#search', 'STU20');
    await wait(500);
    assert.ok(calls.some(c => c.path === '/staff/accounts?show=overdue&q=STU20'));
});

test('receivable: online payment confirm and reject (with a reason)', async () => {
    const { page, calls } = await h.open('pages/admin/receivables.html', {
        'GET /auth/me': me('cashier'), 'GET /staff/accounts': receivable([], PENDING),
        'POST /staff/account-payments/5/confirm': [200, { ok: true }], 'POST /staff/account-payments/5/reject': [200, { ok: true }]
    });
    await page.waitForSelector('#pendingPanel:not([hidden]) .pending-card');
    assert.match(await text(page, '.pending-card'), /Rs\. 500 by JazzCash · ID JC5555555/);
    await page.click('.pending-card .btn-act.primary');
    await page.waitForFunction(() => document.querySelector('.board-toast'));
    assert.ok(calls.some(c => c.key === 'POST /staff/account-payments/5/confirm'));
    page.promptAnswer = 'Wrong amount';
    await page.click('.pending-card .danger-outline');
    await wait(300);
    assert.deepEqual(calls.find(c => c.key === 'POST /staff/account-payments/5/reject').body, { reason: 'Wrong amount' });
});

test('receivable: cashier records a cash payment from the customer dialog (no waiver option)', async () => {
    const detail = [200, { account: accountRow({ balance: 1240 }), entries: [] }];
    const { page, calls } = await h.open('pages/admin/receivables.html', {
        'GET /auth/me': me('cashier'), 'GET /staff/accounts': receivable([accountRow({ balance: 1240 })]),
        'GET /staff/accounts/10': detail,
        'POST /staff/accounts/10/payments': call => [201, { account: accountRow({ balance: 1240 - call.body.amount }), entries: [] }]
    });
    await page.waitForSelector('.accounts-table tbody button');
    await page.click('.accounts-table tbody button');
    await page.waitForSelector('#accountDialog[open]');
    assert.equal(await page.$eval('#payAmount', e => e.value), '1240');
    assert.deepEqual(await page.$$eval('#payMethod option', o => o.map(x => x.value)), ['Cash', 'Easypaisa', 'JazzCash']);
    assert.equal(await page.$eval('#limitForm', e => e.hidden), true, 'cashier cannot change limits');
    await page.$eval('#payAmount', e => { e.value = '1000'; });
    await page.click('#paymentBtn');
    await page.waitForFunction(() => document.querySelector('#dialogSummary').textContent.includes('Rs. 240'));
    assert.deepEqual(calls.find(c => c.key === 'POST /staff/accounts/10/payments').body, { amount: 1000, method: 'Cash', transaction_reference: null, note: null });
    await page.select('#payMethod', 'JazzCash');
    assert.equal(await page.$eval('#payReferenceRow', e => e.hidden), false, 'wallet needs the transaction ID');
    assert.equal(await page.$eval('#payReference', e => e.required), true);
});

test('receivable: manager waives with a reason, sets a limit and changes billing settings', async () => {
    const { page, calls } = await h.open('pages/admin/receivables.html', {
        'GET /auth/me': me('admin'), 'GET /staff/accounts': receivable([accountRow({ balance: 300 })]),
        'GET /staff/accounts/10': [200, { account: accountRow({ balance: 300 }), entries: [] }],
        'POST /staff/accounts/10/payments': [201, { account: accountRow(), entries: [] }],
        'PUT /staff/accounts/10': call => [200, { account: accountRow({ monthly_limit: call.body.monthly_limit, uses_default_limit: 0, account_enabled: call.body.account_enabled }), entries: [] }],
        'PUT /admin/billing-settings': call => [200, { settings: call.body }]
    });
    await page.waitForSelector('#settingsPanel:not([hidden])');
    await page.click('.accounts-table tbody button');
    await page.waitForSelector('#accountDialog[open]');
    await page.select('#payMethod', 'Waiver');
    assert.equal(await page.$eval('#payNote', e => e.required), true, 'waiver needs a reason');
    assert.match(await text(page, '#paymentBtn'), /Waive amount/);
    await page.type('#payNote', 'Kitchen mistake');
    await page.click('#paymentBtn');
    await page.waitForFunction(() => document.querySelector('#paymentForm').hidden);
    assert.deepEqual(calls.find(c => c.key === 'POST /staff/accounts/10/payments').body, { amount: 300, method: 'Waiver', transaction_reference: null, note: 'Kitchen mistake' });

    await page.$eval('#customerLimit', e => { e.value = '5000'; });
    await page.click('#accountEnabled');
    await page.click('#limitForm button[type="submit"]');
    await wait(300);
    assert.deepEqual(calls.find(c => c.key === 'PUT /staff/accounts/10').body, { account_enabled: false, monthly_limit: 5000 });
    await page.click('.dialog-close');

    await page.click('#settingsPanel summary');
    await page.$eval('#dueDay', e => { e.value = '5'; });
    await page.$eval('#defaultLimit', e => { e.value = '8000'; });
    await page.click('#settingsForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('dueDayText').textContent === '5th');
    assert.deepEqual(calls.find(c => c.key === 'PUT /admin/billing-settings').body, { accounts_open: true, due_day: 5, default_monthly_limit: 8000 });
});
