// Receipt for ?order=<id> (or the order just placed), loaded from the server
async function loadReceipt() {
    const user = await requireStudentLogin();
    if (!user) return;

    const orderId = new URLSearchParams(location.search).get('order') || localStorage.getItem('currentOrderId');
    if (!orderId) {
        window.location.href = 'home.html';
        return;
    }

    let order;
    try {
        order = await getOrder(orderId);
    } catch (error) {
        document.getElementById('receiptItems').innerHTML =
            `<tr><td colspan="4" class="text-center text-danger">${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    document.getElementById('orderId').innerText = order.number;
    document.getElementById('orderDate').innerText = new Date(order.timestamp).toLocaleString();
    document.getElementById('pickupInfo').innerText = `Pickup: ${order.pickupTime} · ${order.fullName}`;

    document.getElementById('receiptItems').innerHTML = order.items.map(item => `
        <tr>
            <td>${escapeHtml(item.name)}</td>
            <td class="text-center">${item.quantity}</td>
            <td class="text-end">${formatPrice(item.price)}</td>
            <td class="text-end">${formatPrice(item.price * item.quantity)}</td>
        </tr>
    `).join('');

    const method = order.paymentMethod === 'Cash' ? 'Cash at the counter' : order.paymentMethod;
    const reference = order.transactionReference ? ` (ID ${order.transactionReference})` : '';
    document.getElementById('paymentInfo').innerText = `${method}${reference} - ${order.paymentStatus}`;
    document.getElementById('grandTotal').innerText = formatPrice(order.total);

    const track = document.getElementById('trackOrderLink');
    if (track) track.href = 'order-status.html?order=' + order.orderId;
}

loadReceipt();
