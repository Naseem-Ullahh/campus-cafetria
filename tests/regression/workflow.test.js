// Regression: the whole order lifecycle in real browsers, every role at once,
// against the real Flask server and MySQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, resetDatabase, launch, session, wait } = require('./live');

let browser, student, cashier, chef, manager, orderId, secondId;
const text = (page, sel) => page.$eval(sel, e => e.textContent.trim());

async function staffLogin(page, id, password) {
    await page.goto(BASE + 'pages/admin/login.html', { waitUntil: 'networkidle0' });
    await page.type('#username', id);
    await page.type('#password', password);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#loginBtn')]);
    return page.url();
}
async function addByName(page, name) {
    await page.evaluate(n => [...document.querySelectorAll('.food-card')]
        .find(c => c.querySelector('.food-name').textContent === n).querySelector('.add-to-cart-btn').click(), name);
}

test.before(async () => {
    resetDatabase();
    browser = await launch();
    student = await session(browser, 'student');
    cashier = await session(browser, 'cashier');
    chef = await session(browser, 'chef');
    manager = await session(browser, 'manager');
});
test.after(async () => {
    const problems = [student, cashier, chef, manager].flatMap(p => p.problems);
    await browser.close();
    assert.deepEqual(problems, [], 'no JS errors, missing files or server errors during the whole run');
});

test('student registers (Pakistani number only) and is greeted by name', async () => {
    await student.goto(BASE + 'pages/student/login.html', { waitUntil: 'networkidle0' });
    await student.click('.tab-btn:last-child');
    for (const [id, value] of [['#regName', 'Naseem Ullah'], ['#regStudentId', 'stu2026'], ['#regEmail', 'naseem@university.edu'],
                               ['#regPhone', '+91 9876543210'], ['#regPassword', 'secret123'], ['#regConfirmPassword', 'secret123']]) {
        await student.type(id, value);
    }
    await student.click('#registerForm button[type="submit"]');
    await wait(300);
    assert.match(await text(student, '#alertMessage'), /Pakistani mobile/);
    await student.$eval('#regPhone', e => { e.value = '0300 1234567'; });
    await Promise.all([student.waitForNavigation({ waitUntil: 'networkidle0' }), student.click('#registerForm button[type="submit"]')]);
    await student.waitForSelector('.food-card');
    assert.equal(await text(student, '#welcomeName'), 'Naseem');
});

test('student orders with Easypaisa; the server prices it', async () => {
    await addByName(student, 'Classic Burger');
    await addByName(student, 'Classic Burger');
    await addByName(student, 'Coffee');
    await student.goto(BASE + 'pages/student/checkout.html', { waitUntil: 'networkidle0' });
    await student.click('.payment-option:nth-child(2)');
    await student.type('#transactionRef', 'EP99887766');
    await Promise.all([student.waitForNavigation({ waitUntil: 'networkidle0' }), student.click('#placeOrderBtn')]);
    await student.waitForFunction(() => document.getElementById('grandTotal').innerText !== '');
    assert.equal(await text(student, '#grandTotal'), 'Rs. 290');
    orderId = Number((await text(student, '#orderId')).replace('#', ''));
});

test('the same transaction ID cannot be used twice', async () => {
    await student.goto(BASE + 'pages/student/home.html', { waitUntil: 'networkidle0' });
    await student.waitForSelector('.food-card');
    await addByName(student, 'Samosa');
    await student.goto(BASE + 'pages/student/checkout.html', { waitUntil: 'networkidle0' });
    await student.click('.payment-option:nth-child(3)');
    await student.type('#transactionRef', 'EP99887766');
    await student.click('#placeOrderBtn');
    await student.waitForFunction(() => document.body.textContent.includes('already been used'));
    await student.evaluate(() => localStorage.removeItem('cart'));
});

test('cashier accepts on the incoming board', async () => {
    assert.ok((await staffLogin(cashier, 'EMP-0002', 'Cashier@123')).endsWith('incoming.html'));
    await cashier.waitForSelector(`[data-order="${orderId}"]`);
    await cashier.click(`[data-order="${orderId}"] .btn-act.primary`);
    await cashier.waitForFunction(id => !document.querySelector(`[data-order="${id}"]`), {}, orderId);
});

test('chef cooks it; the student sees each step', async () => {
    assert.ok((await staffLogin(chef, 'EMP-0003', 'Kitchen@123')).endsWith('kitchen.html'));
    await chef.waitForSelector(`#column-todo [data-order="${orderId}"]`);
    await chef.click(`[data-order="${orderId}"] .btn-act`);
    await chef.waitForSelector(`#column-cooking [data-order="${orderId}"]`);
    await student.goto(BASE + `pages/student/order-status.html?order=${orderId}`, { waitUntil: 'networkidle0' });
    await student.waitForFunction(() => document.getElementById('orderStatus').textContent === 'Preparing');
    await chef.click(`[data-order="${orderId}"] .btn-act`);
    await chef.waitForFunction(id => !document.querySelector(`[data-order="${id}"]`), {}, orderId);
    await student.click('.refresh-btn');
    await student.waitForFunction(() => document.getElementById('headerTitle').textContent === 'Ready for pickup!');
});

test('cashier verifies the wallet payment, then hands over', async () => {
    await cashier.goto(BASE + 'pages/admin/counter.html', { waitUntil: 'networkidle0' });
    await cashier.waitForSelector(`[data-order="${orderId}"] .btn-act[disabled]`);
    await cashier.click(`[data-order="${orderId}"] .btn-act.primary`);
    await cashier.waitForSelector(`[data-order="${orderId}"] .paid`);
    await cashier.click(`[data-order="${orderId}"] .btn-act.primary`);
    await cashier.waitForFunction(id => !document.querySelector(`[data-order="${id}"]`), {}, orderId);
    await student.click('.refresh-btn');
    await student.waitForFunction(() => document.getElementById('orderStatus').textContent === 'Completed');
    const times = await student.$$eval('.timeline-time', els => els.map(e => e.textContent));
    assert.equal(times.length, 5);
    assert.ok(times.every(t => /\d:\d\d/.test(t)), times.join(' | '));
});

test('a rejected order shows the reason to the student', async () => {
    await student.goto(BASE + 'pages/student/home.html', { waitUntil: 'networkidle0' });
    await student.waitForSelector('.food-card');
    await addByName(student, 'Samosa');
    await student.goto(BASE + 'pages/student/checkout.html', { waitUntil: 'networkidle0' });
    await Promise.all([student.waitForNavigation({ waitUntil: 'networkidle0' }), student.click('#placeOrderBtn')]);
    secondId = Number(new URL(student.url()).searchParams.get('order'));
    await cashier.goto(BASE + 'pages/admin/incoming.html', { waitUntil: 'networkidle0' });
    await cashier.waitForSelector(`[data-order="${secondId}"]`);
    await cashier.click(`[data-order="${secondId}"] .danger-outline`);
    await cashier.click(`#reject-${secondId} .chip`);
    await cashier.click(`#reject-${secondId} .btn-act.danger`);
    await cashier.waitForFunction(id => !document.querySelector(`[data-order="${id}"]`), {}, secondId);
    await student.goto(BASE + `pages/student/order-status.html?order=${secondId}`, { waitUntil: 'networkidle0' });
    await student.waitForSelector('#closedBanner:not([hidden])');
    assert.match(await text(student, '#closedBanner'), /An item is not available/);
    assert.match(await text(student, '#headerText'), /Nothing was charged/);
});

test('a student can cancel while waiting, but not once cooking started', async () => {
    const ids = [];
    for (let i = 0; i < 2; i++) {
        await student.goto(BASE + 'pages/student/home.html', { waitUntil: 'networkidle0' });
        await student.waitForSelector('.food-card');
        await addByName(student, 'Coffee');
        await student.goto(BASE + 'pages/student/checkout.html', { waitUntil: 'networkidle0' });
        await Promise.all([student.waitForNavigation({ waitUntil: 'networkidle0' }), student.click('#placeOrderBtn')]);
        ids.push(Number(new URL(student.url()).searchParams.get('order')));
    }
    await student.goto(BASE + `pages/student/order-status.html?order=${ids[0]}`, { waitUntil: 'networkidle0' });
    await student.waitForSelector('#cancelRow:not([hidden])');
    await student.click('.btn-cancel-order');
    await student.waitForFunction(() => document.getElementById('headerTitle').textContent === 'Order cancelled');

    await cashier.goto(BASE + 'pages/admin/incoming.html', { waitUntil: 'networkidle0' });
    await cashier.waitForSelector(`[data-order="${ids[1]}"]`);
    await cashier.click(`[data-order="${ids[1]}"] .btn-act.primary`);
    await chef.goto(BASE + 'pages/admin/kitchen.html', { waitUntil: 'networkidle0' });
    await chef.waitForSelector(`[data-order="${ids[1]}"]`);
    await chef.click(`[data-order="${ids[1]}"] .btn-act`);
    await chef.waitForSelector(`#column-cooking [data-order="${ids[1]}"]`);
    await student.goto(BASE + `pages/student/order-status.html?order=${ids[1]}`, { waitUntil: 'networkidle0' });
    await student.waitForSelector('.timeline-item');
    assert.equal(await student.$eval('#cancelRow', e => e.hidden), true);
});

test('manager: dashboard, history with names, reports, menu change reaches students', async () => {
    assert.ok((await staffLogin(manager, 'EMP-0001', 'Admin@123')).endsWith('dashboard.html'));
    await manager.waitForFunction(() => document.getElementById('todayRevenue').textContent === 'Rs. 290');
    await manager.goto(BASE + 'pages/admin/orders-management.html', { waitUntil: 'networkidle0' });
    await manager.waitForSelector(`.view-btn[data-id="${orderId}"]`);
    await manager.click(`.view-btn[data-id="${orderId}"]`);
    await manager.waitForSelector('#orderDetailsModal.show');
    await wait(300);
    assert.match(await text(manager, '#orderDetailsContent ul'), /Counter Cashier[\s\S]*Head Chef[\s\S]*Counter Cashier/);
    await manager.goto(BASE + 'pages/admin/reports.html', { waitUntil: 'networkidle0' });
    await manager.waitForFunction(() => document.getElementById('totalRevenue').textContent === 'Rs. 290');
    await manager.goto(BASE + 'pages/admin/menu-management.html', { waitUntil: 'networkidle0' });
    await manager.waitForSelector('.edit-btn');
    await manager.click('button[data-bs-target="#addItemModal"]');
    await manager.waitForSelector('#addItemModal.show');
    await manager.type('#itemName', 'Kashmiri Chai');
    await manager.type('#itemPrice', '60');
    await manager.type('#itemStock', '40');
    await manager.click('#saveItemBtn');
    await manager.waitForFunction(() => document.getElementById('menuTableBody').textContent.includes('Kashmiri Chai'));
    await student.goto(BASE + 'pages/student/home.html', { waitUntil: 'networkidle0' });
    await student.waitForFunction(() => document.body.textContent.includes('Kashmiri Chai'));
});

test('role guards hold in the browser', async () => {
    await student.goto(BASE + 'pages/admin/dashboard.html', { waitUntil: 'networkidle0' });
    assert.ok(student.url().endsWith('admin/login.html'));
    await cashier.goto(BASE + 'pages/admin/reports.html', { waitUntil: 'networkidle0' });
    assert.ok(cashier.url().endsWith('incoming.html'));
    await chef.goto(BASE + 'pages/admin/counter.html', { waitUntil: 'networkidle0' });
    assert.ok(chef.url().endsWith('kitchen.html'));
    await manager.goto(BASE + 'pages/student/home.html', { waitUntil: 'networkidle0' });
    assert.ok(manager.url().endsWith('student/login.html'), 'staff accounts cannot use the student menu');
});

test('logout ends the session', async () => {
    await student.goto(BASE + 'pages/student/profile.html', { waitUntil: 'networkidle0' });
    await student.click(`.tab-btn[onclick="switchTab('settings')"]`);
    await student.waitForSelector('.btn-logout', { visible: true });
    await Promise.all([student.waitForNavigation({ waitUntil: 'networkidle0' }), student.click('.btn-logout')]);
    await student.goto(BASE + 'pages/student/home.html', { waitUntil: 'networkidle0' });
    assert.ok(student.url().endsWith('student/login.html'));
});
