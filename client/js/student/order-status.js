// Order saved at checkout, with its latest status from the shared orders list
const savedOrder = JSON.parse(localStorage.getItem('currentOrder'));
let currentOrder = savedOrder ? (findOrder(savedOrder.orderId) || savedOrder) : null;

// Initialize page
document.addEventListener('DOMContentLoaded', function() {
    if (!currentOrder) {
        // No order found, redirect to home
        showToast('No active order found', 'error');
        setTimeout(() => {
            window.location.href = 'home.html';
        }, 2000);
        return;
    }

    loadOrderDetails();
    
    // Show the current status, then check for updates from the cafeteria every 5 seconds
    showStatus(currentOrder.status, false);
    setInterval(checkForStatusUpdate, 5000);
});

// Load order details
function loadOrderDetails() {
    // Order ID and Status
    document.getElementById('orderIdDisplay').textContent = `Order #${currentOrder.orderId}`;
    document.getElementById('orderStatus').textContent = currentOrder.status;

    // Pickup Time
    document.getElementById('pickupTimeDisplay').textContent = currentOrder.pickupTime;

    // Customer Details
    document.getElementById('customerName').textContent = currentOrder.fullName;
    document.getElementById('studentId').textContent = currentOrder.studentId;
    document.getElementById('phoneNumber').textContent = currentOrder.phoneNumber;

    // Payment Details
    const paymentMethods = {
        'Cash': 'Cash at the counter',
        'Easypaisa': 'Easypaisa',
        'JazzCash': 'JazzCash'
    };
    document.getElementById('paymentMethod').textContent = paymentMethods[currentOrder.paymentMethod] || currentOrder.paymentMethod;
    document.getElementById('totalAmount').textContent = `Rs. ${currentOrder.total}`;
    document.getElementById('grandTotal').textContent = `Rs. ${currentOrder.total}`;

    // Order Items
    const itemsList = document.getElementById('orderItemsList');
    itemsList.innerHTML = currentOrder.items.map(item => `
        <div class="item-row">
            <div class="item-details">
                <span class="item-qty">${item.quantity}x</span>
                <span class="item-name">${item.name}</span>
            </div>
            <span class="item-price">Rs. ${item.price * item.quantity}</span>
        </div>
    `).join('');

    // Received Time
    const orderTime = new Date(currentOrder.timestamp);
    document.getElementById('receivedTime').textContent = orderTime.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
}

// Check whether the cafeteria admin has changed the order status
function checkForStatusUpdate() {
    const latest = findOrder(currentOrder.orderId);
    if (latest && latest.status !== currentOrder.status) {
        currentOrder = latest;
        localStorage.setItem('currentOrder', JSON.stringify(currentOrder));
        showStatus(latest.status, true);
    }
}

// Show a status on the badge and timeline
function showStatus(newStatus, notify) {
    const statusMap = {
        'Received': { step: 0, badge: 'Received' },
        'Preparing': { step: 1, badge: 'Preparing' },
        'Ready': { step: 2, badge: 'Ready for Pickup' },
        'Completed': { step: 3, badge: 'Completed' },
        'Cancelled': { step: -1, badge: 'Cancelled' }
    };

    const status = statusMap[newStatus];
    if (!status) return;

    // Update badge
    document.getElementById('orderStatus').textContent = status.badge;

    // Update timeline
    const items = document.querySelectorAll('.timeline-item');
    items.forEach((item, index) => {
        item.classList.remove('completed', 'active', 'pending');
        
        if (index < status.step) {
            item.classList.add('completed');
        } else if (index === status.step) {
            item.classList.add('active');
        } else {
            item.classList.add('pending');
        }
    });

    // Show notification
    if (!notify) return;
    if (newStatus === 'Preparing') {
        showToast('Your order is being prepared', 'success');
    } else if (newStatus === 'Ready') {
        showToast('Your order is ready for pickup!', 'success');
    } else if (newStatus === 'Completed') {
        showToast('Order completed. Thank you!', 'success');
    } else if (newStatus === 'Cancelled') {
        showToast('Your order was cancelled by the cafeteria', 'error');
    }
}

// Refresh status
function refreshStatus() {
    const btn = event.target.closest('.refresh-btn');
    const icon = btn.querySelector('i');
    
    // Add spinning animation
    icon.classList.add('spinning');
    btn.disabled = true;

    setTimeout(() => {
        icon.classList.remove('spinning');
        btn.disabled = false;
        checkForStatusUpdate();
        showToast('Status refreshed', 'success');
    }, 1500);
}

// Download receipt
function downloadReceipt() {
    window.location.href = 'receipt.html';
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
    toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i> ${message}`;
    
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
