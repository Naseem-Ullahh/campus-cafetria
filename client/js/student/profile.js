$(document).ready(function() {
    checkAuth();
    loadProfileData();
    loadOrderHistory();
    updateCartBadge();
    calculateStats();
});

// Check authentication
function checkAuth() {
    const currentUser = localStorage.getItem('currentUser');
    if (!currentUser) {
        window.location.href = 'login.html';
        return;
    }
}

// Load profile data
function loadProfileData() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser'));
    const users = JSON.parse(localStorage.getItem('users') || '[]');
    const user = users.find(u => u.studentId === currentUser.studentId) || currentUser;

    // Set avatar
    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=2B1D16&color=F5F5DC&size=150`;
    $('#profileAvatar').attr('src', avatarUrl);
    $('#navAvatar').attr('src', avatarUrl);

    // Set profile info
    $('#profileName').text(user.name);
    $('#navUserName').text(user.name.split(' ')[0]);
    $('#profileStudentId').text(user.studentId);
    $('#profileEmail').text(user.email);
    $('#profilePhone').text(user.phone || '+92 3XX XXXXXXX');
    $('#profileDepartment').text(user.department || 'Computer Science');

    // Set edit form values
    $('#editName').val(user.name);
    $('#editStudentId').val(user.studentId);
    $('#editEmail').val(user.email);
    $('#editPhone').val(user.phone || '');
    $('#editDepartment').val(user.department || 'Computer Science');
    $('#editAddress').val(user.address || '');
}

// Calculate statistics
function calculateStats() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser'));
    const orders = JSON.parse(localStorage.getItem('orders') || '[]');
    const userOrders = orders.filter(o => o.studentId === currentUser.studentId);

    // Total orders
    $('#totalOrders').text(userOrders.length);

    // Total spent
    const totalSpent = userOrders
        .filter(o => o.status !== 'Cancelled')
        .reduce((sum, o) => sum + o.total, 0);
    $('#totalSpent').text(formatPrice(totalSpent));

    // Favorite item (most ordered)
    const itemCount = {};
    userOrders.forEach(order => {
        order.items.forEach(item => {
            itemCount[item.name] = (itemCount[item.name] || 0) + item.quantity;
        });
    });
    const favoriteItem = Object.keys(itemCount).reduce((a, b) => 
        itemCount[a] > itemCount[b] ? a : b, '-'
    );
    $('#favoriteItem').text(favoriteItem);

    // Reward points (10 points per Rs. 100 spent)
    const points = Math.floor(totalSpent / 100) * 10;
    $('#rewardPoints').text(points);
}

// Load order history
function loadOrderHistory() {
    const currentUser = JSON.parse(localStorage.getItem('currentUser'));
    const orders = JSON.parse(localStorage.getItem('orders') || '[]');
    const userOrders = orders.filter(o => o.studentId === currentUser.studentId);

    const container = $('#orderHistoryContainer');
    container.empty();

    if (userOrders.length === 0) {
        container.html(`
            <div class="empty-state">
                <i class="fas fa-receipt"></i>
                <h4>No Orders Yet</h4>
                <p>Start ordering delicious food from our menu!</p>
                <button class="btn-primary" onclick="window.location.href='home.html'" style="margin-top: 15px;">
                    <i class="fas fa-utensils"></i> Browse Menu
                </button>
            </div>
        `);
        return;
    }

    // Newest orders first
    userOrders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const statusClass = {
        'Received': 'status-pending',
        'Preparing': 'status-preparing',
        'Ready': 'status-ready',
        'Completed': 'status-completed',
        'Cancelled': 'status-cancelled'
    };

    container.html(userOrders.map(order => `
        <div class="order-card">
            <div class="order-header">
                <span class="order-id">#${order.orderId}</span>
                <span class="order-status ${statusClass[order.status] || 'status-pending'}">${order.status}</span>
            </div>
            <div class="order-items">
                ${order.items.map(item => `
                    <div class="order-item">
                        <span>${item.quantity}x ${item.name}</span>
                        <span>${formatPrice(item.price * item.quantity)}</span>
                    </div>
                `).join('')}
            </div>
            <div class="order-footer">
                <div>
                    <div class="order-total">${formatPrice(order.total)}</div>
                    <div class="order-date">${new Date(order.timestamp).toLocaleString()}</div>
                </div>
                <div>
                    ${order.status !== 'Completed' && order.status !== 'Cancelled'
                        ? `<button class="btn-reorder" onclick="trackOrder('${order.orderId}')"><i class="fas fa-clock"></i> Track</button>`
                        : ''}
                    <button class="btn-reorder" onclick="reorder('${order.orderId}')"><i class="fas fa-redo"></i> Reorder</button>
                </div>
            </div>
        </div>
    `).join(''));
}

// Open the order status page for one order
function trackOrder(orderId) {
    localStorage.setItem('currentOrder', JSON.stringify(findOrder(orderId)));
    window.location.href = 'order-status.html';
}

// Put the items of an old order back into the cart (only ones still in stock)
function reorder(orderId) {
    const order = findOrder(orderId);
    const menu = getMenuItems();
    const cart = JSON.parse(localStorage.getItem('cart')) || [];
    let added = 0;

    order.items.forEach(orderItem => {
        const menuItem = menu.find(m => m.id === orderItem.id) || menu.find(m => m.name === orderItem.name);
        if (!menuItem || !isInStock(menuItem)) return;

        const inCart = cart.find(c => c.id === menuItem.id);
        const quantity = Math.min(orderItem.quantity, menuItem.stock - (inCart ? inCart.quantity : 0));
        if (quantity <= 0) return;

        if (inCart) {
            inCart.quantity += quantity;
        } else {
            cart.push({ id: menuItem.id, name: menuItem.name, price: menuItem.price, image: menuItem.image, quantity });
        }
        added++;
    });

    if (added === 0) {
        alert('Sorry, none of these items are available right now.');
        return;
    }
    localStorage.setItem('cart', JSON.stringify(cart));
    window.location.href = 'cart.html';
}

// Cart badge in the navbar
function updateCartBadge() {
    const cart = JSON.parse(localStorage.getItem('cart')) || [];
    $('#cartCount').text(cart.reduce((sum, item) => sum + item.quantity, 0));
}

// Switch between Order History / Edit Profile / Settings
function switchTab(tab) {
    $('.tab-btn').removeClass('active');
    $(`.tab-btn[onclick="switchTab('${tab}')"]`).addClass('active');
    $('.tab-content').removeClass('active');
    $(`#${tab}Tab`).addClass('active');
}

// Save the edit profile form
function updateProfile(event) {
    event.preventDefault();

    const currentUser = getCurrentUser();
    const users = getUsers();
    const user = users.find(u => u.studentId === currentUser.studentId);
    if (!user) return;

    user.name = $('#editName').val().trim();
    user.email = $('#editEmail').val().trim();
    user.phone = $('#editPhone').val().trim();
    user.department = $('#editDepartment').val();
    user.address = $('#editAddress').val().trim();

    saveUsers(users);
    setCurrentUser(user);
    loadProfileData();
    switchTab('orders');
    alert('Profile updated successfully!');
}

function cancelEdit() {
    loadProfileData();
    switchTab('orders');
}

function changePassword() {
    const currentPassword = $('#currentPassword').val();
    const newPassword = $('#newPassword').val();
    const confirmPassword = $('#confirmNewPassword').val();

    const users = getUsers();
    const user = users.find(u => u.studentId === getCurrentUser().studentId);

    if (!user || user.password !== currentPassword) {
        alert('Current password is incorrect');
        return;
    }
    if (newPassword.length < 6) {
        alert('New password must be at least 6 characters');
        return;
    }
    if (newPassword !== confirmPassword) {
        alert('New passwords do not match');
        return;
    }

    user.password = newPassword;
    saveUsers(users);
    $('#currentPassword, #newPassword, #confirmNewPassword').val('');
    alert('Password updated successfully!');
}

// Avatar is generated from the student's name
function changeAvatar() {
    alert('Your avatar is created from your name. Change your name in Edit Profile to update it.');
}

function logout() {
    if (confirm('Are you sure you want to logout?')) {
        studentLogout();
    }
}
