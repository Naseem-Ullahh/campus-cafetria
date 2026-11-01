// Component tests: student pages, each in isolation with a faked API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, me, MENU, order, at, account } = require('./harness');

let h;
test.before(async () => { h = await setup(); });
test.after(async () => { await h.close(); });

// Puts a cart in localStorage once (not again on later page loads)
const cartWith = items => page => page.evaluateOnNewDocument(cart => {
    if (!sessionStorage.getItem('cartSeeded')) {
        localStorage.setItem('cart', cart);
        sessionStorage.setItem('cartSeeded', '1');
    }
}, JSON.stringify(items));
const CART = [{ id: 1, name: 'Classic Burger', price: 120, image: '', quantity: 2 }, { id: 3, name: 'Coffee', price: 50, image: '', quantity: 1 }];
const text = (page, selector) => page.$eval(selector, e => e.textContent.trim());

// ---------- login / register ----------
test('login: server error message is shown and the button re-enabled', async () => {
    const { page, calls, errors } = await h.open('pages/student/login.html', {
        'GET /auth/me': me(null),
        'POST /auth/login': [401, { error: 'Incorrect university ID / email or password' }]
    });
    await page.type('#loginStudentId', 'STU001');
    await page.type('#loginPassword', 'wrong-pass');
    await page.click('#loginForm button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('alertMessage').textContent.includes('Incorrect'));
    assert.deepEqual(calls.find(c => c.key === 'POST /auth/login').body, { login: 'STU001', password: 'wrong-pass' });
    assert.equal(await page.$eval('#loginForm button[type="submit"]', b => b.disabled), false);
    assert.deepEqual(errors, []);
});

test('login: too-short ID is caught before calling the server', async () => {
    const { page, calls } = await h.open('pages/student/login.html', { 'GET /auth/me': me(null) });
    await page.type('#loginStudentId', 'ab');
    await page.type('#loginPassword', 'x');
    await page.click('#loginForm button[type="submit"]');
    assert.match(await text(page, '#alertMessage'), /at least 4 characters/);
    assert.equal(calls.filter(c => c.key === 'POST /auth/login').length, 0);
});

test('login: success clears an old cart and opens the menu', async () => {
    let signedIn = false;
    const { page } = await h.open('pages/student/login.html', {
        'GET /auth/me': () => me(signedIn ? 'customer' : null),
        'POST /auth/login': () => { signedIn = true; return [200, { user: {} }]; },
        'GET /menu': [200, { items: MENU }]
    }, { before: cartWith(CART) });
    await page.type('#loginStudentId', 'STU001');
    await page.type('#loginPassword', 'student123');
    await Promise.all([page.waitForNavigation(), page.click('#loginForm button[type="submit"]')]);
    assert.match(page.url(), /home\.html$/);
    assert.equal(await page.evaluate(() => localStorage.getItem('cart')), null);
});

test('login: already signed-in customers skip straight to the menu', async () => {
    const { page } = await h.open('pages/student/login.html', { 'GET /auth/me': me('customer'), 'GET /menu': [200, { items: MENU }] });
    await page.waitForFunction(() => location.pathname.endsWith('home.html'));
});

test('register: validates locally, then sends exactly the right fields', async () => {
    const { page, calls } = await h.open('pages/student/login.html', {
        'GET /auth/me': me(null), 'POST /auth/register': [201, { user: {} }], 'GET /menu': [200, { items: MENU }]
    });
    await page.click('.tab-btn:last-child');
    await page.type('#regName', 'Naseem Ullah');
    await page.type('#regStudentId', 'STU2026');
    await page.type('#regEmail', 'naseem@university.edu');
    await page.select('#regUserType', 'faculty');
    await page.type('#regPhone', '+91 98765 43210');
    await page.type('#regPassword', 'secret123');
    await page.type('#regConfirmPassword', 'secret124');
    await page.click('#registerForm button[type="submit"]');
    assert.match(await text(page, '#alertMessage'), /Pakistani mobile/);
    await page.$eval('#regPhone', e => { e.value = '+92 300 1234567'; });
    await page.click('#registerForm button[type="submit"]');
    assert.match(await text(page, '#alertMessage'), /do not match/);
    assert.equal(calls.filter(c => c.key === 'POST /auth/register').length, 0);
    await page.$eval('#regConfirmPassword', e => { e.value = 'secret123'; });
    await Promise.all([page.waitForNavigation(), page.click('#registerForm button[type="submit"]')]);
    assert.deepEqual(calls.find(c => c.key === 'POST /auth/register').body, {
        full_name: 'Naseem Ullah', university_id: 'STU2026', email: 'naseem@university.edu',
        phone: '03001234567', user_type: 'faculty', password: 'secret123'
    });
});

// ---------- menu (home) ----------
test('menu: greets by first name, shows items, disables out-of-stock', async () => {
    const { page, errors } = await h.open('pages/student/home.html', { 'GET /auth/me': me('customer'), 'GET /menu': [200, { items: MENU }] });
    await page.waitForSelector('.food-card');
    assert.equal(await text(page, '#welcomeName'), 'Naseem');
    assert.equal(await page.$$eval('.food-card', c => c.length), 4);
    const fries = await page.$$eval('.food-card', cards => {
        const card = cards.find(c => c.textContent.includes('French Fries'));
        return { disabled: card.querySelector('.add-to-cart-btn').disabled, badge: card.querySelector('.food-badge').textContent.trim() };
    });
    assert.deepEqual(fries, { disabled: true, badge: 'Out of stock' });
    assert.ok((await page.content()).includes('Hot &lt;b&gt;brewed&lt;/b&gt;'), 'item text is escaped');
    assert.deepEqual(errors, []);
});

test('menu: category filter and search', async () => {
    const { page } = await h.open('pages/student/home.html', { 'GET /auth/me': me('customer'), 'GET /menu': [200, { items: MENU }] });
    await page.waitForSelector('.food-card');
    await page.click(`.category-pill[onclick*="beverages"]`);
    assert.deepEqual(await page.$$eval('.food-name', n => n.map(x => x.textContent)), ['Coffee']);
    await page.click(`.category-pill[onclick*="'all'"]`);
    await page.type('#searchInput', 'pan');
    await page.evaluate(() => searchFood());
    assert.deepEqual(await page.$$eval('.food-name', n => n.map(x => x.textContent)), ['Pancakes']);
    await page.$eval('#searchInput', e => { e.value = 'zzz'; });
    await page.evaluate(() => searchFood());
    assert.match(await text(page, '#menuContainer'), /No items found/);
});

test('menu: cannot add more than the stock', async () => {
    const { page } = await h.open('pages/student/home.html', { 'GET /auth/me': me('customer'), 'GET /menu': [200, { items: MENU }] });
    await page.waitForSelector('.food-card');
    for (let i = 0; i < 5; i++) await page.evaluate(() => addToCart(1));    // stock is 3
    assert.equal(await text(page, '#cartCount'), '3');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('cart'))[0].quantity), 3);
    assert.ok(await page.evaluate(() => document.body.textContent.includes('Only 3 Classic Burger left')));
});

test('menu: server failure shows a retry state', async () => {
    let fail = true;
    const { page } = await h.open('pages/student/home.html', {
        'GET /auth/me': me('customer'),
        'GET /menu': () => (fail ? [500, { error: 'Something went wrong on the server. Please try again.' }] : [200, { items: MENU }])
    });
    await page.waitForFunction(() => document.getElementById('menuContainer').textContent.includes("Couldn't load"));
    fail = false;
    await page.click('#menuContainer button');
    await page.waitForSelector('.food-card');
});

test('menu: signed-out visitors are sent to login', async () => {
    const { page } = await h.open('pages/student/home.html', { 'GET /auth/me': me(null) });
    await page.waitForFunction(() => location.pathname.endsWith('student/login.html'));
});

// ---------- cart ----------
test('cart: totals, quantity changes, remove, empty state, no promo box', async () => {
    const { page } = await h.open('pages/student/cart.html', { 'GET /auth/me': me('customer') }, { before: cartWith(CART) });
    await page.waitForSelector('.cart-item');
    assert.equal(await text(page, '#itemCount'), '3 items in cart');
    assert.match(await text(page, '.summary-total'), /Rs\. 290/);
    assert.equal(await page.$('#promoCode'), null);
    await page.click('.cart-item:first-child .qty-btn:last-child');
    assert.match(await text(page, '.summary-total'), /Rs\. 410/);
    await page.click('.cart-item:last-child .remove-btn');
    await page.click('.cart-item .remove-btn');
    assert.match(await text(page, '#cartContent'), /Your cart is empty/);
    assert.equal(await page.evaluate(() => localStorage.getItem('cart')), '[]');
});

// ---------- checkout ----------
test('checkout: pickup slots follow the rules (15 min - 24 h, 8 AM - 10 PM, every 15 min)', async () => {
    const { page } = await h.open('pages/student/checkout.html', { 'GET /auth/me': me('customer') }, { before: cartWith(CART) });
    await page.waitForSelector('#pickupTime option[value]');
    const slots = await page.$$eval('#pickupTime option', o => o.map(x => x.value).filter(Boolean));
    assert.ok(slots.length > 20);
    for (const value of slots) {
        const date = new Date(value);
        const ahead = (date - Date.now()) / 60000;
        assert.ok(ahead >= 15 && ahead <= 24 * 60, `${value} is ${ahead} min ahead`);
        assert.ok(date.getHours() >= 8 && date.getHours() < 22, `${value} outside opening hours`);
        assert.equal(date.getMinutes() % 15, 0);
    }
    assert.equal(await page.$eval('#phoneNumber', e => e.readOnly && e.value), '03001234567');
});

test('checkout: wallet needs a transaction ID; only ids + quantities are sent', async () => {
    const { page, calls } = await h.open('pages/student/checkout.html', {
        'GET /auth/me': me('customer'), 'POST /orders': [201, { order: { order_id: 7 } }],
        'GET /orders/7': [200, { order: order() }]
    }, { before: cartWith(CART) });
    await page.waitForSelector('#pickupTime option[value]');
    assert.equal(await page.$eval('#transactionGroup', e => e.hidden), true);
    await page.click('.payment-option:nth-child(3)');     // JazzCash
    assert.equal(await page.$eval('#transactionGroup', e => e.hidden), false);
    await page.type('#transactionRef', 'JC1');
    await page.click('#placeOrderBtn');
    assert.equal(calls.filter(c => c.key === 'POST /orders').length, 0, 'short ID stopped locally');
    await page.type('#transactionRef', '234567');
    await page.type('#specialInstructions', 'Less spicy');
    await Promise.all([page.waitForNavigation(), page.click('#placeOrderBtn')]);
    const sent = calls.find(c => c.key === 'POST /orders').body;
    assert.deepEqual(sent.items, [{ item_id: 1, quantity: 2 }, { item_id: 3, quantity: 1 }]);
    assert.equal(sent.payment_method, 'JazzCash');
    assert.equal(sent.transaction_reference, 'JC1234567');
    assert.equal(sent.special_instructions, 'Less spicy');
    assert.ok(!('total' in sent) && !JSON.stringify(sent.items).includes('price'), 'no prices sent');
    assert.match(page.url(), /receipt\.html\?order=7$/);
    assert.equal(await page.evaluate(() => localStorage.getItem('cart')), null, 'cart cleared');
});

test('checkout: a server rejection keeps the cart and re-enables the button', async () => {
    const { page } = await h.open('pages/student/checkout.html', {
        'GET /auth/me': me('customer'), 'POST /orders': [400, { error: 'Only 1 Classic Burger left in stock' }]
    }, { before: cartWith(CART) });
    await page.waitForSelector('#pickupTime option[value]');
    await page.click('#placeOrderBtn');
    await page.waitForFunction(() => document.body.textContent.includes('Only 1 Classic Burger left'));
    assert.equal(await page.$eval('#placeOrderBtn', b => b.disabled), false);
    assert.ok(await page.evaluate(() => localStorage.getItem('cart')));
});

test('checkout: empty cart shows a notice', async () => {
    const { page } = await h.open('pages/student/checkout.html', { 'GET /auth/me': me('customer') });
    await page.waitForSelector('#emptyCartAlert.show');
});

// ---------- receipt ----------
test('receipt: lines, payment and tracking link', async () => {
    const o = order({ payment_method: 'Easypaisa', transaction_reference: 'EP123456' });
    const { page } = await h.open('pages/student/receipt.html?order=7', { 'GET /auth/me': me('customer'), 'GET /orders/7': [200, { order: o }] });
    await page.waitForFunction(() => document.getElementById('grandTotal').innerText === 'Rs. 290');
    assert.equal(await text(page, '#orderId'), '#0007');
    assert.equal(await page.$$eval('#receiptItems tr', r => r.length), 2);
    assert.equal(await text(page, '#paymentInfo'), 'Easypaisa (ID EP123456) - Not paid yet');
    assert.match(await page.$eval('#trackOrderLink', a => a.href), /order-status\.html\?order=7$/);
});

test("receipt: someone else's order shows the error", async () => {
    const { page } = await h.open('pages/student/receipt.html?order=99', { 'GET /auth/me': me('customer'), 'GET /orders/99': [404, { error: 'Order not found' }] });
    await page.waitForFunction(() => document.getElementById('receiptItems').textContent.includes('Order not found'));
});

// ---------- order tracking, every status ----------
const STATUS_CASES = [
    { status: 'Received', title: 'Order placed!', active: 'Order placed', cancel: true },
    { status: 'Accepted', title: 'Order accepted', active: 'Accepted', cancel: true, extra: { estimated_ready_time: at(55) } },
    { status: 'Preparing', title: 'Being prepared', active: 'Preparing', cancel: false },
    { status: 'Ready', title: 'Ready for pickup!', active: 'Ready for pickup', cancel: false },
    { status: 'Completed', title: 'Enjoy your meal!', active: null, cancel: false },
    { status: 'Cancelled', title: 'Order cancelled', closed: true, cancel: false },
    { status: 'Rejected', title: "We couldn't take this order", closed: true, cancel: false, extra: { close_reason: 'Oven is down' } },
    { status: 'No Show', title: 'Order not collected', closed: true, cancel: false }
];
const ORDERED = ['Received', 'Accepted', 'Preparing', 'Ready', 'Completed'];

for (const c of STATUS_CASES) {
    test(`tracking: ${c.status}`, async () => {
        const reached = c.closed ? ['Received'] : ORDERED.slice(0, ORDERED.indexOf(c.status) + 1);
        const history = reached.map(s => ({ new_status: s, changed_at: at(-2), changed_by: 'x', note: null }));
        if (c.closed) history.push({ new_status: c.status, changed_at: at(-1), changed_by: 'x', note: c.extra?.close_reason || null });
        const o = order({ status: c.status, history, ...c.extra });
        const { page, errors } = await h.open('pages/student/order-status.html?order=7', { 'GET /auth/me': me('customer'), 'GET /orders/7': [200, { order: o }] });
        await page.waitForSelector('.timeline-item');
        assert.equal(await text(page, '#headerTitle'), c.title);
        assert.equal(await page.$eval('#cancelRow', e => !e.hidden), c.cancel);
        assert.equal(await page.$eval('#closedBanner', e => !e.hidden), !!c.closed);
        assert.equal(await page.$eval('.success-hero', e => e.classList.contains('is-closed')), !!c.closed);
        const active = await page.$$eval('.timeline-item.active h4', e => e.map(x => x.textContent));
        assert.deepEqual(active, c.active ? [c.active] : []);
        if (c.status === 'Completed') assert.equal(await page.$$eval('.timeline-item.completed', e => e.length), 5);
        if (c.closed) assert.equal(await page.$$eval('.timeline-item.skipped', e => e.length), 4);
        if (c.extra?.close_reason) assert.match(await text(page, '#closedBanner'), /Oven is down/);
        if (c.extra?.estimated_ready_time) assert.equal(await text(page, '.pickup-info h4'), 'Ready by');
        assert.deepEqual(errors, []);
    });
}

test('tracking: refunded wallet payment is described honestly', async () => {
    const o = order({ status: 'Rejected', payment_status: 'Refunded', payment_method: 'JazzCash', transaction_reference: 'JC1', close_reason: 'x' });
    const { page } = await h.open('pages/student/order-status.html?order=7', { 'GET /auth/me': me('customer'), 'GET /orders/7': [200, { order: o }] });
    await page.waitForSelector('#headerText');
    assert.match(await text(page, '#headerText'), /marked for a refund/);
    assert.equal(await text(page, '#paymentStatus'), 'Refunded');
});

test('tracking: no-show with money owed says so', async () => {
    const o = order({ status: 'No Show', payment_status: 'Billed', history: [{ new_status: 'Received' }, { new_status: 'Accepted' }, { new_status: 'Preparing' }, { new_status: 'Ready' }, { new_status: 'No Show' }].map(h2 => ({ ...h2, changed_at: at(-1) })) });
    const { page } = await h.open('pages/student/order-status.html?order=7', { 'GET /auth/me': me('customer'), 'GET /orders/7': [200, { order: o }] });
    await page.waitForSelector('#closedBanner:not([hidden])');
    assert.match(await text(page, '#closedBanner'), /Rs\. 290 has been added to your monthly bill/);
    assert.equal(await page.$$eval('.timeline-item.completed', e => e.length), 4, 'shows the steps it did reach');
});

test('tracking: cancel button hidden once the deadline passed', async () => {
    const o = order({ cancellation_deadline: at(-1) });
    const { page } = await h.open('pages/student/order-status.html?order=7', { 'GET /auth/me': me('customer'), 'GET /orders/7': [200, { order: o }] });
    await page.waitForSelector('.timeline-item');
    assert.equal(await page.$eval('#cancelRow', e => e.hidden), true);
});

test('tracking: cancelling posts and re-renders', async () => {
    const { page, calls } = await h.open('pages/student/order-status.html?order=7', {
        'GET /auth/me': me('customer'), 'GET /orders/7': [200, { order: order() }],
        'POST /orders/7/cancel': [200, { order: order({ status: 'Cancelled', history: [{ new_status: 'Received', changed_at: at(-3) }, { new_status: 'Cancelled', changed_at: at(0) }] }) }]
    });
    await page.waitForSelector('#cancelRow:not([hidden])');
    await page.click('.btn-cancel-order');
    await page.waitForFunction(() => document.getElementById('headerTitle').textContent === 'Order cancelled');
    assert.equal(calls.filter(c => c.key === 'POST /orders/7/cancel').length, 1);
});

test('tracking: refresh picks up a status change', async () => {
    let status = 'Received';
    const { page } = await h.open('pages/student/order-status.html?order=7', {
        'GET /auth/me': me('customer'),
        'GET /orders/7': () => [200, { order: order({ status, estimated_ready_time: at(50), history: [{ new_status: 'Received', changed_at: at(-3) }, ...(status === 'Accepted' ? [{ new_status: 'Accepted', changed_at: at(0) }] : [])] }) }]
    });
    await page.waitForSelector('.timeline-item');
    status = 'Accepted';
    await page.click('.refresh-btn');
    await page.waitForFunction(() => document.getElementById('orderStatus').textContent === 'Accepted');
    assert.ok(await page.evaluate(() => document.body.textContent.includes('The cafeteria accepted your order')));
});

// ---------- profile ----------
test('profile: stats, order cards and actions', async () => {
    const orders = [
        { ...order({ order_id: 9, status: 'Preparing' }), items: '1 x Coffee' },
        { ...order({ order_id: 8, status: 'Completed', total_amount: 290 }), items: '2 x Classic Burger, 1 x Coffee' },
        { ...order({ order_id: 7, status: 'Rejected', close_reason: 'Oven is down' }), items: '1 x Classic Burger' }
    ];
    const { page } = await h.open('pages/student/profile.html', { 'GET /auth/me': me('customer'), 'GET /orders/mine': [200, { orders }] });
    await page.waitForSelector('.order-card');
    assert.equal(await text(page, '#totalOrders'), '3');
    assert.equal(await text(page, '#collectedOrders'), '1');
    assert.equal(await text(page, '#totalSpent'), 'Rs. 290');
    assert.equal(await text(page, '#favoriteItem'), 'Classic Burger');
    assert.equal(await text(page, '#profileUserType'), 'Student');
    const buttons = await page.$$eval('.order-card', cards => cards.map(c => c.querySelector('.btn-reorder').textContent.trim()));
    assert.deepEqual(buttons, ['Track', 'Receipt', 'Receipt']);
    assert.ok((await text(page, '#orderHistoryContainer')).includes('Oven is down'));
});

test('profile: edit validates phone and sends PATCH', async () => {
    const { page, calls } = await h.open('pages/student/profile.html', {
        'GET /auth/me': me('customer'), 'GET /orders/mine': [200, { orders: [] }],
        'PATCH /auth/me': call => [200, { user: { ...require('./harness').USERS.customer, full_name: call.body.full_name } }]
    });
    await page.waitForSelector('.empty-state');
    await page.evaluate(() => switchTab('edit'));
    await page.$eval('#editPhone', e => { e.value = '+91 9876543210'; });
    await page.click('#editTab button[type="submit"]');
    assert.match(await text(page, '#profileError'), /Pakistani mobile/);
    await page.$eval('#editPhone', e => { e.value = '0321 5550000'; });
    await page.$eval('#editName', e => { e.value = 'Naseem U.'; });
    await page.click('#editTab button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('profileName').textContent === 'Naseem U.');
    assert.deepEqual(calls.find(c => c.key === 'PATCH /auth/me').body, { full_name: 'Naseem U.', email: 'naseem@university.edu', phone: '03215550000' });
});

test('profile: password change checks the confirmation first', async () => {
    const { page, calls } = await h.open('pages/student/profile.html', {
        'GET /auth/me': me('customer'), 'GET /orders/mine': [200, { orders: [] }], 'POST /auth/password': [200, { ok: true }]
    });
    await page.waitForSelector('.empty-state');
    await page.evaluate(() => switchTab('settings'));
    await page.type('#currentPassword', 'old-pass');
    await page.type('#newPassword', 'newpass1');
    await page.type('#confirmNewPassword', 'newpass2');
    await page.evaluate(() => changePassword());
    assert.equal(calls.filter(c => c.key === 'POST /auth/password').length, 0);
    await page.$eval('#confirmNewPassword', e => { e.value = 'newpass1'; });
    await page.evaluate(() => changePassword());
    await page.waitForFunction(() => document.getElementById('newPassword').value === '');
    assert.deepEqual(calls.find(c => c.key === 'POST /auth/password').body, { current_password: 'old-pass', new_password: 'newpass1' });
});

// ---------- landing ----------
test('landing: splash once per visit, welcome-back only for customers', async () => {
    const { page } = await h.open('index.html', { 'GET /auth/me': me('customer') });
    assert.equal(await page.$eval('#splash', e => getComputedStyle(e).pointerEvents), 'none', 'splash never blocks clicks');
    await page.waitForSelector('.welcome-back');
    assert.match(await text(page, '.welcome-back h5'), /Welcome back, Naseem!/);
    await page.reload({ waitUntil: 'networkidle2' });
    assert.equal(await page.$eval('#splash', e => e.classList.contains('skip')), true, 'not shown again in the same visit');
    const staff = await h.open('index.html', { 'GET /auth/me': me('cashier') });
    await new Promise(r => setTimeout(r, 500));
    assert.equal(await staff.page.$('.welcome-back'), null);
});

// ---------- monthly bill ----------
test('checkout: monthly bill shows what is left of the limit and sends Account with no ID', async () => {
    const { page, calls } = await h.open('pages/student/checkout.html', {
        'GET /auth/me': me('customer'), 'GET /account': account({ monthly_limit: 3000, spent_this_month: 1200 }),
        'POST /orders': [201, { order: { order_id: 7 } }], 'GET /orders/7': [200, { order: order() }]
    }, { before: cartWith(CART) });
    await page.waitForSelector('#accountOption:not([hidden])');
    assert.match(await text(page, '#accountOptionText'), /^Rs\. 1,800 left of your Rs\. 3,000 limit this month · due by \d+ \w+ \d{4}$/);
    await page.click('#accountOption');
    assert.equal(await page.$eval('#transactionGroup', e => e.hidden), true, 'no transaction ID for the monthly bill');
    await Promise.all([page.waitForNavigation(), page.click('#placeOrderBtn')]);
    const sent = calls.find(c => c.key === 'POST /orders').body;
    assert.equal(sent.payment_method, 'Account');
    assert.equal(sent.transaction_reference, null);
});

test('checkout: an overdue bill is shown up front and ordering is disabled', async () => {
    const { page } = await h.open('pages/student/checkout.html', {
        'GET /auth/me': me('customer'), 'GET /account': account({ balance: 900, overdue: 650, previous_unpaid: 650 })
    }, { before: cartWith(CART) });
    await page.waitForSelector('#billAlert.show');
    assert.match(await text(page, '#billAlert'), /Rs\. 650 of your monthly bill is overdue/);
    assert.equal(await page.$eval('#billAlert a', a => a.getAttribute('href')), 'profile.html#bill');
    assert.equal(await page.$eval('#placeOrderBtn', b => b.disabled), true);
});

test('checkout: monthly bill can be off for the account or for everyone', async () => {
    for (const [overrides, settings, expected] of [
        [{ account_enabled: 0 }, {}, /Not available on your account/],
        [{}, { accounts_open: 0 }, /Not available right now/]
    ]) {
        const { page } = await h.open('pages/student/checkout.html', {
            'GET /auth/me': me('customer'), 'GET /account': account(overrides, [], settings)
        }, { before: cartWith(CART) });
        await page.waitForSelector('#accountOption:not([hidden])');
        assert.match(await text(page, '#accountOptionText'), expected);
        await page.click('#accountOption');
        assert.equal(await page.$eval('input[value="Account"]', r => r.checked), false, 'disabled option cannot be chosen');
        assert.equal(await page.$eval('input[value="Cash"]', r => r.checked), true);
    }
});

const BILL_ENTRIES = [
    { kind: 'payment', order_id: null, account_payment_id: 3, at: at(-60), amount: 500, method: 'JazzCash', status: 'Pending', order_status: null, transaction_reference: 'JC5555555', note: null, staff_name: null, items: null },
    { kind: 'charge', order_id: 12, account_payment_id: null, at: at(-120), amount: 240, method: 'Account', status: 'Billed', order_status: 'Completed', transaction_reference: null, note: null, staff_name: null, items: '2 x Classic Burger' },
    { kind: 'charge', order_id: 11, account_payment_id: null, at: at(-50 * 24 * 60), amount: 1000, method: 'Cash', status: 'Billed', order_status: 'No Show', transaction_reference: null, note: null, staff_name: null, items: '<b>8 x Coffee</b>' },
    { kind: 'payment', order_id: null, account_payment_id: 1, at: at(-49 * 24 * 60), amount: 100, method: 'Easypaisa', status: 'Rejected', order_status: null, transaction_reference: 'EP1', note: 'No payment with this ID', staff_name: null, items: null }
];

test('profile: Amount Payable shows the bill, overdue warning and statement by month', async () => {
    const { page } = await h.open('pages/student/profile.html#bill', {
        'GET /auth/me': me('customer'), 'GET /orders/mine': [200, { orders: [] }],
        'GET /account': account({ balance: 1240, charged_this_month: 240, spent_this_month: 240, previous_unpaid: 1000, overdue: 1000, pending_payments: 500, pending_payment_count: 1 }, BILL_ENTRIES)
    });
    await page.waitForSelector('.bill-total');
    assert.equal(await page.$eval('#billTab', e => e.classList.contains('active')), true, '#bill opens the tab');
    assert.equal(await text(page, '.bill-total strong'), 'Rs. 1,240');
    assert.match(await text(page, '.bill-status'), /Rs\. 1,000 is overdue - you can't place new orders/);
    assert.match(await text(page, '#billBanner'), /Rs\. 1,000 of your monthly bill is overdue/);
    assert.equal(await page.$eval('#billBanner', e => e.classList.contains('is-overdue')), true);
    assert.equal(await page.$eval('#billAmount', e => e.value), '740', 'suggests what is owed minus payments being checked');
    assert.equal(await page.$$eval('.statement-month', m => m.length), 2);
    assert.match(await text(page, '.statement-month:first-child h4'), /Charged Rs\. 240/);
    const all = await text(page, '#billStatement');
    assert.match(all, /Being checked/);
    assert.match(all, /Not collected/);
    assert.match(all, /Not accepted/);
    assert.ok((await page.$eval('#billStatement', e => e.innerHTML)).includes('&lt;b&gt;8 x Coffee'), 'item text escaped');
});

test('profile: paying online sends the amount, wallet and ID, then shows the new bill', async () => {
    let paid = false;
    const { page, calls } = await h.open('pages/student/profile.html', {
        'GET /auth/me': me('customer'), 'GET /orders/mine': [200, { orders: [] }],
        'GET /account': account({ balance: 300, charged_this_month: 300 }),
        'POST /account/payments': call => { paid = true; return account({ balance: 300, charged_this_month: 300, pending_payments: call.body.amount, pending_payment_count: 1 }); }
    });
    await page.waitForSelector('.bill-total');
    await page.evaluate(() => switchTab('bill'));
    await page.$eval('#billAmount', e => { e.value = '200'; });
    await page.select('#billMethod', 'JazzCash');
    await page.type('#billReference', 'JC12345678');
    await page.click('#payBillBtn');
    await page.waitForFunction(() => document.body.textContent.includes('Being checked'));
    assert.ok(paid);
    assert.deepEqual(calls.find(c => c.key === 'POST /account/payments').body, { amount: 200, method: 'JazzCash', transaction_reference: 'JC12345678' });
    assert.equal(await page.$eval('#billAmount', e => e.value), '100');
});

test('profile: nothing owed hides the payment form and the banner', async () => {
    const { page } = await h.open('pages/student/profile.html', {
        'GET /auth/me': me('customer'), 'GET /orders/mine': [200, { orders: [] }], 'GET /account': account()
    });
    await page.waitForSelector('.bill-total');
    assert.equal(await page.$eval('#payBillCard', e => e.hidden), true);
    assert.equal(await page.$eval('#billBanner', e => e.hidden), true);
    assert.match(await text(page, '.bill-status'), /all paid up/);
    assert.match(await text(page, '#billStatement'), /Add to my monthly bill/);
});

test('tracking: a monthly-bill order says it goes on the bill', async () => {
    const o = order({ payment_method: 'Account' });
    const { page } = await h.open('pages/student/order-status.html?order=7', { 'GET /auth/me': me('customer'), 'GET /orders/7': [200, { order: o }] });
    await page.waitForSelector('.timeline-item');
    assert.equal(await text(page, '#paymentMethod'), 'Monthly bill');
    assert.equal(await text(page, '#paymentStatus'), 'Added to your monthly bill at pickup');
});
