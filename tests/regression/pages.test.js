// Regression: every page, as every role allowed to see it, at laptop and phone
// width - no JS errors, no missing files, no broken links, no sideways scrolling.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, resetDatabase, launch, session, signIn, placeOrder, staffAction, wait } = require('./live');

let browser, orderId;

const PAGES = {
    public: ['index.html', 'pages/student/login.html', 'pages/admin/login.html'],
    customer: ['pages/student/home.html', 'pages/student/cart.html', 'pages/student/checkout.html', 'pages/student/profile.html',
               'pages/student/order-status.html?order=ORDER', 'pages/student/receipt.html?order=ORDER'],
    admin: ['pages/admin/dashboard.html', 'pages/admin/incoming.html', 'pages/admin/kitchen.html', 'pages/admin/counter.html',
            'pages/admin/orders-management.html', 'pages/admin/menu-management.html', 'pages/admin/reports.html',
            'pages/admin/receivables.html'],
    cashier: ['pages/admin/incoming.html', 'pages/admin/kitchen.html', 'pages/admin/counter.html', 'pages/admin/orders-management.html',
              'pages/admin/receivables.html'],
    kitchen: ['pages/admin/kitchen.html']
};
const LOGINS = { customer: ['STU001', 'student123', false], admin: ['EMP-0001', 'Admin@123', true], cashier: ['EMP-0002', 'Cashier@123', true], kitchen: ['EMP-0003', 'Kitchen@123', true] };

test.before(async () => {
    resetDatabase();
    browser = await launch();
    // One order at each live stage so every board has a card to draw
    const setup = await session(browser, 'setup');
    await signIn(setup, 'STU001', 'student123');
    orderId = await placeOrder(setup, [{ item_id: 1, quantity: 2 }, { item_id: 7, quantity: 1 }], 'JazzCash', 'JC12345678');
    const cooking = await placeOrder(setup, [{ item_id: 8, quantity: 1 }]);
    const ready = await placeOrder(setup, [{ item_id: 5, quantity: 1 }]);
    await placeOrder(setup, [{ item_id: 6, quantity: 1 }]);              // stays on the incoming board
    const admin = await session(browser, 'setup-admin');
    await signIn(admin, 'EMP-0001', 'Admin@123', true);
    for (const id of [cooking, ready]) await staffAction(admin, id, 'accept');
    await staffAction(admin, cooking, 'start');
    await staffAction(admin, ready, 'start');
    await staffAction(admin, ready, 'ready');
});
test.after(async () => { await browser.close(); });

for (const [role, pages] of Object.entries(PAGES)) {
    for (const width of [1366, 390]) {
        test(`${role} pages at ${width}px`, async () => {
            const page = await session(browser, `${role}@${width}`, { width, height: width > 500 ? 860 : 844 });
            if (LOGINS[role]) await signIn(page, ...LOGINS[role]);
            if (role === 'customer') await page.evaluate(() => localStorage.setItem('cart', JSON.stringify([{ id: 7, name: 'Coffee', price: 50, image: '', quantity: 1 }])));
            const report = [];
            for (const pagePath of pages) {
                const url = BASE + pagePath.replace('ORDER', orderId);
                await page.goto(url, { waitUntil: 'networkidle0' });
                await wait(700);
                assert.equal(new URL(page.url()).pathname, new URL(url).pathname, `${role} was redirected away from ${pagePath}`);
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
                if (overflow > 1) report.push(`${pagePath}: scrolls sideways by ${overflow}px`);
                const loading = await page.evaluate(() => /Loading|Connecting\.\.\./.test(document.body.innerText) && !document.querySelector('#liveStatus:not(.offline)'));
                if (loading) report.push(`${pagePath}: still loading`);
            }
            assert.deepEqual([...report, ...page.problems], []);
        });
    }
}

test('every link on every page points somewhere that exists', async () => {
    const admin = await session(browser, 'links-admin');
    await signIn(admin, 'EMP-0001', 'Admin@123', true);
    const student = await session(browser, 'links-student');
    await signIn(student, 'STU001', 'student123');
    const links = new Set();
    const visits = [...[...PAGES.public, ...PAGES.admin].map(p => [admin, p]), ...PAGES.customer.map(p => [student, p.replace('ORDER', orderId)])];
    for (const [page, pagePath] of visits) {
        await page.goto(BASE + pagePath, { waitUntil: 'networkidle0' });
        await wait(1000);                    // admin pages load their navbar separately
        for (const href of await page.$$eval('a[href]', a => a.map(x => x.href))) {
            if (href.startsWith(BASE) && !href.includes('#')) links.add(href.split('?')[0]);
        }
    }
    const broken = [];
    for (const link of links) {
        const response = await fetch(link);
        if (response.status !== 200) broken.push(`${response.status} ${link}`);
    }
    assert.deepEqual(broken, []);
    assert.ok(links.size >= 14, `only found ${links.size} links: ${[...links].join(', ')}`);
});
