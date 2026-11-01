// Menu items from the API (loaded once the login is confirmed)
let menuItems = [];

// Cart, kept in this browser until checkout
let cart = loadCart();

// Current filter
let currentCategory = 'all';
let currentSearch = '';

// Initialize page: students must be logged in to order
document.addEventListener('DOMContentLoaded', async function() {
    const user = await requireStudentLogin();
    if (!user) return;
    showUserName();
    updateCartCount();
    await loadMenu();
});

async function loadMenu() {
    const container = document.getElementById('menuContainer');
    container.innerHTML = `
        <div class="col-12">
            <div class="empty-state">
                <i class="fas fa-spinner fa-spin"></i>
                <h3>Loading the menu...</h3>
            </div>
        </div>
    `;
    try {
        menuItems = await getMenuItems();
        filterAndDisplay();
    } catch (error) {
        container.innerHTML = `
            <div class="col-12">
                <div class="empty-state">
                    <i class="fas fa-plug"></i>
                    <h3>Couldn't load the menu</h3>
                    <p>${escapeHtml(error.message)}</p>
                    <button class="add-to-cart-btn" onclick="loadMenu()"><i class="fas fa-redo"></i> Try again</button>
                </div>
            </div>
        `;
    }
}

// Greet the logged-in user by first name
function showUserName() {
    const user = getCurrentUser();
    if (!user) return;
    const firstName = user.name.trim().split(' ')[0];
    document.getElementById('welcomeName').textContent = firstName;
    document.getElementById('navUserName').textContent = firstName;
}

// Display menu items
function displayMenuItems(items) {
    const container = document.getElementById('menuContainer');
    
    if (items.length === 0) {
        container.innerHTML = `
            <div class="col-12">
                <div class="empty-state">
                    <i class="fas fa-search"></i>
                    <h3>No items found</h3>
                    <p>Try adjusting your search or filter</p>
                </div>
            </div>
        `;
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="col-lg-3 col-md-4 col-sm-6">
            <div class="food-card">
                <div style="position: relative;">
                    <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" class="food-image">
                    <span class="food-badge ${isInStock(item) ? 'badge-available' : 'badge-unavailable'}">
                        ${isInStock(item) ? '<i class="fas fa-check"></i> Available' : 'Out of stock'}
                    </span>
                </div>
                <div class="food-content">
                    <div class="food-category">${escapeHtml(item.categoryName)}</div>
                    <div class="food-name">${escapeHtml(item.name)}</div>
                    <div class="food-description">${escapeHtml(item.description)}</div>
                    <div class="food-footer">
                        <div class="food-price">${formatPrice(item.price)}</div>
                        <button 
                            class="add-to-cart-btn" 
                            onclick="addToCart(${item.id})"
                            ${!isInStock(item) ? 'disabled' : ''}>
                            <i class="fas fa-plus"></i> Add
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

// Filter by category
function filterByCategory(category) {
    currentCategory = category;
    
    // Update active pill
    document.querySelectorAll('.category-pill').forEach(pill => {
        pill.classList.remove('active');
    });
    event.target.closest('.category-pill').classList.add('active');
    
    // Filter and display
    filterAndDisplay();
}

// Search food
function searchFood() {
    currentSearch = document.getElementById('searchInput').value.toLowerCase();
    filterAndDisplay();
}

// Combined filter and display
function filterAndDisplay() {
    let filtered = menuItems;
    
    // Filter by category
    if (currentCategory !== 'all') {
        filtered = filtered.filter(item => item.category === currentCategory);
    }
    
    // Filter by search
    if (currentSearch) {
        filtered = filtered.filter(item => 
            item.name.toLowerCase().includes(currentSearch) ||
            item.description.toLowerCase().includes(currentSearch)
        );
    }
    
    displayMenuItems(filtered);
}

// Add to cart
function addToCart(itemId) {
    const item = menuItems.find(i => i.id === itemId);
    
    if (!item || !isInStock(item)) return;
    
    // Check if item already in cart
    const existingItem = cart.find(i => i.id === itemId);
    
    if (existingItem) {
        if (existingItem.quantity >= item.stock) {
            showToast(`Only ${item.stock} ${item.name} left in stock`);
            return;
        }
        existingItem.quantity++;
    } else {
        cart.push({
            id: item.id,
            name: item.name,
            price: item.price,
            image: item.image,
            quantity: 1
        });
    }
    
    storeCart(cart);
    
    // Update cart count
    updateCartCount();
    
    // Show feedback
    showToast(`${item.name} added to cart!`);
}

// Update cart count
function updateCartCount() {
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    document.getElementById('cartCount').textContent = totalItems;
}

// Show toast notification
function showToast(message) {
    // Create toast element
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        background: var(--success-color);
        color: var(--on-dark);
        padding: 15px 25px;
        border-radius: 0;
        box-shadow: var(--shadow-sm);
        z-index: 9999;
        animation: slideIn 0.3s ease;
    `;
    toast.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
    
    document.body.appendChild(toast);
    
    // Remove after 3 seconds
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
