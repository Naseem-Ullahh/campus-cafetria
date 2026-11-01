-- =====================================================================
-- Rule tests: proves every constraint, trigger and procedure works.
-- Run ONLY on a fresh install (01-05): it places and changes orders.
-- Output: one PASS/FAIL row per rule, then the totals.
-- =====================================================================
USE campus_cafeteria;

CREATE TABLE test_results (id INT AUTO_INCREMENT PRIMARY KEY, ok BOOLEAN, label VARCHAR(200), detail VARCHAR(300));

DELIMITER $$
CREATE PROCEDURE t_assert(IN cond BOOLEAN, IN label VARCHAR(200))
BEGIN
    INSERT INTO test_results (ok, label) VALUES (COALESCE(cond, FALSE), label);
END$$

-- Runs a statement and checks it fails with a message containing p_expected
CREATE PROCEDURE t_expect_error(IN p_sql TEXT, IN p_expected VARCHAR(255), IN label VARCHAR(200))
BEGIN
    DECLARE v_msg VARCHAR(300) DEFAULT NULL;
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
        GET DIAGNOSTICS CONDITION 1 v_msg = MESSAGE_TEXT;
    SET @t_sql = p_sql;
    PREPARE st FROM @t_sql;
    EXECUTE st;
    DEALLOCATE PREPARE st;
    INSERT INTO test_results (ok, label, detail)
    VALUES (v_msg IS NOT NULL AND v_msg LIKE CONCAT('%', p_expected, '%'), label, COALESCE(v_msg, 'NO ERROR RAISED'));
END$$
DELIMITER ;

SET @ali    = (SELECT user_id FROM Users WHERE university_id = 'STU001');
SET @fatima = (SELECT user_id FROM Users WHERE university_id = 'STU002');
SET @sana   = (SELECT user_id FROM Users WHERE university_id = 'EMP-1001');
SET @cash   = (SELECT user_id FROM Users WHERE role = 'cashier');
SET @chef   = (SELECT user_id FROM Users WHERE role = 'kitchen');
SET @admin  = (SELECT user_id FROM Users WHERE role = 'admin');
SET @burger = (SELECT item_id FROM Menu_Items WHERE item_name = 'Classic Burger');
SET @coffee = (SELECT item_id FROM Menu_Items WHERE item_name = 'Coffee');
SET @juice  = (SELECT item_id FROM Menu_Items WHERE item_name = 'Orange Juice');
SET @fries  = (SELECT item_id FROM Menu_Items WHERE item_name = 'French Fries');
SET @pizza  = (SELECT item_id FROM Menu_Items WHERE item_name = 'Margherita Pizza');

-- ---------- Users ----------
CALL t_expect_error("INSERT INTO Users (university_id, full_name, email, user_type, role, password_hash) VALUES ('EMP-9', 'X', 'x@u.edu', 'staff', 'admin', 'h')",
    'Duplicate entry', 'only one admin can exist');
CALL t_expect_error("INSERT INTO Users (university_id, full_name, email, user_type, role, password_hash) VALUES ('STU9', 'X', 'x@u.edu', 'student', 'cashier', 'h')",
    'chk_role_user_type', 'a student cannot be cashier/admin');
CALL t_expect_error("INSERT INTO Users (university_id, full_name, email, user_type, password_hash) VALUES ('STU001', 'X', 'y@u.edu', 'student', 'h')",
    'Duplicate entry', 'university ID is unique');

-- ---------- PlaceOrder: happy path ----------
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@ali, @burger, 2), (@ali, @coffee, 1);
CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, 'Cash', NULL, 'Less spicy', @o1);
CALL t_assert((SELECT total_amount FROM Orders WHERE order_id = @o1) = 290, 'order total = 2x120 + 50 (trigger)');
CALL t_assert((SELECT stock_quantity FROM Menu_Items WHERE item_id = @burger) = 38, 'stock deducted (trigger)');
CALL t_assert((SELECT amount FROM Payments WHERE order_id = @o1 AND payment_status = 'Pending') = 290, 'pending payment created with order total');
CALL t_assert((SELECT COUNT(*) FROM Cart WHERE user_id = @ali) = 0, 'cart emptied after order');
CALL t_assert((SELECT COUNT(*) FROM Order_Status_History WHERE order_id = @o1) = 1, 'history row for Received');
CALL t_assert((SELECT cancellation_deadline FROM Orders WHERE order_id = @o1) BETWEEN NOW() + INTERVAL 9 MINUTE AND NOW() + INTERVAL 11 MINUTE, 'cancel deadline = pickup - 20 min');

-- ---------- PlaceOrder: rejected inputs (and nothing half-saved) ----------
SET @orders_before = (SELECT COUNT(*) FROM Orders);
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''Cash'', NULL, NULL, @x)', 'cart is empty', 'empty cart rejected');
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@ali, @juice, 9);
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''Cash'', NULL, NULL, @x)', 'Only 8 Orange Juice left', 'insufficient stock rejected');
CALL t_assert((SELECT COUNT(*) FROM Orders) = @orders_before, 'failed order fully rolled back (no orphan order)');
CALL t_assert((SELECT COUNT(*) FROM Cart WHERE user_id = @ali) = 1, 'cart kept after failed order');
UPDATE Cart SET quantity = 1 WHERE user_id = @ali;
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 5 MINUTE, ''Cash'', NULL, NULL, @x)', 'at least 15 minutes', 'pickup too soon rejected');
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''JazzCash'', '' '', NULL, @x)', 'transaction ID', 'wallet payment without reference rejected');
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''Card'', NULL, NULL, @x)', 'Payment method must be', 'unknown payment method rejected');
DELETE FROM Cart WHERE user_id = @ali;
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@ali, @fries, 1);
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''Cash'', NULL, NULL, @x)', 'is out of stock', 'out-of-stock item rejected');
DELETE FROM Cart WHERE user_id = @ali;
UPDATE Menu_Items SET is_available = FALSE WHERE item_id = @pizza;
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@ali, @pizza, 1);
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''Cash'', NULL, NULL, @x)', 'currently unavailable', 'disabled item rejected');
DELETE FROM Cart WHERE user_id = @ali;
UPDATE Menu_Items SET is_available = TRUE WHERE item_id = @pizza;

-- ---------- Status lifecycle: manager accepts, chef cooks, cashier hands over ----------
CALL t_expect_error(CONCAT('UPDATE Orders SET status = ''Completed'' WHERE order_id = ', @o1), 'cannot change from Received to Completed', 'invalid transition blocked');
CALL t_expect_error(CONCAT('UPDATE Orders SET status = ''Preparing'' WHERE order_id = ', @o1), 'cannot change from Received to Preparing', 'kitchen cannot skip acceptance');
CALL t_expect_error(CONCAT('CALL AcceptOrder(', @o1, ', ', @ali, ', NULL)'), 'Only the manager or cashier', 'customer cannot accept orders');
CALL t_expect_error(CONCAT('CALL AcceptOrder(', @o1, ', ', @chef, ', NULL)'), 'Only the manager or cashier', 'kitchen cannot accept orders');
CALL t_expect_error(CONCAT('CALL AcceptOrder(', @o1, ', ', @cash, ', NOW() + INTERVAL 2 HOUR)'), 'ready by the requested pickup time', 'promised ready time cannot be after pickup time');
CALL AcceptOrder(@o1, @cash, NOW() + INTERVAL 25 MINUTE);
CALL t_assert((SELECT status = 'Accepted' AND accepted_at IS NOT NULL AND estimated_ready_time IS NOT NULL FROM Orders WHERE order_id = @o1), 'accepted with estimated ready time');
CALL t_expect_error(CONCAT('CALL AcceptOrder(', @o1, ', ', @admin, ', NULL)'), 'Only new orders can be accepted', 'second accept is an error, not a silent no-op');
CALL t_expect_error(CONCAT('CALL StartPreparing(', @o1, ', ', @cash, ')'), 'Only kitchen staff', 'cashier cannot start cooking');
CALL t_expect_error(CONCAT('CALL MarkReady(', @o1, ', ', @chef, ')'), 'Only orders being prepared', 'cannot mark ready before cooking starts');
CALL StartPreparing(@o1, @chef);
CALL MarkReady(@o1, @chef);
CALL t_expect_error(CONCAT('CALL CompletePickup(', @o1, ', ', @chef, ')'), 'Only the manager or cashier', 'kitchen cannot hand orders over');
CALL t_expect_error(CONCAT('UPDATE Orders SET status = ''Completed'' WHERE order_id = ', @o1), 'Payment must be confirmed', 'cannot complete unpaid order');
CALL CompletePickup(@o1, @cash);
CALL t_assert((SELECT status = 'Completed' AND accepted_at IS NOT NULL AND preparing_at IS NOT NULL AND ready_at IS NOT NULL AND picked_up_at IS NOT NULL FROM Orders WHERE order_id = @o1), 'pickup completes order + every step timestamped');
CALL t_assert((SELECT payment_status = 'Confirmed' AND verified_by = @cash FROM Payments WHERE order_id = @o1), 'cash payment confirmed by cashier');
CALL t_expect_error(CONCAT('CALL CompletePickup(', @o1, ', ', @cash, ')'), 'Only ready orders', 'cannot hand over twice');
CALL t_assert((SELECT COUNT(*) FROM Order_Status_History WHERE order_id = @o1) = 5, 'history has 5 steps');
CALL t_assert((SELECT GROUP_CONCAT(changed_by ORDER BY history_id) FROM Order_Status_History WHERE order_id = @o1)
              = CONCAT_WS(',', @ali, @cash, @chef, @chef, @cash), 'history records who did each step');

-- ---------- Rejection needs a reason ----------
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@ali, @pizza, 1);
SET @stock_pizza = (SELECT stock_quantity FROM Menu_Items WHERE item_id = @pizza);
CALL PlaceOrder(@ali, NOW() + INTERVAL 40 MINUTE, 'Cash', NULL, NULL, @o6);
CALL t_expect_error(CONCAT('CALL RejectOrder(', @o6, ', ', @cash, ', ''  '')'), 'reason is required', 'reject without a reason refused');
CALL t_assert(@actor_id IS NULL AND @status_note IS NULL, 'audit variables cleared after a failed action');
CALL t_expect_error(CONCAT('UPDATE Orders SET status = ''Rejected'' WHERE order_id = ', @o6), 'reason is required', 'direct reject without a reason refused (trigger)');
CALL t_expect_error(CONCAT('CALL RejectOrder(', @o6, ', ', @chef, ', ''Busy'')'), 'Only the manager or cashier', 'kitchen cannot reject orders');
CALL RejectOrder(@o6, @cash, 'Pizza oven is down');
CALL t_assert((SELECT status = 'Rejected' AND close_reason = 'Pizza oven is down' FROM Orders WHERE order_id = @o6), 'rejection reason saved on the order');
CALL t_assert((SELECT changed_by = @cash AND note = 'Pizza oven is down' FROM Order_Status_History WHERE order_id = @o6 AND new_status = 'Rejected'), 'rejection recorded with who and why');
CALL t_assert((SELECT stock_quantity FROM Menu_Items WHERE item_id = @pizza) = @stock_pizza, 'reject restores stock');
CALL t_expect_error(CONCAT('CALL AcceptOrder(', @o6, ', ', @cash, ', NULL)'), 'Only new orders can be accepted', 'rejected order cannot be accepted');

-- ---------- Cancellation ----------
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@fatima, @burger, 3);
CALL PlaceOrder(@fatima, NOW() + INTERVAL 2 HOUR, 'JazzCash', 'JC-778899', NULL, @o2);
CALL ConfirmPayment(@o2, @cash);
CALL t_assert((SELECT stock_quantity FROM Menu_Items WHERE item_id = @burger) = 35, 'stock 38 - 3');
CALL t_expect_error(CONCAT('CALL CancelOrder(', @o2, ', ', @ali, ')'), 'Order not found', 'cannot cancel someone else''s order');
CALL CancelOrder(@o2, @fatima);
CALL t_assert((SELECT stock_quantity FROM Menu_Items WHERE item_id = @burger) = 38, 'cancel restores stock (trigger)');
CALL t_assert((SELECT payment_status FROM Payments WHERE order_id = @o2) = 'Refunded', 'confirmed wallet payment -> Refunded');
CALL t_expect_error(CONCAT('CALL CancelOrder(', @o2, ', ', @fatima, ')'), 'can no longer be cancelled', 'cannot cancel twice (stock not restored twice)');
CALL t_assert((SELECT stock_quantity FROM Menu_Items WHERE item_id = @burger) = 38, 'stock unchanged after 2nd cancel attempt');

INSERT INTO Cart (user_id, item_id, quantity) VALUES (@fatima, @coffee, 1);
CALL PlaceOrder(@fatima, NOW() + INTERVAL 2 HOUR, 'Cash', NULL, NULL, @o7);
CALL AcceptOrder(@o7, @cash, NULL);
CALL CancelOrder(@o7, @fatima);
CALL t_assert((SELECT status FROM Orders WHERE order_id = @o7) = 'Cancelled', 'accepted order can still be cancelled');
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@fatima, @coffee, 1);
CALL PlaceOrder(@fatima, NOW() + INTERVAL 2 HOUR, 'Cash', NULL, NULL, @o8);
CALL AcceptOrder(@o8, @admin, NULL);
CALL StartPreparing(@o8, @chef);
CALL t_expect_error(CONCAT('CALL CancelOrder(', @o8, ', ', @fatima, ')'), 'can no longer be cancelled', 'cannot cancel once the kitchen has started');

INSERT INTO Cart (user_id, item_id, quantity) VALUES (@fatima, @coffee, 1);
CALL t_expect_error('CALL PlaceOrder(@fatima, NOW() + INTERVAL 1 HOUR, ''Easypaisa'', ''JC-778899'', NULL, @x)', 'Duplicate entry', 'transaction reference cannot be reused');
CALL PlaceOrder(@fatima, NOW() + INTERVAL 1 HOUR, 'Cash', NULL, NULL, @o3);
UPDATE Orders SET cancellation_deadline = NOW() - INTERVAL 1 MINUTE WHERE order_id = @o3;
CALL t_expect_error(CONCAT('CALL CancelOrder(', @o3, ', ', @fatima, ')'), 'deadline', 'cancel after deadline blocked');

-- ---------- Overdue processing, No Show and the monthly bill ----------
UPDATE Orders SET acceptance_deadline = NOW() - INTERVAL 1 MINUTE WHERE order_id = @o3;
CALL t_expect_error(CONCAT('CALL AcceptOrder(', @o3, ', ', @cash, ', NULL)'), 'acceptance window', 'cannot accept after the 10-minute window');
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@sana, @burger, 1), (@sana, @juice, 2);
CALL PlaceOrder(@sana, NOW() + INTERVAL 20 MINUTE, 'Cash', NULL, NULL, @o4);
CALL AcceptOrder(@o4, @cash, NULL);
CALL StartPreparing(@o4, @chef);
CALL MarkReady(@o4, @chef);
UPDATE Orders SET requested_pickup_time = NOW() - INTERVAL 31 MINUTE WHERE order_id = @o4;
SET @stock_juice = (SELECT stock_quantity FROM Menu_Items WHERE item_id = @juice);
CALL ProcessOverdueOrders(@rej, @ns);
CALL t_assert(@rej = 1 AND (SELECT status FROM Orders WHERE order_id = @o3) = 'Rejected', 'unaccepted order auto-rejected');
CALL t_assert((SELECT payment_status FROM Payments WHERE order_id = @o3) = 'Void', 'rejected cash payment -> Void');
CALL t_assert((SELECT changed_by IS NULL AND note = 'Not accepted within 10 minutes' FROM Order_Status_History WHERE order_id = @o3 AND new_status = 'Rejected'), 'automatic rejection recorded as system, with reason');
CALL t_assert(@ns = 1 AND (SELECT status FROM Orders WHERE order_id = @o4) = 'No Show', 'uncollected order -> No Show');
CALL t_assert((SELECT stock_quantity FROM Menu_Items WHERE item_id = @juice) = @stock_juice, 'No Show does NOT restore stock');
CALL t_assert((SELECT payment_status FROM Payments WHERE order_id = @o4) = 'Billed', 'unpaid No Show goes on the monthly bill (trigger)');
CALL t_assert((SELECT balance = 200 AND overdue = 0 FROM Account_Balances WHERE user_id = @sana), 'bill shows Rs. 200 owed, not overdue yet');
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@sana, @coffee, 1);
UPDATE Orders SET order_date = order_date - INTERVAL 2 MONTH WHERE order_id = @o4;
CALL t_assert((SELECT overdue FROM Account_Balances WHERE user_id = @sana) = 200, 'charge from 2 months ago is overdue');
CALL t_expect_error('CALL PlaceOrder(@sana, NOW() + INTERVAL 30 MINUTE, ''Cash'', NULL, NULL, @x)', 'overdue', 'customer with an overdue bill is blocked');
CALL RecordAccountPayment(@sana, @cash, 150, 'Cash', NULL, NULL, @p0);
CALL t_expect_error('CALL PlaceOrder(@sana, NOW() + INTERVAL 30 MINUTE, ''Cash'', NULL, NULL, @x)', 'Rs. 50 of your monthly bill is overdue', 'part payment leaves the rest overdue');
CALL RecordAccountPayment(@sana, @cash, 50, 'Cash', NULL, NULL, @p0);
CALL PlaceOrder(@sana, NOW() + INTERVAL 30 MINUTE, 'Cash', NULL, NULL, @o5);
CALL t_assert(@o5 IS NOT NULL AND (SELECT balance FROM Account_Balances WHERE user_id = @sana) = 0, 'can order again once the bill is paid');

-- ---------- Reviews ----------
CALL t_expect_error('INSERT INTO Reviews (user_id, item_id, rating) VALUES (@fatima, @coffee, 5)', 'completed orders', 'non-buyer cannot review');
INSERT INTO Reviews (user_id, item_id, rating, comment) VALUES (@ali, @burger, 5, 'Great');
CALL t_expect_error('INSERT INTO Reviews (user_id, item_id, rating) VALUES (@ali, @burger, 4)', 'Duplicate entry', 'one review per item per user');
CALL t_expect_error('INSERT INTO Reviews (user_id, item_id, rating) VALUES (@ali, @coffee, 6)', 'chk_rating', 'rating must be 1-5');
CALL t_assert((SELECT avg_rating FROM Menu_Catalog WHERE item_id = @burger) = 5.0, 'catalog view shows rating');

-- ---------- Views ----------
CALL t_assert((SELECT COUNT(*) FROM Menu_Catalog) = 12, 'Menu_Catalog lists 12 items');
CALL t_assert((SELECT can_order FROM Menu_Catalog WHERE item_id = @fries) = 0, 'out-of-stock item not orderable');
CALL t_assert((SELECT revenue FROM Daily_Sales WHERE sales_date = CURDATE()) = 290, 'Daily_Sales revenue = paid + billed orders (refund excluded)');
CALL t_assert((SELECT SUM(revenue) FROM Daily_Sales) = 290 + 200, 'billed No Show counted as revenue on its own day');
CALL t_assert((SELECT units_sold FROM Popular_Items WHERE item_id = @burger) = 2, 'Popular_Items counts completed orders only');
CALL t_assert((SELECT SUM(sales_amount) FROM Category_Sales) = 290, 'Category_Sales counts completed orders only');
CALL t_assert((SELECT COUNT(*) FROM Incoming_Orders) = 1 AND (SELECT order_id FROM Incoming_Orders) = @o5, 'Incoming_Orders shows only orders waiting for review');
CALL t_assert((SELECT COUNT(*) FROM Kitchen_Queue) = 1 AND (SELECT order_id FROM Kitchen_Queue) = @o8, 'Kitchen_Queue shows only accepted / cooking orders');
CALL t_assert((SELECT COUNT(*) FROM Pickup_Counter) = 0, 'Pickup_Counter empty when nothing is ready');
CALL t_assert((SELECT COUNT(*) FROM Order_Receipt_Lines WHERE order_id = @o1) = 2, 'receipt lines view');

-- ---------- Monthly bill: ordering on the bill ----------
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@ali, @coffee, 1);
CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, 'Account', 'ignored', NULL, @o9);
CALL t_assert((SELECT payment_method = 'Account' AND payment_status = 'Pending' AND transaction_reference IS NULL FROM Payments WHERE order_id = @o9), 'monthly-bill order: Pending, no transaction ID');
CALL t_assert((SELECT spent_this_month = 50 AND balance = 0 FROM Account_Balances WHERE user_id = @ali), 'order in progress counts toward the limit, not the balance');
CALL t_expect_error(CONCAT('CALL ConfirmPayment(', @o9, ', ', @cash, ')'), 'on the monthly bill', 'monthly-bill order cannot be "paid" per order');
CALL AcceptOrder(@o9, @cash, NULL);
CALL StartPreparing(@o9, @chef);
CALL MarkReady(@o9, @chef);
CALL CompletePickup(@o9, @cash);
CALL t_assert((SELECT o.status = 'Completed' AND p.payment_status = 'Billed' FROM Orders o JOIN Payments p ON p.order_id = o.order_id WHERE o.order_id = @o9), 'handing over a monthly-bill order bills it');
CALL t_assert((SELECT balance = 50 AND charged_this_month = 50 AND overdue = 0 FROM Account_Balances WHERE user_id = @ali), 'balance shows the billed order');
CALL t_assert((SELECT previous_due_date = LAST_DAY(CURDATE() - INTERVAL 1 MONTH) + INTERVAL 10 DAY
                  AND current_due_date = LAST_DAY(CURDATE()) + INTERVAL 10 DAY FROM Account_Balances WHERE user_id = @ali), 'bills are due on the 10th of the next month');

UPDATE Users SET monthly_limit = 100 WHERE user_id = @ali;
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@ali, @burger, 1);
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''Account'', NULL, NULL, @x)', 'over its Rs. 100 limit (Rs. 50 left', 'order over the monthly limit refused');
CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, 'Cash', NULL, NULL, @o10);
CALL t_assert(@o10 IS NOT NULL, 'the limit only applies to the monthly bill, not cash');
CALL CancelOrder(@o10, @ali);
UPDATE Users SET monthly_limit = NULL, account_enabled = FALSE WHERE user_id = @ali;
INSERT INTO Cart (user_id, item_id, quantity) VALUES (@ali, @coffee, 1);
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''Account'', NULL, NULL, @x)', 'not available on your account', 'customer without the monthly bill refused');
UPDATE Users SET account_enabled = TRUE WHERE user_id = @ali;
UPDATE Billing_Settings SET accounts_open = FALSE;
CALL t_expect_error('CALL PlaceOrder(@ali, NOW() + INTERVAL 30 MINUTE, ''Account'', NULL, NULL, @x)', 'switched off', 'monthly bill switched off by the manager');
UPDATE Billing_Settings SET accounts_open = TRUE;
CALL t_expect_error('UPDATE Billing_Settings SET due_day = 31', 'chk_settings_due_day', 'due day must exist in every month');
CALL t_expect_error('INSERT INTO Billing_Settings (setting_id) VALUES (2)', 'chk_settings_single_row', 'only one settings row');
DELETE FROM Cart WHERE user_id = @ali;

-- ---------- Monthly bill: paying it ----------
CALL t_expect_error('CALL RecordAccountPayment(@ali, @cash, 60, ''Cash'', NULL, NULL, @x)', 'more than the customer owes (Rs. 50)', 'cannot record more than is owed');
CALL t_expect_error('CALL RecordAccountPayment(@ali, @chef, 10, ''Cash'', NULL, NULL, @x)', 'Only the manager or cashier', 'kitchen cannot record payments');
CALL t_expect_error('CALL RecordAccountPayment(@ali, @cash, 10, ''Waiver'', NULL, ''Sorry'', @x)', 'Only the manager can waive', 'cashier cannot waive');
CALL t_expect_error('CALL RecordAccountPayment(@ali, @admin, 10, ''Waiver'', NULL, '' '', @x)', 'reason is required', 'waiver needs a reason');
CALL SubmitAccountPayment(@ali, 30, 'JazzCash', 'JC-1001', @p1);
CALL t_assert((SELECT balance = 50 AND pending_payments = 30 AND pending_payment_count = 1 FROM Account_Balances WHERE user_id = @ali), 'online payment waits for the cashier before counting');
CALL t_expect_error('CALL SubmitAccountPayment(@ali, 30, ''Easypaisa'', ''EP-1002'', @x)', 'most you can pay is Rs. 20', 'online payments cannot add up to more than is owed');
CALL t_expect_error('CALL SubmitAccountPayment(@ali, 10, ''Easypaisa'', ''JC-778899'', @x)', 'already been used', 'transaction ID used for an order cannot pay a bill');
CALL t_expect_error('CALL SubmitAccountPayment(@ali, 10, ''Cash'', ''X1'', @x)', 'Easypaisa or JazzCash', 'online bill payment must be a wallet');
CALL t_expect_error(CONCAT('CALL ConfirmAccountPayment(', @p1, ', ', @chef, ')'), 'Only the manager or cashier', 'kitchen cannot confirm bill payments');
CALL ConfirmAccountPayment(@p1, @cash);
CALL t_assert((SELECT balance = 20 AND pending_payments = 0 FROM Account_Balances WHERE user_id = @ali), 'confirmed online payment comes off the bill');
CALL t_expect_error(CONCAT('CALL ConfirmAccountPayment(', @p1, ', ', @cash, ')'), 'already been checked', 'cannot confirm twice');
CALL SubmitAccountPayment(@ali, 20, 'Easypaisa', 'EP-2002', @p2);
CALL t_expect_error(CONCAT('CALL RejectAccountPayment(', @p2, ', ', @cash, ', '' '')'), 'reason is required', 'rejecting needs a reason');
CALL RejectAccountPayment(@p2, @cash, 'No payment with this ID');
CALL t_assert((SELECT status = 'Rejected' AND note = 'No payment with this ID' FROM Account_Payments WHERE account_payment_id = @p2), 'rejected payment keeps the reason');
CALL t_assert((SELECT balance FROM Account_Balances WHERE user_id = @ali) = 20, 'rejected payment does not reduce the bill');
CALL RecordAccountPayment(@ali, @admin, 20, 'Waiver', NULL, 'Coffee was cold', @p3);
CALL t_assert((SELECT balance = 0 AND total_waived = 20 AND total_paid = 50 FROM Account_Balances WHERE user_id = @ali), 'manager waiver clears the rest');
CALL t_expect_error('CALL RecordAccountPayment(@ali, @cash, 1, ''Cash'', NULL, NULL, @x)', 'does not owe anything', 'nothing to pay once cleared');
UPDATE Orders SET order_date = order_date - INTERVAL 2 MONTH WHERE order_id = @o9;
CALL t_assert((SELECT overdue FROM Account_Balances WHERE user_id = @ali) = 0, 'an old charge that was paid is not overdue');

-- ---------- No Show correction: the customer did collect ----------
CALL MarkReady(@o8, @chef);
UPDATE Orders SET requested_pickup_time = NOW() - INTERVAL 31 MINUTE WHERE order_id = @o8;
CALL ProcessOverdueOrders(@rej, @ns);
CALL t_assert((SELECT balance FROM Account_Balances WHERE user_id = @fatima) = 50, 'No Show billed to the customer');
CALL t_expect_error(CONCAT('CALL MarkCollected(', @o8, ', ', @chef, ')'), 'Only the manager or cashier', 'kitchen cannot correct a No Show');
CALL t_expect_error(CONCAT('CALL MarkCollected(', @o1, ', ', @cash, ')'), 'Only No Show orders', 'only No Show orders can be corrected');
CALL MarkCollected(@o8, @cash);
CALL t_assert((SELECT o.status = 'Completed' AND o.close_reason IS NULL AND o.closed_at IS NULL AND p.payment_status = 'Confirmed'
                 FROM Orders o JOIN Payments p ON p.order_id = o.order_id WHERE o.order_id = @o8), 'corrected order is Completed and paid');
CALL t_assert((SELECT balance FROM Account_Balances WHERE user_id = @fatima) = 0, 'correction takes it off the bill');
CALL t_assert((SELECT changed_by = @cash AND note LIKE 'Collected%' FROM Order_Status_History WHERE order_id = @o8 AND old_status = 'No Show'), 'correction recorded with who did it');
CALL t_expect_error(CONCAT('UPDATE Orders SET status = ''No Show'' WHERE order_id = ', @o8), 'cannot change from Completed to No Show', 'completed order cannot go back to No Show');

SELECT IF(ok, 'PASS', 'FAIL') AS result, label, detail FROM test_results ORDER BY id;
SELECT SUM(ok) AS passed, SUM(NOT ok) AS failed FROM test_results;
