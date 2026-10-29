-- =====================================================================
-- JOIN queries - each answers a real question the cafeteria would ask.
-- Set the variables first, then run any query on its own.
-- =====================================================================
USE campus_cafeteria;

SET @user_id  = (SELECT user_id FROM Users WHERE university_id = 'STU001');
SET @order_id = (SELECT MIN(order_id) FROM Orders);

-- 1. A customer's full order history, item by item (3 tables)
SELECT o.order_id, o.order_date, o.status, m.item_name, od.quantity, od.unit_price,
       od.quantity * od.unit_price AS line_total
FROM Orders o
JOIN Order_Details od ON od.order_id = o.order_id
JOIN Menu_Items m     ON m.item_id = od.item_id
WHERE o.user_id = @user_id
ORDER BY o.order_date DESC, m.item_name;

-- 2. Receipt header for one order: customer + payment + who verified it (4 tables, self-join on Users)
SELECT o.order_id, o.order_date, o.requested_pickup_time, o.status, o.total_amount,
       u.university_id, u.full_name, p.payment_method, p.payment_status,
       p.transaction_reference, v.full_name AS verified_by
FROM Orders o
JOIN Users u         ON u.user_id = o.user_id
JOIN Payments p      ON p.order_id = o.order_id
LEFT JOIN Users v    ON v.user_id = p.verified_by
WHERE o.order_id = @order_id;

-- 3. Pickups due in the next hour with what to prepare (4 tables)
SELECT o.order_id, o.requested_pickup_time, u.full_name, o.status,
       GROUP_CONCAT(CONCAT(od.quantity, ' x ', m.item_name) SEPARATOR ', ') AS items
FROM Orders o
JOIN Users u          ON u.user_id = o.user_id
JOIN Order_Details od ON od.order_id = o.order_id
JOIN Menu_Items m     ON m.item_id = od.item_id
WHERE o.status IN ('Received', 'Accepted', 'Preparing', 'Ready')
  AND o.requested_pickup_time <= NOW() + INTERVAL 1 HOUR
GROUP BY o.order_id, u.full_name
ORDER BY o.requested_pickup_time;

-- 4. Confirmed revenue per payment method
SELECT p.payment_method, COUNT(*) AS payments, SUM(p.amount) AS revenue
FROM Payments p
JOIN Orders o ON o.order_id = p.order_id
WHERE p.payment_status = 'Confirmed'
GROUP BY p.payment_method
ORDER BY revenue DESC;

-- 5. Top customers by money spent (3 tables)
SELECT u.university_id, u.full_name, u.user_type,
       COUNT(o.order_id) AS orders, SUM(p.amount) AS total_spent
FROM Users u
JOIN Orders o   ON o.user_id = u.user_id
JOIN Payments p ON p.order_id = o.order_id AND p.payment_status = 'Confirmed'
GROUP BY u.user_id
ORDER BY total_spent DESC
LIMIT 10;

-- 6. Menu items that have never been ordered (LEFT JOIN ... IS NULL)
SELECT m.item_id, m.item_name, c.category_name, m.price
FROM Menu_Items m
JOIN Categories c          ON c.category_id = m.category_id
LEFT JOIN Order_Details od ON od.item_id = m.item_id
WHERE od.item_id IS NULL;

-- 7. Rating per item, including items nobody has reviewed yet (LEFT JOIN)
SELECT m.item_name, c.category_name,
       ROUND(AVG(r.rating), 1) AS avg_rating, COUNT(r.review_id) AS reviews
FROM Menu_Items m
JOIN Categories c   ON c.category_id = m.category_id
LEFT JOIN Reviews r ON r.item_id = m.item_id
GROUP BY m.item_id, c.category_name
ORDER BY avg_rating DESC, reviews DESC;

-- 8. Customers with No Show orders and how much is still owed (3 tables)
SELECT u.university_id, u.full_name, u.phone, o.order_id, o.requested_pickup_time,
       p.amount, p.payment_status
FROM Users u
JOIN Orders o   ON o.user_id = u.user_id
JOIN Payments p ON p.order_id = o.order_id
WHERE o.status = 'No Show'
ORDER BY p.payment_status DESC, o.requested_pickup_time DESC;

-- 9. Payments verified by each staff member (accountability log)
SELECT s.full_name AS staff, s.role, COUNT(p.payment_id) AS payments_verified,
       SUM(p.amount) AS amount_verified
FROM Users s
JOIN Payments p ON p.verified_by = s.user_id
GROUP BY s.user_id
ORDER BY payments_verified DESC;

-- 10. Orders charged at an old price (why Order_Details stores unit_price)
SELECT o.order_id, o.order_date, m.item_name, od.unit_price AS price_paid,
       m.price AS current_price, m.price - od.unit_price AS difference
FROM Order_Details od
JOIN Orders o     ON o.order_id = od.order_id
JOIN Menu_Items m ON m.item_id = od.item_id
WHERE od.unit_price <> m.price;

-- 11. Sales by type of customer: students vs faculty vs staff (3 tables)
SELECT u.user_type, COUNT(DISTINCT o.order_id) AS completed_orders,
       SUM(od.quantity) AS items_bought, SUM(od.quantity * od.unit_price) AS sales
FROM Users u
JOIN Orders o         ON o.user_id = u.user_id AND o.status = 'Completed'
JOIN Order_Details od ON od.order_id = o.order_id
GROUP BY u.user_type;

-- 12. Average cooking time (kitchen started -> ready) per category (4 tables)
SELECT c.category_name,
       ROUND(AVG(TIMESTAMPDIFF(MINUTE, o.preparing_at, o.ready_at)), 1) AS avg_prep_minutes,
       COUNT(DISTINCT o.order_id) AS orders
FROM Orders o
JOIN Order_Details od ON od.order_id = o.order_id
JOIN Menu_Items m     ON m.item_id = od.item_id
JOIN Categories c     ON c.category_id = m.category_id
WHERE o.preparing_at IS NOT NULL AND o.ready_at IS NOT NULL
GROUP BY c.category_id;

-- 13. Full status timeline of one order: who changed it, when and why
--     (Users joined twice: once as the customer, once as the staff member)
SELECT h.order_id, u.full_name AS customer, h.old_status, h.new_status,
       COALESCE(s.full_name, 'System') AS changed_by, s.role, h.note, h.changed_at
FROM Order_Status_History h
JOIN Orders o     ON o.order_id = h.order_id
JOIN Users u      ON u.user_id = o.user_id
LEFT JOIN Users s ON s.user_id = h.changed_by
WHERE h.order_id = @order_id
ORDER BY h.changed_at, h.history_id;

-- 14. Items frequently bought together (self-join on Order_Details)
SELECT a.item_name AS item, b.item_name AS bought_with, COUNT(*) AS times_together
FROM Order_Details x
JOIN Order_Details y ON y.order_id = x.order_id AND y.item_id > x.item_id
JOIN Menu_Items a    ON a.item_id = x.item_id
JOIN Menu_Items b    ON b.item_id = y.item_id
GROUP BY a.item_id, b.item_id
ORDER BY times_together DESC
LIMIT 10;

-- 15. Staff activity: how many orders each staff member accepted, rejected,
--     cooked and handed over (staff only, customers' own actions excluded)
SELECT s.full_name, s.role,
       SUM(h.new_status = 'Accepted')  AS accepted,
       SUM(h.new_status = 'Rejected')  AS rejected,
       SUM(h.new_status = 'Ready')     AS cooked,
       SUM(h.new_status = 'Completed') AS handed_over
FROM Order_Status_History h
JOIN Users s ON s.user_id = h.changed_by
WHERE s.role <> 'customer'
GROUP BY s.user_id
ORDER BY s.role, s.full_name;
