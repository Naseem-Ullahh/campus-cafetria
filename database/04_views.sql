-- =====================================================================
-- Views - ready-made queries the backend reads for pages and reports.
-- =====================================================================
USE campus_cafeteria;

-- Menu as customers see it: category, real availability, rating, low stock flag
CREATE OR REPLACE VIEW Menu_Catalog AS
SELECT
    m.item_id,
    m.item_name,
    m.description,
    m.price,
    m.image_url,
    c.category_id,
    c.category_name,
    m.stock_quantity,
    m.is_available,
    (m.is_available AND m.stock_quantity > 0)          AS can_order,
    (m.stock_quantity <= m.low_stock_threshold)        AS is_low_stock,
    ROUND(AVG(r.rating), 1)                            AS avg_rating,
    COUNT(r.review_id)                                 AS review_count
FROM Menu_Items m
JOIN Categories c   ON c.category_id = m.category_id
LEFT JOIN Reviews r ON r.item_id = m.item_id
GROUP BY m.item_id, c.category_id;

-- One row per order with customer and payment details (order lists, receipt header)
CREATE OR REPLACE VIEW Order_Summary AS
SELECT
    o.order_id,
    o.order_date,
    o.requested_pickup_time,
    o.estimated_ready_time,
    o.cancellation_deadline,
    o.status,
    o.close_reason,
    o.total_amount,
    o.special_instructions,
    u.user_id,
    u.university_id,
    u.full_name,
    u.phone,
    u.user_type,
    p.payment_method,
    p.payment_status,
    p.transaction_reference,
    p.verified_at,
    v.full_name                     AS verified_by_name,
    (SELECT SUM(od.quantity) FROM Order_Details od WHERE od.order_id = o.order_id) AS item_count
FROM Orders o
JOIN Users u          ON u.user_id = o.user_id
LEFT JOIN Payments p  ON p.order_id = o.order_id
LEFT JOIN Users v     ON v.user_id = p.verified_by;

-- Receipt / order detail lines (the receipt is generated, not stored)
CREATE OR REPLACE VIEW Order_Receipt_Lines AS
SELECT
    od.order_id,
    m.item_id,
    m.item_name,
    c.category_name,
    od.quantity,
    od.unit_price,
    od.quantity * od.unit_price     AS line_total
FROM Order_Details od
JOIN Menu_Items m  ON m.item_id = od.item_id
JOIN Categories c  ON c.category_id = m.category_id;

-- The three staff screens. Each shows one stage of the same orders.

-- Incoming board (manager / cashier): new orders to accept or reject,
-- with how long each has waited and how long is left to decide
CREATE OR REPLACE VIEW Incoming_Orders AS
SELECT
    o.order_id,
    o.order_date,
    o.requested_pickup_time,
    o.acceptance_deadline,
    TIMESTAMPDIFF(MINUTE, o.order_date, NOW())           AS minutes_waiting,
    GREATEST(TIMESTAMPDIFF(SECOND, NOW(), o.acceptance_deadline), 0) AS seconds_to_decide,
    o.total_amount,
    u.full_name,
    u.university_id,
    p.payment_method,
    p.payment_status,
    p.transaction_reference,
    GROUP_CONCAT(CONCAT(od.quantity, ' x ', m.item_name) ORDER BY m.item_name SEPARATOR ', ') AS items,
    o.special_instructions
FROM Orders o
JOIN Users u          ON u.user_id = o.user_id
JOIN Payments p       ON p.order_id = o.order_id
JOIN Order_Details od ON od.order_id = o.order_id
JOIN Menu_Items m     ON m.item_id = od.item_id
WHERE o.status = 'Received'
GROUP BY o.order_id, u.user_id, p.payment_id
ORDER BY o.acceptance_deadline;

-- Kitchen display (chef): accepted orders to cook, the one due first on top.
-- No payment details - the kitchen doesn't need them.
CREATE OR REPLACE VIEW Kitchen_Queue AS
SELECT
    o.order_id,
    o.status,
    o.requested_pickup_time,
    o.estimated_ready_time,
    o.accepted_at,
    o.preparing_at,
    TIMESTAMPDIFF(MINUTE, NOW(), o.estimated_ready_time) AS minutes_until_due,
    u.full_name,
    GROUP_CONCAT(CONCAT(od.quantity, ' x ', m.item_name) ORDER BY m.item_name SEPARATOR ', ') AS items,
    o.special_instructions
FROM Orders o
JOIN Users u          ON u.user_id = o.user_id
JOIN Order_Details od ON od.order_id = o.order_id
JOIN Menu_Items m     ON m.item_id = od.item_id
WHERE o.status IN ('Accepted', 'Preparing')
GROUP BY o.order_id, u.user_id
ORDER BY o.estimated_ready_time;

-- Pickup counter (cashier): ready orders waiting to be collected,
-- with what is still to be paid
CREATE OR REPLACE VIEW Pickup_Counter AS
SELECT
    o.order_id,
    o.ready_at,
    o.requested_pickup_time,
    TIMESTAMPDIFF(MINUTE, o.ready_at, NOW())             AS minutes_waiting,
    o.requested_pickup_time + INTERVAL 30 MINUTE         AS no_show_after,
    o.total_amount,
    u.full_name,
    u.university_id,
    u.phone,
    p.payment_method,
    p.payment_status,
    p.transaction_reference,
    GROUP_CONCAT(CONCAT(od.quantity, ' x ', m.item_name) ORDER BY m.item_name SEPARATOR ', ') AS items
FROM Orders o
JOIN Users u          ON u.user_id = o.user_id
JOIN Payments p       ON p.order_id = o.order_id
JOIN Order_Details od ON od.order_id = o.order_id
JOIN Menu_Items m     ON m.item_id = od.item_id
WHERE o.status = 'Ready'
GROUP BY o.order_id, u.user_id, p.payment_id
ORDER BY o.requested_pickup_time;

-- Daily sales: revenue = money actually confirmed (refunds excluded)
CREATE OR REPLACE VIEW Daily_Sales AS
SELECT
    DATE(o.order_date)                                              AS sales_date,
    COUNT(*)                                                        AS orders_placed,
    SUM(o.status = 'Completed')                                     AS completed_orders,
    SUM(o.status IN ('Cancelled', 'Rejected'))                      AS cancelled_or_rejected,
    SUM(o.status = 'No Show')                                       AS no_shows,
    COALESCE(SUM(CASE WHEN p.payment_status = 'Confirmed' THEN p.amount END), 0) AS revenue
FROM Orders o
LEFT JOIN Payments p ON p.order_id = o.order_id
GROUP BY DATE(o.order_date);

-- Best sellers (completed orders only)
CREATE OR REPLACE VIEW Popular_Items AS
SELECT
    m.item_id,
    m.item_name,
    c.category_name,
    SUM(od.quantity)                    AS units_sold,
    SUM(od.quantity * od.unit_price)    AS sales_amount,
    COUNT(DISTINCT o.order_id)          AS order_count
FROM Order_Details od
JOIN Orders o      ON o.order_id = od.order_id
JOIN Menu_Items m  ON m.item_id = od.item_id
JOIN Categories c  ON c.category_id = m.category_id
WHERE o.status = 'Completed'
GROUP BY m.item_id, c.category_id;

-- Sales per category (completed orders only)
CREATE OR REPLACE VIEW Category_Sales AS
SELECT
    c.category_id,
    c.category_name,
    COALESCE(SUM(sold.quantity), 0)                     AS units_sold,
    COALESCE(SUM(sold.quantity * sold.unit_price), 0)   AS sales_amount
FROM Categories c
LEFT JOIN Menu_Items m ON m.category_id = c.category_id
LEFT JOIN (
    SELECT od.item_id, od.quantity, od.unit_price
    FROM Order_Details od
    JOIN Orders o ON o.order_id = od.order_id
    WHERE o.status = 'Completed'
) sold ON sold.item_id = m.item_id
GROUP BY c.category_id;

-- Items at or below their low-stock threshold
CREATE OR REPLACE VIEW Low_Stock_Items AS
SELECT m.item_id, m.item_name, c.category_name, m.stock_quantity, m.low_stock_threshold, m.is_available
FROM Menu_Items m
JOIN Categories c ON c.category_id = m.category_id
WHERE m.stock_quantity <= m.low_stock_threshold
ORDER BY m.stock_quantity;

-- Customers who owe money for orders they never collected
CREATE OR REPLACE VIEW Outstanding_Dues AS
SELECT
    u.user_id,
    u.university_id,
    u.full_name,
    u.phone,
    COUNT(o.order_id)   AS unpaid_no_shows,
    SUM(p.amount)       AS amount_due
FROM Users u
JOIN Orders o   ON o.user_id = u.user_id AND o.status = 'No Show'
JOIN Payments p ON p.order_id = o.order_id AND p.payment_status = 'Pending'
GROUP BY u.user_id;
