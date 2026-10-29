// Switch between Login and Register tabs
function switchTab(tab) {
    const loginTab = document.querySelector('.tab-btn:first-child');
    const registerTab = document.querySelector('.tab-btn:last-child');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const alertMessage = document.getElementById('alertMessage');

    // Hide alert when switching tabs
    alertMessage.classList.remove('show');

    if (tab === 'login') {
        loginTab.classList.add('active');
        registerTab.classList.remove('active');
        loginForm.classList.add('active');
        registerForm.classList.remove('active');
    } else {
        registerTab.classList.add('active');
        loginTab.classList.remove('active');
        registerForm.classList.add('active');
        loginForm.classList.remove('active');
    }
}

// Toggle password visibility
function togglePassword(inputId) {
    const input = document.getElementById(inputId);
    const icon = input.nextElementSibling.querySelector('i');
    
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
}

// Show alert message
function showAlert(message, type) {
    const alertBox = document.getElementById('alertMessage');
    alertBox.className = `alert alert-${type} show`;
    alertBox.textContent = message;

    // The message sits at the top of the card - bring it into view
    // (on small screens the Register button is far below it)
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Auto hide after 4 seconds
    setTimeout(() => {
        alertBox.classList.remove('show');
    }, 4000);
}

// Handle Login Form Submission
function handleLogin(event) {
    event.preventDefault();
    
    const studentId = document.getElementById('loginStudentId').value.trim();
    const password = document.getElementById('loginPassword').value;

    // Basic validation
    if (studentId.length < 4) {
        showAlert('Enter your university ID (at least 4 characters) or email', 'danger');
        return;
    }

    if (password.length < 6) {
        showAlert('Password must be at least 6 characters', 'danger');
        return;
    }

    // Check against registered students (ID or email)
    const user = getUsers().find(u =>
        (u.studentId.toLowerCase() === studentId.toLowerCase() || u.email.toLowerCase() === studentId.toLowerCase()) &&
        u.password === password
    );

    if (!user) {
        showAlert('Invalid student ID or password', 'danger');
        return;
    }

    setCurrentUser(user);
    showAlert('Login successful! Redirecting...', 'success');
    
    // Redirect to home page after 1.5 seconds
    setTimeout(() => {
        window.location.href = 'home.html';
    }, 1500);
}

// Handle Register Form Submission
function handleRegister(event) {
    event.preventDefault();
    
    const name = document.getElementById('regName').value.trim();
    const studentId = document.getElementById('regStudentId').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const userType = document.getElementById('regUserType').value;
    const phone = normalizePakistaniMobile(document.getElementById('regPhone').value);
    const password = document.getElementById('regPassword').value;
    const confirmPassword = document.getElementById('regConfirmPassword').value;

    // Validation
    if (name.length < 3) {
        showAlert('Name must be at least 3 characters', 'danger');
        return;
    }

    if (studentId.length < 4) {
        showAlert('University ID must be at least 4 characters', 'danger');
        return;
    }

    if (!email.includes('@')) {
        showAlert('Please enter a valid email address', 'danger');
        return;
    }

    if (!phone) {
        showAlert('Enter a Pakistani mobile number, e.g. 0300 1234567', 'danger');
        return;
    }

    if (password.length < 6) {
        showAlert('Password must be at least 6 characters', 'danger');
        return;
    }

    if (password !== confirmPassword) {
        showAlert('Passwords do not match', 'danger');
        return;
    }

    const users = getUsers();
    if (users.some(u => u.studentId.toLowerCase() === studentId.toLowerCase())) {
        showAlert('This university ID is already registered', 'danger');
        return;
    }
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
        showAlert('This email is already registered', 'danger');
        return;
    }

    // Save the new student (frontend only - a real app would hash the password on a server)
    users.push({ name, studentId, email, phone, password, userType, department: '', address: '' });
    saveUsers(users);
    document.getElementById('loginStudentId').value = studentId;
    showAlert('Registration successful! Please login.', 'success');
    
    // Switch to login tab after 2 seconds
    setTimeout(() => {
        switchTab('login');
    }, 2000);
}
