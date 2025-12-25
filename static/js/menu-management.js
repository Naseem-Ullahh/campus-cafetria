// Menu Management JavaScript
$(document).ready(function() {
    // Initialize
    loadMenuItems();
    updateStatistics();
    
    // Mobile menu toggle
    $('#mobileMenuToggle').click(function() {
        $('.admin-sidebar').toggleClass('show');
    });

    // Search functionality
    $('#searchInput').on('keyup', function() {
        const searchTerm = $(this).val().toLowerCase();
        filterMenuItems(searchTerm);
    });

    // Category filter buttons
    $('.filter-btn').click(function() {
        $('.filter-btn').removeClass('active');
        $(this).addClass('active');
        const category = $(this).data('category');
        filterByCategory(category);
    });

    // Save item button
    $('#saveItemBtn').click(function() {
        saveMenuItem();
    });

    // Confirm delete button
    $('#confirmDeleteBtn').click(function() {
        deleteMenuItem();
    });

    // Image file upload preview
    $('#itemImageFile').change(function(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(e) {
                $('#itemImage').val(e.target.result);
            };
            reader.readAsDataURL(file);
        }
    });
});

// Load menu items from localStorage
function loadMenuItems() {
    let menuItems = getMenuItems();
    renderMenuItems(menuItems);
}

// Get menu items from localStorage
function getMenuItems() {
    const items = localStorage.getItem('menuItems');
    if (items) {
        return JSON.parse(items);
    } else {
        // Default sample data
        const sampleItems = [
            {
                id: 1,
                name: 'Chicken Burger',
                category: 'Lunch',
                price: 250,
                stock: 50,
                description: 'Juicy chicken patty with fresh vegetables',
                image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400',
                available: true,
                popular: true
            },
            {
                id: 2,
                name: 'Cheese Pizza',
                category: 'Lunch',
                price: 450,
                stock: 30,
                description: 'Classic cheese pizza with mozzarella',
                image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400',
                available: true,
                popular: true
            },
            {
                id: 3,
                name: 'Coffee',
                category: 'Beverages',
                price: 120,
                stock: 100,
                description: 'Fresh brewed coffee',
                image: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=400',
                available: true,
                popular: false
            },
            {
                id: 4,
                name: 'Pancakes',
                category: 'Breakfast',
                price: 180,
                stock: 0,
                description: 'Fluffy pancakes with maple syrup',
                image: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400',
                available: false,
                popular: false
            },
            {
                id: 5,
                name: 'French Fries',
                category: 'Snacks',
                price: 150,
                stock: 80,
                description: 'Crispy golden french fries',
                image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400',
                available: true,
                popular: true
            }
        ];
        localStorage.setItem('menuItems', JSON.stringify(sampleItems));
        return sampleItems;
    }
}

// Render menu items in table
function renderMenuItems(items) {
    const tbody = $('#menuTableBody');
    tbody.empty();

    if (items.length === 0) {
        tbody.append(`
            <tr>
                <td colspan="8" class="text-center py-5">
                    <i class="fas fa-inbox fa-3x text-muted mb-3"></i>
                    <p class="text-muted">No menu items found</p>
                </td>
            </tr>
        `);
        return;
    }

    items.forEach(item => {
        const statusBadge = item.available 
            ? '<span class="badge bg-success">Available</span>' 
            : '<span class="badge bg-danger">Out of Stock</span>';
        
        const popularBadge = item.popular 
            ? '<i class="fas fa-fire text-danger"></i>' 
            : '-';

        const row = `
            <tr data-item-id="${item.id}">
                <td>
                    <img src="${item.image}" alt="${item.name}" class="menu-item-img" 
                         onerror="this.src='https://via.placeholder.com/80?text=No+Image'">
                </td>
                <td>
                    <strong>${item.name}</strong>
                    <br>
                    <small class="text-muted">${item.description || 'No description'}</small>
                </td>
                <td><span class="category-badge">${item.category}</span></td>
                <td><strong>PKR ${item.price}</strong></td>
                <td>
                    ${item.stock > 0 
                        ? `<span class="text-success">${item.stock} units</span>` 
                        : '<span class="text-danger">Out of Stock</span>'}
                </td>
                <td>${statusBadge}</td>
                <td class="text-center">${popularBadge}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn btn-sm btn-primary edit-btn" onclick="editItem(${item.id})">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-sm btn-danger delete-btn" onclick="confirmDelete(${item.id})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
        tbody.append(row);
    });
}

// Update statistics
function updateStatistics() {
    const items = getMenuItems();
    const totalItems = items.length;
    const availableItems = items.filter(item => item.available && item.stock > 0).length;
    const outOfStock = items.filter(item => item.stock === 0).length;
    const popularItems = items.filter(item => item.popular).length;

    $('#totalItemsCount').text(totalItems);
    $('#availableItemsCount').text(availableItems);
    $('#outOfStockCount').text(outOfStock);
    $('#popularItemsCount').text(popularItems);
}

// Filter menu items by search
function filterMenuItems(searchTerm) {
    const items = getMenuItems();
    const filtered = items.filter(item => 
        item.name.toLowerCase().includes(searchTerm) ||
        item.category.toLowerCase().includes(searchTerm) ||
        item.description.toLowerCase().includes(searchTerm)
    );
    renderMenuItems(filtered);
}

// Filter by category
function filterByCategory(category) {
    const items = getMenuItems();
    if (category === 'all') {
        renderMenuItems(items);
    } else {
        const filtered = items.filter(item => item.category === category);
        renderMenuItems(filtered);
    }
}

// Edit item
function editItem(itemId) {
    const items = getMenuItems();
    const item = items.find(i => i.id === itemId);
    
    if (item) {
        $('#modalTitle').text('Edit Menu Item');
        $('#itemId').val(item.id);
        $('#itemName').val(item.name);
        $('#itemCategory').val(item.category);
        $('#itemPrice').val(item.price);
        $('#itemStock').val(item.stock);
        $('#itemDescription').val(item.description);
        $('#itemImage').val(item.image);
        $('#itemAvailable').prop('checked', item.available);
        $('#itemPopular').prop('checked', item.popular);
        
        $('#addItemModal').modal('show');
    }
}

// Save menu item (Add or Edit)
function saveMenuItem() {
    const itemId = $('#itemId').val();
    const name = $('#itemName').val().trim();
    const category = $('#itemCategory').val();
    const price = parseFloat($('#itemPrice').val());
    const stock = parseInt($('#itemStock').val());
    const description = $('#itemDescription').val().trim();
    const image = $('#itemImage').val().trim();
    const available = $('#itemAvailable').is(':checked');
    const popular = $('#itemPopular').is(':checked');

    // Validation
    if (!name || !category || isNaN(price) || isNaN(stock)) {
        showToast('Please fill all required fields', 'error');
        return;
    }

    let items = getMenuItems();
    
    if (itemId) {
        // Edit existing item
        const index = items.findIndex(i => i.id == itemId);
        if (index !== -1) {
            items[index] = {
                ...items[index],
                name,
                category,
                price,
                stock,
                description,
                image: image || 'https://via.placeholder.com/400?text=No+Image',
                available,
                popular
            };
            showToast('Item updated successfully!', 'success');
        }
    } else {
        // Add new item
        const newItem = {
            id: Date.now(),
            name,
            category,
            price,
            stock,
            description,
            image: image || 'https://via.placeholder.com/400?text=No+Image',
            available,
            popular
        };
        items.push(newItem);
        showToast('Item added successfully!', 'success');
    }

    // Save to localStorage
    localStorage.setItem('menuItems', JSON.stringify(items));
    
    // Reload table and stats
    loadMenuItems();
    updateStatistics();
    
    // Reset form and close modal
    $('#itemForm')[0].reset();
    $('#itemId').val('');
    $('#addItemModal').modal('hide');
}

// Confirm delete
let deleteItemId = null;
function confirmDelete(itemId) {
    deleteItemId = itemId;
    $('#deleteModal').modal('show');
}

// Delete menu item
function deleteMenuItem() {
    if (deleteItemId) {
        let items = getMenuItems();
        items = items.filter(item => item.id !== deleteItemId);
        localStorage.setItem('menuItems', JSON.stringify(items));
        
        loadMenuItems();
        updateStatistics();
        $('#deleteModal').modal('hide');
        showToast('Item deleted successfully!', 'success');
        deleteItemId = null;
    }
}

// Show toast notification
function showToast(message, type = 'info') {
    const bgColor = type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#17a2b8';
    
    const toast = $(`
        <div class="custom-toast" style="background: ${bgColor}">
            <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
            <span>${message}</span>
        </div>
    `);
    
    $('body').append(toast);
    
    setTimeout(() => {
        toast.addClass('show');
    }, 100);
    
    setTimeout(() => {
        toast.removeClass('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
$(document).ready(function() {
    let menuItems = [];
    let currentItemId = null;

    // Load menu items from JSON
    function loadMenuItems() {
        $.getJSON('../data/menu-items.json', function(data) {
            menuItems = data;
            renderTable(menuItems);
        }).fail(function() {
            showToast('Error loading menu items.', 'danger');
        });
    }

    // Render table
    function renderTable(items) {
        const tbody = $('#menuTableBody');
        tbody.empty();
        items.forEach(item => {
            const row = `
                <tr>
                    <td><img src="${item.image || '../assets/images/placeholder.png'}" alt="${item.name}" class="img-thumbnail" style="width: 50px;"></td>
                    <td>${item.name}</td>
                    <td>${item.category}</td>
                    <td>$${item.price.toFixed(2)}</td>
                    <td>${item.stock}</td>
                    <td><span class="badge ${item.available ? 'bg-success' : 'bg-danger'}">${item.available ? 'Yes' : 'No'}</span></td>
                    <td>
                        <button class="btn btn-sm btn-warning edit-btn" data-id="${item.id}"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-danger delete-btn" data-id="${item.id}"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `;
            tbody.append(row);
        });
    }

    // Search functionality
    $('#searchInput').on('input', function() {
        const query = $(this).val().toLowerCase();
        const filtered = menuItems.filter(item => item.name.toLowerCase().includes(query));
        renderTable(filtered);
    });

    // Filter by category
    $('.dropdown-item').on('click', function(e) {
        e.preventDefault();
        const category = $(this).data('category');
        const filtered = category === 'all' ? menuItems : menuItems.filter(item => item.category === category);
        renderTable(filtered);
        $('#filterDropdown').text($(this).text());
    });

    // Open add modal
    $('#addItemModal').on('show.bs.modal', function() {
        $('#itemForm')[0].reset();
        $('#itemId').val('');
        $('#addItemModalLabel').html('<i class="fas fa-plus-circle"></i> Add New Item');
        $('#imagePreview').attr('src', '../assets/images/placeholder.png');
    });

    // Edit item
    $(document).on('click', '.edit-btn', function() {
        const id = $(this).data('id');
        const item = menuItems.find(i => i.id == id);
        if (item) {
            $('#itemId').val(item.id);
            $('#itemName').val(item.name);
            $('#itemCategory').val(item.category);
            $('#itemPrice').val(item.price);
            $('#itemStock').val(item.stock);
            $('#itemImage').val(item.image);
            $('#itemAvailable').prop('checked', item.available);
            $('#imagePreview').attr('src', item.image || '../assets/images/placeholder.png');
            $('#addItemModalLabel').html('<i class="fas fa-edit"></i> Edit Item');
            $('#addItemModal').modal('show');
        }
    });

    // Save item (Add/Edit)
    $('#saveItemBtn').on('click', function() {
        const form = $('#itemForm');
        if (!form[0].checkValidity()) {
            form[0].reportValidity();
            return;
        }

        const item = {
            id: $('#itemId').val() || Date.now(),
            name: $('#itemName').val(),
            category: $('#itemCategory').val(),
            price: parseFloat($('#itemPrice').val()),
            stock: parseInt($('#itemStock').val()),
            image: $('#itemImage').val(),
            available: $('#itemAvailable').is(':checked')
        };

        if (currentItemId) {
            // Edit
            const index = menuItems.findIndex(i => i.id == currentItemId);
            menuItems[index] = item;
        } else {
            // Add
            menuItems.push(item);
        }

        renderTable(menuItems);
        $('#addItemModal').modal('hide');
        showToast('Item saved successfully!', 'success');
    });

    // Delete item
    $(document).on('click', '.delete-btn', function() {
        const id = $(this).data('id');
        if (confirm('Are you sure you want to delete this item?')) {
            menuItems = menuItems.filter(i => i.id != id);
            renderTable(menuItems);
            showToast('Item deleted.', 'warning');
        }
    });

    // Image preview
    $('#itemImage').on('input', function() {
        const url = $(this).val();
        $('#imagePreview').attr('src', url || '../assets/images/placeholder.png');
    });

    // Load navbar and footer
    $('#navbar-placeholder').load('../components/navbar-admin.html');
    $('#footer-placeholder').load('../components/footer.html');

    // Initial load
    loadMenuItems();
});