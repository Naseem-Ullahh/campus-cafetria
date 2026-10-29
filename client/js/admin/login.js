// Staff login: the manager, cashiers and kitchen staff all sign in here,
// and each lands on their own screen (STAFF_HOME in store.js)

// Already signed in? Go straight to your screen
loadCurrentUser().then(user => {
    if (user && STAFF_HOME[user.role]) window.location.href = STAFF_HOME[user.role];
}).catch(() => {});

async function adminLogin(event) {
    event.preventDefault();

    const login = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const error = document.getElementById('error');
    const button = document.getElementById('loginBtn');

    error.innerText = '';
    button.disabled = true;
    try {
        const { user } = await api('/auth/login', { method: 'POST', body: { login, password, staff: true } });
        window.location.href = STAFF_HOME[user.role];
    } catch (e) {
        error.innerText = e.message;
        button.disabled = false;
    }
}
