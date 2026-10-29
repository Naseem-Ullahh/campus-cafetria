function loadReceipt() {
    const order = JSON.parse(localStorage.getItem('currentOrder'));

    if (!order) {
        alert('No order found!');
        window.location.href = 'home.html';
        return;
    }

    document.getElementById('orderId').innerText = order.orderId;
    document.getElementById('orderDate').innerText = new Date(order.timestamp).toLocaleString();
    if (order.pickupTime) {
        document.getElementById('pickupInfo').innerText = `Pickup: ${order.pickupTime} · ${order.fullName}`;
    }

    document.getElementById('receiptItems').innerHTML = order.items.map(item => `
        <tr>
            <td>${item.name}</td>
            <td class="text-center">${item.quantity}</td>
            <td class="text-end">${formatPrice(item.price)}</td>
            <td class="text-end">${formatPrice(item.price * item.quantity)}</td>
        </tr>
    `).join('');

    const method = order.paymentMethod === 'Cash' ? 'Cash at the counter' : order.paymentMethod;
    const reference = order.transactionReference ? ` (ID ${order.transactionReference})` : '';
    document.getElementById('paymentInfo').innerText = `${method}${reference} - ${order.paymentStatus || 'Pending'}`;
    document.getElementById('grandTotal').innerText = formatPrice(order.total);
}

loadReceipt();
