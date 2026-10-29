// Load cart from localStorage
let cart = JSON.parse(localStorage.getItem('cart')) || [];

// Initialize page
document.addEventListener('DOMContentLoaded', function() {
    renderCart();
});

// Render cart
function renderCart() {
    const container = document.getElementById('cartContent');
    const itemCount = document.getElementById('itemCount');

    if (cart.length === 0) {
        // Empty cart state
        container.innerHTML = `
            <div class="empty-cart">
                <i class="fas fa-shopping-cart"></i>
                <h2>Your cart is empty</h2>
                <p>Looks like you haven't added anything to your cart yet</p>
                <a href="home.html" class="shop-now-btn">
                    <i class="fas fa-utensils"></i> Browse Menu
                </a>
            </div>
        `;
        itemCount.textContent = '0 items in cart';
        return;
    }

    // Update item count
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    itemCount.textContent = `${totalItems} ${totalItems === 1 ? 'item' : 'items'} in cart`;

    // Calculate totals
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // Render cart with items
    container.innerHTML = `
        <div class="cart-container">
            <!-- Cart Items -->
            <div class="cart-items">
                ${cart.map((item, index) => `
                    <div class="cart-item">
                        <img src="${item.image}" alt="${item.name}" class="item-image">
                        <div class="item-details">
                            <h3 class="item-name">${item.name}</h3>
                            <div class="item-price">Rs. ${item.price} each</div>
                            <div class="item-actions">
                                <div class="quantity-control">
                                    <button class="qty-btn" onclick="updateQuantity(${index}, -1)" ${item.quantity <= 1 ? 'disabled' : ''}>
                                        <i class="fas fa-minus"></i>
                                    </button>
                                    <span class="qty-display">${item.quantity}</span>
                                    <button class="qty-btn" onclick="updateQuantity(${index}, 1)">
                                        <i class="fas fa-plus"></i>
                                    </button>
                                </div>
                                <div class="item-total">Rs. ${item.price * item.quantity}</div>
                                <button class="remove-btn" onclick="removeItem(${index})" title="Remove item">
                                    <i class="fas fa-trash-alt"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>

            <!-- Order Summary -->
            <div class="order-summary">
                <h3 class="summary-title">Order Summary</h3>
                
                <div class="summary-row">
                    <span class="summary-label">${totalItems} ${totalItems === 1 ? 'item' : 'items'}</span>
                    <span class="summary-value">${formatPrice(total)}</span>
                </div>
                
                <div class="summary-divider"></div>
                
                <div class="summary-total">
                    <span>Total</span>
                    <span>${formatPrice(total)}</span>
                </div>

                <button class="checkout-btn" onclick="proceedToCheckout()">
                    <i class="fas fa-lock"></i> Proceed to Checkout
                </button>

                <div class="continue-shopping">
                    <a href="home.html">
                        <i class="fas fa-arrow-left"></i> Continue Shopping
                    </a>
                </div>

                <!-- Promo Code Section -->
                <div class="promo-section">
                    <p style="margin-bottom: 10px; font-size: 14px; color: var(--text-muted); font-weight: 600;">
                        Have a promo code?
                    </p>
                    <div class="promo-input-group">
                        <input 
                            type="text" 
                            class="promo-input" 
                            id="promoCode" 
                            placeholder="Enter code"
                        >
                        <button class="apply-btn" onclick="applyPromoCode()">
                            Apply
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Update quantity
function updateQuantity(index, change) {
    cart[index].quantity += change;
    
    // Remove if quantity becomes 0
    if (cart[index].quantity <= 0) {
        removeItem(index);
        return;
    }
    
    // Save and re-render
    saveCart();
    renderCart();
    showToast('Quantity updated');
}

// Remove item
function removeItem(index) {
    const itemName = cart[index].name;
    cart.splice(index, 1);
    saveCart();
    renderCart();
    showToast(`${itemName} removed from cart`);
}

// Save cart to localStorage
function saveCart() {
    localStorage.setItem('cart', JSON.stringify(cart));
}

// Proceed to checkout
function proceedToCheckout() {
    if (cart.length === 0) {
        showToast('Your cart is empty', 'error');
        return;
    }
    
    // Redirect to checkout page
    window.location.href = 'checkout.html';
}

// Apply promo code
function applyPromoCode() {
    const code = document.getElementById('promoCode').value.trim().toUpperCase();
    
    if (!code) {
        showToast('Please enter a promo code', 'error');
        return;
    }

    // Dummy promo codes (replace with actual logic later)
    const validCodes = {
        'FIRST10': 10,
        'STUDENT20': 20,
        'WELCOME15': 15
    };

    if (validCodes[code]) {
        showToast(`Promo code applied! ${validCodes[code]}% discount`, 'success');
        document.getElementById('promoCode').value = '';
    } else {
        showToast('Invalid promo code', 'error');
    }
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
