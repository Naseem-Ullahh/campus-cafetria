let myOrders = [];

$(document).ready(async function() {
    const user = await requireStudentLogin();
    if (!user) return;
    loadProfileData();
    updateCartBadge();
    if (location.hash === '#bill') switchTab('bill');
    loadBill();
    try {
        myOrders = await getMyOrders();
    } catch (error) {
        $('#orderHistoryContainer').html(`<div class="empty-state"><h4>Couldn't load your orders</h4><p>${escapeHtml(error.message)}</p></div>`);
        return;
    }
    loadOrderHistory();
    calculateStats();
});

const USER_TYPES = { student: 'Student', gc: 'Gentleman Cadet (GC)', army: 'Army personnel', faculty: 'Faculty', staff: 'Staff' };

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

// ---------- Amount Payable (monthly bill) ----------
let bill = null;

async function loadBill() {
    try {
        bill = await getMyAccount();
    } catch (error) {
        $('#billSummary').html(`<p class="form-error">Couldn't load your bill: ${escapeHtml(error.message)}</p>`);
        return;
    }
    renderBill();
}

function renderBill() {
    const a = bill.account;
    const toPay = Math.max(a.balance - a.pending_payments, 0);
    const inProgress = a.spent_this_month - a.charged_this_month;

    // What needs doing, most urgent first
    let status, statusClass = '';
    if (a.overdue > 0) {
        status = `${formatPrice(a.overdue)} is overdue - you can't place new orders until it's paid.`;
        statusClass = 'is-overdue';
    } else if (a.previous_unpaid > 0) {
        status = `${formatPrice(a.previous_unpaid)} from last month is due by ${formatDate(a.previous_due_date)}.`;
        statusClass = 'is-due';
    } else if (a.balance > 0) {
        status = `This month's bill is due by ${formatDate(a.current_due_date)}.`;
    } else {
        status = 'You are all paid up.';
    }

    $('#billSummary').html(`
        <div class="bill-total"><strong>${formatPrice(a.balance)}</strong><span>owed in total</span></div>
        <p class="bill-status ${statusClass}">${status}</p>
        <div class="bill-tiles">
            <div class="bill-tile ${a.overdue > 0 ? 'is-overdue' : ''}">
                <span class="label">Earlier months</span>
                <span class="value">${formatPrice(a.previous_unpaid)}</span>
                <span class="sub">${a.overdue > 0 ? 'Overdue' : a.previous_unpaid > 0 ? 'Due by ' + formatDate(a.previous_due_date) : 'Nothing due'}</span>
            </div>
            <div class="bill-tile">
                <span class="label">This month so far</span>
                <span class="value">${formatPrice(a.charged_this_month)}</span>
                <span class="sub">${inProgress > 0 ? `+ ${formatPrice(inProgress)} in orders not collected yet · ` : ''}Due by ${formatDate(a.current_due_date)}</span>
            </div>
            <div class="bill-tile">
                <span class="label">Monthly limit</span>
                <span class="value">${formatPrice(a.monthly_limit)}</span>
                <span class="sub">${!bill.settings.accounts_open ? 'Monthly bill switched off for now'
                    : !a.account_enabled ? 'Monthly bill not available on your account'
                    : formatPrice(Math.max(a.monthly_limit - a.spent_this_month, 0)) + ' left this month'}</span>
            </div>
            ${a.pending_payments > 0 ? `
            <div class="bill-tile">
                <span class="label">Being checked</span>
                <span class="value">${formatPrice(a.pending_payments)}</span>
                <span class="sub">Online payment${a.pending_payment_count > 1 ? 's' : ''} waiting for the cashier</span>
            </div>` : ''}
        </div>`);

    $('#payBillCard').prop('hidden', toPay <= 0);
    $('#billAmount').attr('max', Math.ceil(toPay)).val(Math.ceil(toPay) || '');
    renderStatement();
    renderBillBanner(toPay);
}

// Reminder above the stats, so it's seen without opening the tab
function renderBillBanner(toPay) {
    const a = bill.account;
    const banner = $('#billBanner');
    if (a.overdue > 0) {
        banner.addClass('is-overdue').html(`<i class="fas fa-exclamation-circle"></i>
            <span><strong>${formatPrice(a.overdue)} of your monthly bill is overdue.</strong> Pay it to order again.</span>
            ${toPay > 0 ? `<button type="button" onclick="switchTab('bill')">Pay now</button>` : ''}`);
    } else if (a.previous_unpaid > 0) {
        banner.removeClass('is-overdue').html(`<i class="fas fa-file-invoice"></i>
            <span>Last month's bill of <strong>${formatPrice(a.previous_unpaid)}</strong> is due by ${formatDate(a.previous_due_date)}.</span>
            ${toPay > 0 ? `<button type="button" onclick="switchTab('bill')">Pay now</button>` : ''}`);
    } else {
        banner.prop('hidden', true);
        return;
    }
    banner.prop('hidden', false);
}

const MONTH_NAME = { month: 'long', year: 'numeric' };

function statementRow(entry) {
    const when = new Date(entry.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    if (entry.kind === 'charge') {
        const tag = entry.status === 'Pending' ? '<span class="statement-tag">Not collected yet</span>'
                  : entry.order_status === 'No Show' ? '<span class="statement-tag warn">Not collected</span>' : '';
        return `<div class="statement-row">
            <span class="when">${when}</span>
            <span class="what"><a href="receipt.html?order=${entry.order_id}">Order ${formatOrderNumber(entry.order_id)}</a>${tag}
                <small>${escapeHtml(entry.items || '')}</small></span>
            <span class="amount">${formatPrice(entry.amount)}</span>
        </div>`;
    }
    const how = entry.method === 'Waiver' ? 'Waived by the manager' : entry.method === 'Cash' ? 'Paid cash at the counter' : `Paid by ${entry.method}`;
    const tag = entry.status === 'Pending' ? '<span class="statement-tag warn">Being checked</span>'
              : entry.status === 'Rejected' ? '<span class="statement-tag bad">Not accepted</span>' : '';
    const detail = [entry.transaction_reference ? `ID ${escapeHtml(entry.transaction_reference)}` : '', escapeHtml(entry.note || '')].filter(Boolean).join(' · ');
    return `<div class="statement-row ${entry.status === 'Rejected' ? 'is-muted' : ''}">
        <span class="when">${when}</span>
        <span class="what">${how}${tag}${detail ? `<small>${detail}</small>` : ''}</span>
        <span class="amount credit">&minus; ${formatPrice(entry.amount)}</span>
    </div>`;
}

function renderStatement() {
    const entries = bill.entries;
    if (entries.length === 0) {
        $('#billStatement').html(`<p class="text-muted">Nothing yet. Choose <strong>Add to my monthly bill</strong> at checkout to buy now and pay at the end of the month.</p>`);
        return;
    }
    const months = [];
    entries.forEach(entry => {
        const key = new Date(entry.at).toLocaleDateString('en-GB', MONTH_NAME);
        let month = months.find(m => m.key === key);
        if (!month) months.push(month = { key, rows: [], charged: 0 });
        month.rows.push(entry);
        if (entry.kind === 'charge' && entry.status === 'Billed') month.charged += entry.amount;
    });
    $('#billStatement').html(months.map(month => `
        <section class="statement-month">
            <h4>${month.key}<span>Charged ${formatPrice(month.charged)}</span></h4>
            ${month.rows.map(statementRow).join('')}
        </section>`).join(''));
}

async function payBill(event) {
    event.preventDefault();
    const button = $('#payBillBtn').prop('disabled', true);
    try {
        bill = await api('/account/payments', {
            method: 'POST',
            body: { amount: Number($('#billAmount').val()), method: $('#billMethod').val(), transaction_reference: $('#billReference').val().trim() }
        });
    } catch (error) {
        $('#billError').text(error.message);
        button.prop('disabled', false);
        return;
    }
    $('#billError').text('');
    $('#billReference').val('');
    button.prop('disabled', false);
    renderBill();
    alert('Payment sent. The cashier will check it, and it comes off your bill once confirmed.');
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
