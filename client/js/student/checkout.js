requireStudentLogin();

// Load cart from localStorage
let cart = JSON.parse(localStorage.getItem('cart')) || [];
let selectedPayment = 'Cash';

// Initialize page
document.addEventListener('DOMContentLoaded', function() {
    if (cart.length === 0) {
        document.getElementById('emptyCartAlert').classList.add('show');
        setTimeout(() => {
            window.location.href = 'home.html';
        }, 3000);
    } else {
        document.getElementById('checkoutContent').style.display = 'grid';
        fillStudentDetails();
        fillPickupSlots();
        loadOrderSummary();
    }
});

// Pre-fill the form with the logged-in student's details
function fillStudentDetails() {
    const user = getCurrentUser();
    if (!user) return;
    document.getElementById('fullName').value = user.name;
    document.getElementById('phoneNumber').value = user.phone || '';
    document.getElementById('studentId').value = user.studentId;
}

// Pickup slots every 15 minutes: from 15 min to 24 h ahead, only while open (8 AM - 10 PM)
const OPENING_HOUR = 8;
const CLOSING_HOUR = 22;

function fillPickupSlots() {
    const select = document.getElementById('pickupTime');
    const now = new Date();
    const slot = new Date(now.getTime() + 15 * 60000);
    slot.setSeconds(0, 0);
    slot.setMinutes(Math.ceil(slot.getMinutes() / 15) * 15);
    const latest = new Date(now.getTime() + 24 * 60 * 60000);

    for (; slot <= latest; slot.setMinutes(slot.getMinutes() + 15)) {
        const hour = slot.getHours();
        if (hour < OPENING_HOUR || hour >= CLOSING_HOUR) continue;

        const option = document.createElement('option');
        option.value = slot.toISOString();
        option.textContent = formatPickupLabel(slot);
        select.appendChild(option);
    }
    if (select.options.length > 1) {
        select.selectedIndex = 1;
    }
}

// "Today 1:30 PM" / "Tomorrow 9:00 AM"
function formatPickupLabel(date) {
    const day = date.toDateString() === new Date().toDateString() ? 'Today' : 'Tomorrow';
    return `${day} ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

// Load order summary
function loadOrderSummary() {
    const itemsContainer = document.getElementById('orderItems');
    
    // Calculate total (no tax - matches the database)
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // Display items
    itemsContainer.innerHTML = cart.map(item => `
        <div class="order-item">
            <div class="item-info">
                <span class="item-qty">${item.quantity}x</span>
                <span class="item-name">${item.name}</span>
            </div>
            <span class="item-price">Rs. ${item.price * item.quantity}</span>
        </div>
    `).join('');

    // Update totals
    document.getElementById('totalAmount').textContent = formatPrice(total);
}

// Select payment method
function selectPayment(method) {
    selectedPayment = method;
    
    // Update UI
    document.querySelectorAll('.payment-option').forEach(option => {
        option.classList.remove('selected');
    });
    event.target.closest('.payment-option').classList.add('selected');
    
    // Update radio
    document.querySelector(`input[value="${method}"]`).checked = true;

    // Wallet payments need the transaction ID
    const isWallet = method !== 'Cash';
    document.getElementById('transactionGroup').hidden = !isWallet;
    document.getElementById('transactionRef').required = isWallet;
    if (isWallet) {
        document.getElementById('transactionRef').focus();
    }
}

// Place order
function placeOrder() {
    // Validate form
    const form = document.getElementById('checkoutForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    const phone = normalizePakistaniMobile(document.getElementById('phoneNumber').value);
    if (!phone) {
        showToast('Enter a Pakistani mobile number, e.g. 0300 1234567', 'error');
        document.getElementById('phoneNumber').focus();
        return;
    }

    let transactionReference = null;
    if (selectedPayment !== 'Cash') {
        transactionReference = document.getElementById('transactionRef').value.trim();
        if (transactionReference.length < 6) {
            showToast(`Enter the transaction ID from your ${selectedPayment} payment`, 'error');
            document.getElementById('transactionRef').focus();
            return;
        }
        if (getOrders().some(o => o.transactionReference === transactionReference)) {
            showToast('This transaction ID has already been used for another order', 'error');
            document.getElementById('transactionRef').focus();
            return;
        }
    }

    const pickupSelect = document.getElementById('pickupTime');
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // Get form data
    const orderData = {
        orderId: 'ORD' + Date.now(),
        studentId: document.getElementById('studentId').value,
        fullName: document.getElementById('fullName').value,
        phoneNumber: phone,
        pickupAt: pickupSelect.value,
        pickupTime: pickupSelect.options[pickupSelect.selectedIndex].text,
        specialInstructions: document.getElementById('specialInstructions').value,
        paymentMethod: selectedPayment,
        transactionReference,
        paymentStatus: 'Pending',
        items: cart,
        total,
        status: 'Received',
        timestamp: new Date().toISOString()
    };

    // Save order to the shared store (also takes the items out of stock)
    placeNewOrder(orderData);

    // Save current order for status page
    localStorage.setItem('currentOrder', JSON.stringify(orderData));

    // Clear cart
    localStorage.removeItem('cart');

    // Show success message
    showToast('Order placed successfully!', 'success');

    // Redirect to order status page
    setTimeout(() => {
        window.location.href = 'receipt.html';
    }, 1500);
}

// Show toast notification
function showToast(message, type = 'success') {
    const bgColor = type === 'success' ? 'var(--success-color)' : 'var(--error)';
    
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        background: ${bgColor};
        color: var(--on-dark);
        padding: 15px 25px;
        border-radius: 0;
        box-shadow: var(--shadow-sm);
        z-index: 9999;
        animation: slideIn 0.3s ease;
    `;
    toast.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Add animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(400px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(400px); opacity: 0; }
    }
`;
document.head.appendChild(style);
