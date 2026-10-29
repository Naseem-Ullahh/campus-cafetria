let myOrders = [];

$(document).ready(async function() {
    const user = await requireStudentLogin();
    if (!user) return;
    loadProfileData();
    updateCartBadge();
    try {
        myOrders = await getMyOrders();
    } catch (error) {
        $('#orderHistoryContainer').html(`<div class="empty-state"><h4>Couldn't load your orders</h4><p>${escapeHtml(error.message)}</p></div>`);
        return;
    }
    loadOrderHistory();
    calculateStats();
});

const USER_TYPES = { student: 'Student', faculty: 'Faculty', staff: 'Staff' };

// Load profile data
function loadProfileData() {
    const user = getCurrentUser();

    // Avatar is generated from the name
    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=2B1D16&color=F5F5DC&size=150`;
    $('#profileAvatar').attr('src', avatarUrl);
    $('#navAvatar').attr('src', avatarUrl);

    $('#profileName').text(user.name);
    $('#navUserName').text(user.name.split(' ')[0]);
    $('#profileStudentId').text(user.studentId);
    $('#profileEmail').text(user.email);
    $('#profilePhone').text(user.phone || '—');
    $('#profileUserType').text(USER_TYPES[user.userType] || user.userType);

    $('#editName').val(user.name);
    $('#editStudentId').val(user.studentId);
    $('#editEmail').val(user.email);
    $('#editPhone').val(user.phone || '');
}

// Statistics from this customer's orders
function calculateStats() {
    const completed = myOrders.filter(o => o.status === 'Completed');

    $('#totalOrders').text(myOrders.length);
    $('#totalSpent').text(formatPrice(completed.reduce((sum, o) => sum + o.total, 0)));
    $('#collectedOrders').text(completed.length);

    // Favourite item (most ordered across all their orders), from "2 x Burger, 1 x Coffee"
    const itemCount = {};
    myOrders.forEach(order => {
        order.itemsText.split(', ').forEach(part => {
            const match = part.match(/^(\d+) x (.+)$/);
            if (match) itemCount[match[2]] = (itemCount[match[2]] || 0) + Number(match[1]);
        });
    });
    const favourite = Object.keys(itemCount).sort((a, b) => itemCount[b] - itemCount[a])[0];
    $('#favoriteItem').text(favourite || '—');
}

const STATUS_CLASS = {
    Received: 'status-pending',
    Accepted: 'status-pending',
    Preparing: 'status-preparing',
    Ready: 'status-ready',
    Completed: 'status-completed',
    Cancelled: 'status-cancelled',
    Rejected: 'status-cancelled',
    'No Show': 'status-cancelled'
};
const OPEN_STATUSES = ['Received', 'Accepted', 'Preparing', 'Ready'];

// Load order history (newest first, as sent by the server)
function loadOrderHistory() {
    const container = $('#orderHistoryContainer');

    if (myOrders.length === 0) {
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

    container.html(myOrders.map(order => `
        <div class="order-card">
            <div class="order-header">
                <span class="order-id">${order.number}</span>
                <span class="order-status ${STATUS_CLASS[order.status] || 'status-pending'}">${order.status}</span>
            </div>
            <div class="order-items">
                ${order.itemsText.split(', ').map(part => `<div class="order-item"><span>${escapeHtml(part.replace(' x ', 'x '))}</span></div>`).join('')}
                ${order.closeReason ? `<div class="order-item text-muted"><span>${escapeHtml(order.closeReason)}</span></div>` : ''}
            </div>
            <div class="order-footer">
                <div>
                    <div class="order-total">${formatPrice(order.total)}</div>
                    <div class="order-date">Ordered ${formatWhen(order.timestamp)} · pickup ${order.pickupTime}</div>
                </div>
                <div>
                    ${OPEN_STATUSES.includes(order.status)
                        ? `<button class="btn-reorder" onclick="trackOrder(${order.orderId})"><i class="fas fa-clock"></i> Track</button>`
                        : `<button class="btn-reorder" onclick="viewReceipt(${order.orderId})"><i class="fas fa-receipt"></i> Receipt</button>`}
                    <button class="btn-reorder" onclick="reorder(${order.orderId})"><i class="fas fa-redo"></i> Reorder</button>
                </div>
            </div>
        </div>
    `).join(''));
}

function trackOrder(orderId) {
    window.location.href = 'order-status.html?order=' + orderId;
}

function viewReceipt(orderId) {
    window.location.href = 'receipt.html?order=' + orderId;
}

// Put the items of an old order back into the cart (only ones still in stock)
async function reorder(orderId) {
    let order, menu;
    try {
        [order, menu] = await Promise.all([getOrder(orderId), getMenuItems()]);
    } catch (error) {
        alert(error.message);
        return;
    }
    const cart = loadCart();
    let added = 0;

    order.items.forEach(orderItem => {
        const menuItem = menu.find(m => m.id === orderItem.id);
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
    storeCart(cart);
    window.location.href = 'cart.html';
}

// Cart badge in the navbar
function updateCartBadge() {
    $('#cartCount').text(loadCart().reduce((sum, item) => sum + item.quantity, 0));
}

// Switch between Order History / Edit Profile / Settings
function switchTab(tab) {
    $('.tab-btn').removeClass('active');
    $(`.tab-btn[onclick="switchTab('${tab}')"]`).addClass('active');
    $('.tab-content').removeClass('active');
    $(`#${tab}Tab`).addClass('active');
}

// Save the edit profile form
async function updateProfile(event) {
    event.preventDefault();
    const phone = normalizePakistaniMobile($('#editPhone').val());
    if (!phone) {
        $('#profileError').text('Enter a Pakistani mobile number, e.g. 0300 1234567');
        return;
    }
    try {
        const { user } = await api('/auth/me', {
            method: 'PATCH',
            body: { full_name: $('#editName').val().trim(), email: $('#editEmail').val().trim(), phone }
        });
        currentUser = toUser(user);
    } catch (error) {
        $('#profileError').text(error.message);
        return;
    }
    $('#profileError').text('');
    loadProfileData();
    switchTab('orders');
    alert('Profile updated successfully!');
}

function cancelEdit() {
    $('#profileError').text('');
    loadProfileData();
    switchTab('orders');
}

async function changePassword() {
    const currentPassword = $('#currentPassword').val();
    const newPassword = $('#newPassword').val();
    const confirmPassword = $('#confirmNewPassword').val();

    if (newPassword.length < 6) {
        alert('New password must be at least 6 characters');
        return;
    }
    if (newPassword !== confirmPassword) {
        alert('New passwords do not match');
        return;
    }
    try {
        await api('/auth/password', {
            method: 'POST',
            body: { current_password: currentPassword, new_password: newPassword }
        });
    } catch (error) {
        alert(error.message);
        return;
    }
    $('#currentPassword, #newPassword, #confirmNewPassword').val('');
    alert('Password updated successfully!');
}

// Avatar is generated from the name
function changeAvatar() {
    alert('Your avatar is created from your name. Change your name in Edit Profile to update it.');
}

function confirmLogout() {
    if (confirm('Are you sure you want to logout?')) {
        logout();
    }
}
