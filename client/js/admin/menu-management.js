// Menu Management JavaScript
// Uses store.js (getMenuItems / saveMenuItems) so changes show up on the student menu
requireAdminLogin();

const PLACEHOLDER_IMAGE = 'https://placehold.co/150x150?text=Food';
let currentCategory = 'all';

$(document).ready(function() {
    // Load navbar
    $('#navbar-placeholder').load('../../components/admin-navbar.html');

    renderTable();

    // Search functionality
    $('#searchInput').on('input', renderTable);

    // Filter by category
    $('.dropdown-item[data-category]').on('click', function(e) {
        e.preventDefault();
        currentCategory = $(this).data('category');
        $('#filterDropdown').text($(this).text());
        renderTable();
    });

    // Reset the form whenever the modal is opened with the "Add New Item" button
    $('#addItemModal').on('show.bs.modal', function(e) {
        if (!e.relatedTarget) return; // opened by editItem(), form already filled
        $('#itemForm')[0].reset();
        $('#itemId').val('');
        $('#itemAvailable').prop('checked', true);
        $('#addItemModalLabel').html('<i class="fas fa-plus-circle"></i> Add New Item');
        $('#imagePreview').attr('src', PLACEHOLDER_IMAGE);
    });

    // Save item (Add/Edit)
    $('#saveItemBtn').on('click', saveItem);

    // Edit / delete buttons inside the table
    $(document).on('click', '.edit-btn', function() {
        editItem($(this).data('id'));
    });
    $(document).on('click', '.delete-btn', function() {
        deleteItem($(this).data('id'));
    });

    // Image preview
    $('#itemImage').on('input', function() {
        $('#imagePreview').attr('src', $(this).val() || PLACEHOLDER_IMAGE);
    });
});

// Render table using current search text and category filter
function renderTable() {
    const query = ($('#searchInput').val() || '').toLowerCase();
    const items = getMenuItems().filter(item =>
        (currentCategory === 'all' || item.category === currentCategory) &&
        item.name.toLowerCase().includes(query)
    );

    const tbody = $('#menuTableBody');
    tbody.empty();

    if (items.length === 0) {
        tbody.append('<tr><td colspan="7" class="text-center text-muted py-4">No menu items found</td></tr>');
        return;
    }

    items.forEach(item => {
        const stockText = item.stock > 0
            ? `${item.stock}${item.stock <= LOW_STOCK_LIMIT ? ' <span class="badge bg-warning text-dark">Low</span>' : ''}`
            : '<span class="text-danger">Out of stock</span>';

        tbody.append(`
            <tr>
                <td><img src="${item.image || PLACEHOLDER_IMAGE}" alt="${item.name}" class="img-thumbnail" style="width: 50px;"
                         onerror="this.src='${PLACEHOLDER_IMAGE}'"></td>
                <td><strong>${item.name}</strong><br><small class="text-muted">${item.description || ''}</small></td>
                <td class="text-capitalize">${item.category}</td>
                <td>${formatPrice(item.price)}</td>
                <td>${stockText}</td>
                <td><span class="badge ${isInStock(item) ? 'bg-success' : 'bg-danger'}">${isInStock(item) ? 'Yes' : 'No'}</span></td>
                <td>
                    <button class="btn btn-sm btn-warning edit-btn" data-id="${item.id}"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm btn-danger delete-btn" data-id="${item.id}"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `);
    });
}

// Fill the modal with an existing item
function editItem(id) {
    const item = getMenuItems().find(i => i.id == id);
    if (!item) return;

    $('#itemId').val(item.id);
    $('#itemName').val(item.name);
    $('#itemCategory').val(item.category);
    $('#itemPrice').val(item.price);
    $('#itemStock').val(item.stock);
    $('#itemDescription').val(item.description || '');
    $('#itemImage').val(item.image);
    $('#itemAvailable').prop('checked', item.available);
    $('#imagePreview').attr('src', item.image || PLACEHOLDER_IMAGE);
    $('#addItemModalLabel').html('<i class="fas fa-edit"></i> Edit Item');
    $('#addItemModal').modal('show');
}

function saveItem() {
    const form = $('#itemForm')[0];
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    const items = getMenuItems();
    const id = $('#itemId').val();
    const existing = items.find(i => i.id == id);

    const item = {
        id: existing ? existing.id : Date.now(),
        name: $('#itemName').val().trim(),
        category: $('#itemCategory').val(),
        price: parseFloat($('#itemPrice').val()),
        stock: parseInt($('#itemStock').val()),
        description: $('#itemDescription').val().trim(),
        image: $('#itemImage').val().trim() || PLACEHOLDER_IMAGE,
        available: $('#itemAvailable').is(':checked'),
        popular: existing ? !!existing.popular : false
    };

    if (existing) {
        items[items.indexOf(existing)] = item;
    } else {
        items.push(item);
    }

    saveMenuItems(items);
    renderTable();
    $('#addItemModal').modal('hide');
    showToast(existing ? 'Item updated successfully!' : 'Item added successfully!', 'success');
}

function deleteItem(id) {
    if (!confirm('Are you sure you want to delete this item?')) return;

    saveMenuItems(getMenuItems().filter(i => i.id != id));
    renderTable();
    showToast('Item deleted.', 'warning');
}

// Show toast notification
function showToast(message, type = 'info') {
    const colors = { success: 'var(--dark)', warning: 'var(--amber)', danger: 'var(--error)', info: 'var(--muted)' };
    const toast = $(`
        <div style="position: fixed; top: 80px; right: 20px; background: ${colors[type] || colors.info}; color: var(--on-dark);
                    padding: 12px 20px; border-radius: 0; box-shadow: var(--shadow-sm); z-index: 9999;">
            ${message}
        </div>
    `);
    $('body').append(toast);
    setTimeout(() => toast.fadeOut(300, () => toast.remove()), 3000);
}
