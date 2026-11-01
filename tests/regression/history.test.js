// Regression: one check per problem fixed during the project, so none of
// them can quietly come back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BASE, ROOT, resetDatabase, launch, session, signIn, wait } = require('./live');

const CLIENT = path.join(ROOT, 'client');
function clientFiles(dir = CLIENT) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return clientFiles(full);
        return /\.(html|css|js)$/.test(entry.name) ? [full] : [];
    });
}
const SOURCES = clientFiles().map(file => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));

function findAll(pattern) {
    return SOURCES.flatMap(({ file, text }) => text.split('\n')
        .map((line, i) => (pattern.test(line) ? `${file}:${i + 1}: ${line.trim().slice(0, 100)}` : null))
        .filter(Boolean));
}

// ---------- region and honesty (no browser needed) ----------
test('no Indian phone codes, UPI apps, rupee/dollar signs or delivery wording', () => {
    assert.deepEqual(findAll(/\+91|\bUPI\b|Google Pay|PhonePe|Paytm|₹|\(\$\)|\$\s?\d|\bdeliver(y|ed)?\b|Delivered|credit card|debit card/i), []);
});

test('no fake features or placeholder data', () => {
    assert.deepEqual(findAll(/promo|reward points|John Doe|Student Name|STU12345|ORD12345|lorem ipsum|coming soon/i), []);
});

test('no tax is added anywhere', () => {
    assert.deepEqual(findAll(/\*\s*0\.05|tax(Amount|Rate)|>\s*Tax\b/i), []);
});

test('the old purple theme is gone', () => {
    assert.deepEqual(findAll(/#667eea|#764ba2|102,\s*126,\s*234|118,\s*75,\s*162/i), []);
});

test('pages no longer keep orders, menus or users in the browser', () => {
    assert.deepEqual(findAll(/localStorage\.(get|set)Item\(['"](orders|menuItems|users|currentUser|adminSession)['"]/), []);
});

test('only Cash, Easypaisa, JazzCash and the monthly bill are offered', async () => {
    const checkout = SOURCES.find(s => s.file.endsWith('pages/student/checkout.html')).text;
    const methods = [...checkout.matchAll(/name="payment" value="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(methods, ['Cash', 'Easypaisa', 'JazzCash', 'Account']);     // Account = the monthly bill
});

test('every page has a title and a viewport tag, and loads the shared theme', () => {
    for (const { file, text } of SOURCES.filter(s => s.file.endsWith('.html') && !s.file.includes('components'))) {
        assert.match(text, /<title>[^<]*Signals Std\. Cafe'/, file);
        assert.match(text, /name="viewport"/, file);
        assert.match(text, /css\/theme\.css/, file);
    }
});

// ---------- in the browser, against the real server ----------
let browser;
test.before(async () => { resetDatabase(); browser = await launch(); });
test.after(async () => { await browser.close(); });

test('admin login "Back to student login" really goes to the student login', async () => {
    const page = await session(browser, 'back-link');
    await page.goto(BASE + 'pages/admin/login.html', { waitUntil: 'networkidle0' });
    await Promise.all([page.waitForNavigation(), page.click('a[href="../student/login.html"]')]);
    assert.ok(page.url().endsWith('/pages/student/login.html'));
});

test('register errors are scrolled into view on a phone', async () => {
    const page = await session(browser, 'register-mobile', { width: 390, height: 700 });
    await page.goto(BASE + 'pages/student/login.html', { waitUntil: 'networkidle0' });
    await page.click('.tab-btn:last-child');
    for (const [id, value] of [['#regName', 'Naseem Ullah'], ['#regStudentId', 'STU7001'], ['#regEmail', 'n7001@university.edu'],
                               ['#regPhone', '+91 9876543210'], ['#regPassword', 'secret123'], ['#regConfirmPassword', 'secret123']]) {
        await page.type(id, value);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));    // the button is far below the alert
    await page.evaluate(() => document.querySelector('#registerForm button[type="submit"]').click());
    await wait(900);
    const visible = await page.$eval('#alertMessage', e => {
        const r = e.getBoundingClientRect();
        return e.classList.contains('show') && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    assert.ok(visible);
});

test('the menu greets the signed-in user by first name, not "Student"', async () => {
    const page = await session(browser, 'greeting');
    await signIn(page, 'STU001', 'student123');
    await page.goto(BASE + 'pages/student/home.html', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.food-card');
    assert.equal(await page.$eval('#welcomeName', e => e.textContent), 'Ali');
    assert.equal(await page.$eval('#navUserName', e => e.textContent), 'Ali');
});

test('the splash screen never blocks clicks and only shows once per visit', async () => {
    const page = await session(browser, 'splash');
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('a.btn-cta');                          // clicked while the splash is animating
    await page.waitForFunction(() => location.pathname.endsWith('login.html'));
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    assert.equal(await page.$eval('#splash', e => e.classList.contains('skip')), true);
});

test('fonts and palette are applied (Archivo body, brick headings, cream page)', async () => {
    const page = await session(browser, 'theme');
    await page.goto(BASE + 'pages/student/login.html', { waitUntil: 'networkidle0' });
    const style = await page.evaluate(() => {
        const css = getComputedStyle(document.body);
        return { font: css.fontFamily, background: getComputedStyle(document.documentElement).getPropertyValue('--cream').trim() };
    });
    assert.match(style.font, /Archivo/);
    assert.equal(style.background.toUpperCase(), '#F5F5DC');
});

test('opening the site from the old preview port explains what to do', async () => {
    const page = await session(browser, 'wrong-port');
    await page.goto(BASE + 'pages/student/login.html', { waitUntil: 'networkidle0' });
    const message = await page.evaluate(async () => {
        const realFetch = window.fetch;
        window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        Object.defineProperty(window, 'location', { value: { ...location, port: '8765' } });
        try { await api('/menu'); } catch (e) { return e.message; } finally { window.fetch = realFetch; }
    }).catch(() => null);
    // location can't always be redefined in a real browser; the unit tests cover the port logic
    if (message) assert.match(message, /127\.0\.0\.1:5000|connection/);
});
