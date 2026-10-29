// If already logged in, go straight to the dashboard
if (localStorage.getItem('adminSession')) {
    window.location.href = 'dashboard.html';
}

function adminLogin(event) {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    // Dummy credentials (frontend only - replaced by the Flask API later)
    if (username === 'admin' && password === 'admin123') {
        localStorage.setItem('adminSession', JSON.stringify({
            username: username,
            loginTime: new Date().toISOString()
        }));
        window.location.href = 'dashboard.html';
    } else {
        document.getElementById('error').innerText = 'Invalid admin credentials';
    }
}
