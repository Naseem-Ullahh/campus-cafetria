// Menu Management JavaScript
// Changes are saved to the database and show up on the student menu immediately

const PREVIEW_PLACEHOLDER = 'https://placehold.co/150x150?text=Food';
let currentCategory = 'all';
let menuItems = [];

$(document).ready(async function() {
    const user = await requireStaffLogin('admin');
    if (!user) return;

    // Load navbar
    $('#navbar-placeholder').load('../../components/admin-navbar.html');

    try {
        const { categories } = await api('/categories');
        $('#itemCategory').html(categories.map(c =>
            `<option value="${c.category_id}">${escapeHtml(c.category_name)}</option>`).join(''));
    } catch (error) {
        showToast(error.message, 'danger');
    }
    await loadMenu();

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
        $('#imagePreview').attr('src', PREVIEW_PLACEHOLDER);
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
        $('#imagePreview').attr('src', $(this).val() || PREVIEW_PLACEHOLDER);
    });
});

async function loadMenu() {
    try {
        menuItems = (await api('/admin/menu')).items.map(toMenuItem);
    } catch (error) {
        $('#menuTableBody').html(`<tr><td colspan="7" class="text-center text-danger py-4">${escapeHtml(error.message)}</td></tr>`);
        return;
    }
    renderTable();
}

// Render table using current search text and category filter
function renderTable() {
    const query = ($('#searchInput').val() || '').toLowerCase();
    const items = menuItems.filter(item =>
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
            ? `${item.stock}${item.stock <= item.lowStockThreshold ? ' <span class="badge bg-warning text-dark">Low</span>' : ''}`
            : '<span class="text-danger">Out of stock</span>';
        const deleteButton = item.hasOrders
            ? `<button class="btn btn-sm btn-outline-secondary" disabled title="In past orders - switch it off instead"><i class="fas fa-trash"></i></button>`
            : `<button class="btn btn-sm btn-danger delete-btn" data-id="${item.id}" aria-label="Delete ${escapeHtml(item.name)}"><i class="fas fa-trash"></i></button>`;

        tbody.append(`
            <tr>
                <td><img src="${escapeHtml(item.image)}" alt="" class="img-thumbnail" style="width: 50px;"
                         onerror="this.src='${PREVIEW_PLACEHOLDER}'"></td>
                <td><strong>${escapeHtml(item.name)}</strong><br><small class="text-muted">${escapeHtml(item.description)}</small></td>
                <td>${escapeHtml(item.categoryName)}</td>
                <td>${formatPrice(item.price)}</td>
                <td>${stockText}</td>
                <td><span class="badge ${item.available ? 'bg-success' : 'bg-secondary'}">${item.available ? 'On' : 'Off'}</span></td>
                <td>
                    <button class="btn btn-sm btn-warning edit-btn" data-id="${item.id}" aria-label="Edit ${escapeHtml(item.name)}"><i class="fas fa-edit"></i></button>
                    ${deleteButton}
                </td>
            </tr>
        `);
    });
}

// Fill the modal with an existing item
function editItem(id) {
    const item = menuItems.find(i => i.id == id);
    if (!item) return;

    $('#itemId').val(item.id);
    $('#itemName').val(item.name);
    $('#itemCategory').val(item.categoryId);
    $('#itemPrice').val(item.price);
    $('#itemStock').val(item.stock);
    $('#itemDescription').val(item.description);
    $('#itemImage').val(item.image === PLACEHOLDER_IMAGE ? '' : item.image);
    $('#itemAvailable').prop('checked', item.available);
    $('#imagePreview').attr('src', item.image || PREVIEW_PLACEHOLDER);
    $('#addItemModalLabel').html('<i class="fas fa-edit"></i> Edit Item');
    $('#addItemModal').modal('show');
}

async function saveItem() {
    const form = $('#itemForm')[0];
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    const id = $('#itemId').val();
    const existing = menuItems.find(i => i.id == id);
    const body = {
        item_name: $('#itemName').val().trim(),
        category_id: Number($('#itemCategory').val()),
        price: Number($('#itemPrice').val()),
        stock_quantity: Number($('#itemStock').val()),
        description: $('#itemDescription').val().trim(),
        image_url: $('#itemImage').val().trim(),
        is_available: $('#itemAvailable').is(':checked'),
        low_stock_threshold: existing ? existing.lowStockThreshold : 5
    };

    $('#saveItemBtn').prop('disabled', true);
    try {
        if (existing) {
            await api('/admin/menu/' + existing.id, { method: 'PUT', body });
        } else {
            await api('/admin/menu', { method: 'POST', body });
        }
    } catch (error) {
        showToast(error.message, 'danger');
        return;
    } finally {
        $('#saveItemBtn').prop('disabled', false);
    }

    $('#addItemModal').modal('hide');
    showToast(existing ? 'Item updated successfully!' : 'Item added successfully!', 'success');
    await loadMenu();
}

async function deleteItem(id) {
    if (!confirm('Are you sure you want to delete this item?')) return;
    try {
        await api('/admin/menu/' + id, { method: 'DELETE' });
    } catch (error) {
        showToast(error.message, 'danger');
        return;
    }
    showToast('Item deleted.', 'warning');
    await loadMenu();
}

// Show toast notification
function showToast(message, type = 'info') {
    const colors = { success: 'var(--dark)', warning: 'var(--amber)', danger: 'var(--error)', info: 'var(--muted)' };
    const toast = $(`
        <div role="status" style="position: fixed; top: 80px; right: 20px; background: ${colors[type] || colors.info};
                    color: ${type === 'warning' ? 'var(--dark)' : 'var(--on-dark)'};
                    padding: 12px 20px; border-radius: var(--radius-sm); box-shadow: var(--shadow-sm); z-index: 9999;"></div>
    `).text(message);
    $('body').append(toast);
    setTimeout(() => toast.fadeOut(300, () => toast.remove()), 3000);
}
