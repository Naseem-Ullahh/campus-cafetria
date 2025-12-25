// Orders Management JavaScript
$(document).ready(function() {
    // Initialize
    loadOrders();
    updateStatistics();
    
    // Auto-refresh every 30 seconds
    setInterval(function() {
        loadOrders();
        updateStatistics();
    }, 30000);
    
    // Mobile menu toggle
    $('#mobileMenuToggle').click(function() {
        $('.admin-sidebar').toggleClass('show');
    });

    // Refresh button
    $('#refreshOrders').click(function() {
        $(this).find('i').addClass('fa-spin');
        loadOrders();
        updateStatistics();
        setTimeout(() => {
            $(this).find('i').removeClass('fa-spin');
        }, 1000);
    });

    // Search functionality
    $('#searchOrderInput').on('keyup', function() {
        const searchTerm = $(this).val().toLowerCase();
        filterOrders(searchTerm);
    });

    // Status filter buttons
    $('.filter-btn').click(function() {
        $('.filter-btn').removeClass('active');
        $(this).addClass('active');
        const status = $(this).data('status');
        filterByStatus(status);
    });

    // Update status button
    $('#confirmStatusUpdate').click(function() {
        updateOrderStatus();
    });

    // Cancel order button
    $('#confirmCancelOrder').click(function() {
        cancelOrder();
    });
});

// Get orders from localStorage
function getOrders() {
    const orders = localStorage.getItem('orders');
    if (orders) {
        return JSON.parse(orders);
    } else {
        // Sample orders data
        const sampleOrders = [
            {
                id: 'ORD-' + Date.now() + '-001',
                studentName: 'Ali Hassan',
                studentId: 'STU001',
                items: [
                    { name: 'Chicken Burger', quantity: 2, price: 250 },
                    { name: 'French Fries', quantity: 1, price: 150 }
                ],
                totalAmount: 650,
                paymentMethod: 'Cash on Delivery',
                paymentStatus: 'Pending',
                status: 'pending',
                orderTime: new Date(Date.now() - 5 * 60000).toISOString(),
                deliveryAddress: 'Room 205, Boys Hostel',
                phone: '+92 300 1234567',
                notes: 'Extra ketchup please'
            },
            {
                id: 'ORD-' + (Date.now() - 600000) + '-002',
                studentName: 'Fatima Khan',
                studentId: 'STU002',
                items: [
                    { name: 'Cheese Pizza', quantity: 1, price: 450 }
                ],
                totalAmount: 450,
                paymentMethod: 'Online Payment',
                paymentStatus: 'Paid',
                status: 'preparing',
                orderTime: new Date(Date.now() - 15 * 60000).toISOString(),
                deliveryAddress: 'Library Study Room 3',
                phone: '+92 301 9876543',
                notes: ''
            },
            {
                id: 'ORD-' + (Date.now() - 1200000) + '-003',
                studentName: 'Ahmed Malik',
                studentId: 'STU003',
                items: [
                    { name: 'Coffee', quantity: 2, price: 120 },
                    { name: 'Pancakes', quantity: 1, price: 180 }
                ],
                totalAmount: 420,
                paymentMethod: 'Cash on Delivery',
                paymentStatus: 'Pending',
                status: 'ready',
                orderTime: new Date(Date.now() - 25 * 60000).toISOString(),
                deliveryAddress: 'Computer Lab A',
                phone: '+92 302 5551234',
                notes: 'Please call before delivery'
            }
        ];
        localStorage.setItem('orders', JSON.stringify(sampleOrders));
        return sampleOrders;
    }
}

// Load orders and display
function loadOrders() {
    const orders = getOrders();
    renderOrders(orders);
}

// Render orders in table
function renderOrders(orders) {
    const tbody = $('#ordersTableBody');
    tbody.empty();

    if (orders.length === 0) {
        tbody.append(`
            <tr>
                <td colspan="8" class="text-center py-5">
                    <i class="fas fa-inbox fa-3x text-muted mb-3"></i>
                    <p class="text-muted">No orders found</p>
                </td>
            </tr>
        `);
        return;
    }

    // Sort by order time (newest first)
    orders.sort((a, b) => new Date(b.orderTime) - new Date(a.orderTime));

    orders.forEach(order => {
        const statusBadge = getStatusBadge(order.status);
        const paymentBadge = order.paymentStatus === 'Paid' 
            ? '<span class="badge bg-success">Paid</span>'
            : '<span class="badge bg-warning">COD</span>';
        
        const timeAgo = getTimeAgo(order.orderTime);
        const itemsList = order.items.map(item => `${item.name} (x${item.quantity})`).join(', ');

        const row = `
            <tr data-order-id="${order.id}">
                <td><strong>${order.id}</strong></td>
                <td>
                    <strong>${order.studentName}</strong>
                    <br>
                    <small class="text-muted">${order.studentId}</small>
                </td>
                <td>
                    <small>${itemsList.length > 50 ? itemsList.substring(0, 50) + '...' : itemsList}</small>
                </td>
                <td><strong>PKR ${order.totalAmount}</strong></td>
                <td>${paymentBadge}</td>
                <td>${statusBadge}</td>
                <td><small>${timeAgo}</small></td>
                <td>
                    <div class="action-buttons">
                        <button class="btn btn-sm btn-info" onclick="viewOrderDetails('${order.id}')" title="View Details">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="btn btn-sm btn-primary" onclick="openUpdateStatus('${order.id}')" title="Update Status">
                            <i class="fas fa-edit"></i>
                        </button>
                        ${order.status !== 'completed' && order.status !== 'cancelled' ? 
                            `<button class="btn btn-sm btn-danger" onclick="openCancelOrder('${order.id}')" title="Cancel Order">
                                <i class="fas fa-times"></i>
                            </button>` : ''}
                    </div>
                </td>
            </tr>
        `;
        tbody.append(row);
    });
}

// Get status badge HTML
function getStatusBadge(status) {
    const badges = {
        pending: '<span class="badge bg-info"><i class="fas fa-clock"></i> Pending</span>',
        preparing: '<span class="badge bg-warning"><i class="fas fa-fire"></i> Preparing</span>',
        ready: '<span class="badge bg-primary"><i class="fas fa-check"></i> Ready</span>',
        completed: '<span class="badge bg-success"><i class="fas fa-check-double"></i> Completed</span>',
        cancelled: '<span class="badge bg-danger"><i class="fas fa-times"></i> Cancelled</span>'
    };
    return badges[status] || badges.pending;
}

// Get time ago string
function getTimeAgo(timestamp) {
    const now = new Date();
    const orderTime = new Date(timestamp);
    const diffMs = now - orderTime;
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    
    return orderTime.toLocaleDateString();
}

// Update statistics
function updateStatistics() {
    const orders = getOrders();
    const today = new Date().toDateString();
    
    const pendingCount = orders.filter(o => o.status === 'pending').length;
    const preparingCount = orders.filter(o => o.status === 'preparing').length;
    const readyCount = orders.filter(o => o.status === 'ready').length;
    const completedToday = orders.filter(o => 
        o.status === 'completed' && 
        new Date(o.orderTime).toDateString() === today
    ).length;

    $('#pendingOrdersCount').text(pendingCount);
    $('#preparingOrdersCount').text(preparingCount);
    $('#readyOrdersCount').text(readyCount);
    $('#completedOrdersCount').text(completedToday);
}

// Filter orders by search
function filterOrders(searchTerm) {
    const orders = getOrders();
    const filtered = orders.filter(order => 
        order.id.toLowerCase().includes(searchTerm) ||
        order.studentName.toLowerCase().includes(searchTerm) ||
        order.studentId.toLowerCase().includes(searchTerm)
    );
    renderOrders(filtered);
}

// Filter by status
function filterByStatus(status) {
    const orders = getOrders();
    if (status === 'all') {
        renderOrders(orders);
    } else {
        const filtered = orders.filter(order => order.status === status);
        renderOrders(filtered);
    }
}

// View order details
function viewOrderDetails(orderId) {
    const orders = getOrders();
    const order = orders.find(o => o.id === orderId);
    
    if (order) {
        const itemsHtml = order.items.map(item => `
            <tr>
                <td>${item.name}</td>
                <td class="text-center">${item.quantity}</td>
                <td class="text-end">PKR ${item.price}</td>
                <td class="text-end"><strong>PKR ${item.price * item.quantity}</strong></td>
            </tr>
        `).join('');

        const detailsHtml = `
            <div class="order-details">
                <div class="row mb-3">
                    <div class="col-md-6">
                        <h6>Order Information</h6>
                        <p><strong>Order ID:</strong> ${order.id}</p>
                        <p><strong>Status:</strong> ${getStatusBadge(order.status)}</p>
                        <p><strong>Order Time:</strong> ${new Date(order.orderTime).toLocaleString()}</p>
                    </div>
                    <div class="col-md-6">
                        <h6>Student Information</h6>
                        <p><strong>Name:</strong> ${order.studentName}</p>
                        <p><strong>Student ID:</strong> ${order.studentId}</p>
                        <p><strong>Phone:</strong> ${order.phone}</p>
                        <p><strong>Address:</strong> ${order.deliveryAddress}</p>
                    </div>
                </div>
                
                <h6>Order Items</h6>
                <table class="table table-bordered">
                    <thead>
                        <tr>
                            <th>Item</th>
                            <th class="text-center">Quantity</th>
                            <th class="text-end">Price</th>
                            <th class="text-end">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHtml}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td colspan="3" class="text-end"><strong>Total Amount:</strong></td>
                            <td class="text-end"><strong>PKR ${order.totalAmount}</strong></td>
                        </tr>
                    </tfoot>
                </table>
                
                <div class="row">
                    <div class="col-md-6">
                        <h6>Payment Details</h6>
                        <p><strong>Method:</strong> ${order.paymentMethod}</p>
                        <p><strong>Status:</strong> ${order.paymentStatus === 'Paid' ? '<span class="badge bg-success">Paid</span>' : '<span class="badge bg-warning">Pending</span>'}</p>
                    </div>
                    <div class="col-md-6">
                        <h6>Special Instructions</h6>
                        <p>${order.notes || 'No special instructions'}</p>
                    </div>
                </div>
            </div>
        `;

        $('#orderDetailsBody').html(detailsHtml);
        $('#orderDetailsModal').modal('show');
    }
}

// Open update status modal
let currentOrderId = null;
function openUpdateStatus(orderId) {
    const orders = getOrders();
    const order = orders.find(o => o.id === orderId);
    
    if (order) {
        currentOrderId = orderId;
        $('#updateOrderId').val(orderId);
        $('#currentStatus').text(order.status.charAt(0).toUpperCase() + order.status.slice(1));
        $('#newStatus').val('');
        $('#statusNotes').val('');
        $('#updateStatusModal').modal('show');
    }
}

// Update order status
function updateOrderStatus() {
    const orderId = $('#updateOrderId').val();
    const newStatus = $('#newStatus').val();
    const notes = $('#statusNotes').val();

    if (!newStatus) {
        showToast('Please select a new status', 'error');
        return;
    }

    let orders = getOrders();
    const orderIndex = orders.findIndex(o => o.id === orderId);
    
    if (orderIndex !== -1) {
        orders[orderIndex].status = newStatus;
        if (newStatus === 'completed') {
            orders[orderIndex].paymentStatus = 'Paid';
        }
        
        localStorage.setItem('orders', JSON.stringify(orders));
        
        loadOrders();
        updateStatistics();
        $('#updateStatusModal').modal('hide');
        showToast(`Order status updated to ${newStatus}!`, 'success');
    }
}

// Open cancel order modal
function openCancelOrder(orderId) {
    currentOrderId = orderId;
    $('#cancelReason').val('');
    $('#cancelOrderModal').modal('show');
}

// Cancel order
function cancelOrder() {
    const reason = $('#cancelReason').val().trim();
    
    if (!reason) {
        showToast('Please provide a cancellation reason', 'error');
        return;
    }

    let orders = getOrders();
    const orderIndex = orders.findIndex(o => o.id === currentOrderId);
    
    if (orderIndex !== -1) {
        orders[orderIndex].status = 'cancelled';
        orders[orderIndex].cancelReason = reason;
        orders[orderIndex].cancelTime = new Date().toISOString();
        
        localStorage.setItem('orders', JSON.stringify(orders));
        
        loadOrders();
        updateStatistics();
        $('#cancelOrderModal').modal('hide');
        showToast('Order cancelled successfully', 'success');
        currentOrderId = null;
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
    let orders = [];
    let currentOrderId = null;

    // Load orders from JSON
    function loadOrders() {
        $.getJSON('../data/orders.json', function(data) {
            orders = data;
            renderTable(orders);
        }).fail(function() {
            showToast('Error loading orders.', 'danger');
        });
    }

    // Render table
    function renderTable(ordersList) {
        const tbody = $('#ordersTableBody');
        tbody.empty();
        ordersList.forEach(order => {
            const statusBadge = getStatusBadge(order.status);
            const itemsSummary = order.items.map(item => `${item.name} (x${item.quantity})`).join(', ');
            const row = `
                <tr>
                    <td>${order.orderId}</td>
                    <td>${order.studentName}</td>
                    <td>${itemsSummary}</td>
                    <td>$${order.total.toFixed(2)}</td>
                    <td>${statusBadge}</td>
                    <td>${new Date(order.timestamp).toLocaleString()}</td>
                    <td>
                        <button class="btn btn-sm btn-info view-btn" data-id="${order.orderId}"><i class="fas fa-eye"></i> View</button>
                    </td>
                </tr>
            `;
            tbody.append(row);
        });
    }

    // Get status badge HTML
    function getStatusBadge(status) {
        const badges = {
            pending: '<span class="badge bg-danger">Pending</span>',
            preparing: '<span class="badge bg-warning">Preparing</span>',
            ready: '<span class="badge bg-info">Ready</span>',
            delivered: '<span class="badge bg-success">Delivered</span>'
        };
        return badges[status] || '<span class="badge bg-secondary">Unknown</span>';
    }

    // Search functionality
    $('#searchInput').on('input', function() {
        const query = $(this).val().toLowerCase();
        const filtered = orders.filter(order => 
            order.orderId.toString().includes(query) || order.studentName.toLowerCase().includes(query)
        );
        renderTable(filtered);
    });

    // Filter by status
    $('.dropdown-item').on('click', function(e) {
        e.preventDefault();
        const status = $(this).data('status');
        const filtered = status === 'all' ? orders : orders.filter(order => order.status === status);
        renderTable(filtered);
        $('#statusFilterDropdown').text($(this).text());
    });

    // View order details
    $(document).on('click', '.view-btn', function() {
        const id = $(this).data('id');
        const order = orders.find(o => o.orderId == id);
        if (order) {
            currentOrderId = id;
            const itemsList = order.items.map(item => `<li>${item.name} - $${item.price} x ${item.quantity} = $${(item.price * item.quantity).toFixed(2)}</li>`).join('');
            const details = `
                <p><strong>Order ID:</strong> ${order.orderId}</p>
                <p><strong>Student:</strong> ${order.studentName} (${order.studentId})</p>
                <p><strong>Items:</strong></p>
                <ul>${itemsList}</ul>
                <p><strong>Total:</strong> $${order.total.toFixed(2)}</p>
                <p><strong>Status:</strong> ${getStatusBadge(order.status)}</p>
                <p><strong>Timestamp:</strong> ${new Date(order.timestamp).toLocaleString()}</p>
            `;
            $('#orderDetailsContent').html(details);
            $('#statusUpdate').val(order.status);
            $('#orderDetailsModal').modal('show');
        }
    });

    // Update status
    $('#updateStatusBtn').on('click', function() {
        const newStatus = $('#statusUpdate').val();
        const order = orders.find(o => o.orderId == currentOrderId);
        if (order) {
            order.status = newStatus;
            renderTable(orders); // Re-render table
            $('#orderDetailsModal').modal('hide');
            showToast('Order status updated successfully!', 'success');
        }
    });

    // Load navbar and footer
    $('#navbar-placeholder').load('../components/navbar-admin.html');
    $('#footer-placeholder').load('../components/footer.html');

    // Initial load
    loadOrders();
});