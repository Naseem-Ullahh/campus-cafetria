// Splash: write the cafe's name once per visit, then fade away
(function runSplash() {
    const splash = document.getElementById('splash');
    let seen = false;
    try { seen = sessionStorage.getItem('splashSeen') === '1'; } catch (e) { /* storage blocked */ }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (seen || reduceMotion) {
        splash.classList.add('skip');
        return;
    }
    try { sessionStorage.setItem('splashSeen', '1'); } catch (e) { /* storage blocked */ }

    // Start writing once the script font has loaded (or after 1.2s, whichever is first),
    // so the name never flashes in a fallback font
    const fontReady = document.fonts ? document.fonts.load("64px 'Great Vibes'") : Promise.resolve();
    const timeout = new Promise(resolve => setTimeout(resolve, 1200));
    Promise.race([fontReady, timeout]).then(() => {
        splash.classList.add('ready');
        setTimeout(() => splash.classList.add('done'), 2300);
        setTimeout(() => splash.remove(), 3000);
    });
})();

// Smooth scrolling for in-page links
document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', event => {
        const target = document.querySelector(link.getAttribute('href'));
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
    });
});

// Logged-in visitors get a shortcut back to the menu
(async function welcomeBack() {
    let user = null;
    try {
        const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (response.ok) user = (await response.json()).user;
    } catch (e) { /* server not reachable: just skip the card */ }
    if (!user || user.role !== 'customer') return;
    user.name = user.full_name;

    const card = document.createElement('div');
    card.className = 'welcome-back';
    card.innerHTML = `
        <h5>Welcome back, ${user.name.split(' ')[0]}!</h5>
        <p>Ready to order?</p>
        <a href="pages/student/home.html" class="btn-cta">Go to menu</a>
    `;
    document.body.appendChild(card);

    setTimeout(() => {
        card.classList.add('hide');
        setTimeout(() => card.remove(), 500);
    }, 5000);
})();
