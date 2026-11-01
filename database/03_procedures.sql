-- =====================================================================
-- Stored procedures - the operations the Flask backend calls.
-- Each runs as one transaction: it either fully succeeds or changes nothing.
-- Errors are raised with readable messages the website can show directly.
-- =====================================================================
USE campus_cafeteria;

DELIMITER $$

-- ---------------------------------------------------------------------
-- PlaceOrder: cart -> order + order details + payment, then empty the cart.
-- Stock checks / deduction and the order total are done by triggers.
--
-- Rules:
--  * account must be active and have nothing overdue on its monthly bill
--  * pickup time between 15 minutes and 24 hours from now
--  * cafeteria must accept within 10 minutes
--  * customer may cancel until 20 minutes before pickup
--    (but always gets at least 5 minutes after ordering)
--  * Easypaisa / JazzCash need a transaction reference; cash must not have one
--  * Account (monthly bill): offered by the cafeteria, allowed for this
--    customer, and this month's bill must stay within their limit
-- ---------------------------------------------------------------------
CREATE PROCEDURE PlaceOrder(
    IN  p_user_id               INT,
    IN  p_requested_pickup_time DATETIME,
    IN  p_payment_method        VARCHAR(20),
    IN  p_transaction_reference VARCHAR(50),
    IN  p_special_instructions  VARCHAR(255),
    OUT p_new_order_id          INT
)
BEGIN
    DECLARE v_is_active BOOLEAN;
    DECLARE v_overdue DECIMAL(10,2);
    DECLARE v_account_enabled BOOLEAN;
    DECLARE v_limit DECIMAL(10,2);
    DECLARE v_spent DECIMAL(10,2);
    DECLARE v_order_total DECIMAL(10,2);
    DECLARE v_msg VARCHAR(255);
    DECLARE v_locked INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        DROP TEMPORARY TABLE IF EXISTS tmp_order_lines;
        RESIGNAL;
    END;

    SET p_transaction_reference = NULLIF(TRIM(p_transaction_reference), '');

    SELECT is_active INTO v_is_active FROM Users WHERE user_id = p_user_id;
    IF v_is_active IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'User not found';
    ELSEIF v_is_active = FALSE THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This account is deactivated';
    END IF;

    -- A monthly bill not paid by its due date blocks new orders
    SELECT overdue INTO v_overdue FROM Account_Balances WHERE user_id = p_user_id;
    IF v_overdue > 0 THEN
        SET v_msg = CONCAT('Rs. ', FORMAT(v_overdue, 0), ' of your monthly bill is overdue. ',
                           'Pay it (Profile > Amount Payable) to order again.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    IF p_requested_pickup_time < NOW() + INTERVAL 15 MINUTE THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Pickup time must be at least 15 minutes from now';
    END IF;
    IF p_requested_pickup_time > NOW() + INTERVAL 24 HOUR THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Pickup time must be within the next 24 hours';
    END IF;

    IF p_payment_method IS NULL OR p_payment_method NOT IN ('Cash', 'Easypaisa', 'JazzCash', 'Account') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payment method must be Cash, Easypaisa, JazzCash or Monthly bill';
    END IF;
    IF p_payment_method IN ('Easypaisa', 'JazzCash') AND p_transaction_reference IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enter the transaction ID from your Easypaisa / JazzCash payment';
    END IF;
    IF p_payment_method IN ('Cash', 'Account') THEN
        SET p_transaction_reference = NULL;
    END IF;
    IF p_payment_method = 'Account' THEN
        IF NOT (SELECT accounts_open FROM Billing_Settings WHERE setting_id = 1) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Paying with the monthly bill is switched off right now - choose another payment method';
        END IF;
        SELECT account_enabled INTO v_account_enabled FROM Users WHERE user_id = p_user_id;
        IF NOT v_account_enabled THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The monthly bill is not available on your account - pay with Cash, Easypaisa or JazzCash';
        END IF;
    END IF;

    START TRANSACTION;

    -- Lock the menu rows we are about to sell, in item order, BEFORE reading
    -- them. Otherwise two customers ordering the same item at the same moment
    -- both take a shared read lock, then both wait to upgrade it for the stock
    -- update - a deadlock. Locking first makes the second order simply wait.
    SELECT COUNT(*) INTO v_locked
      FROM Menu_Items
     WHERE item_id IN (SELECT item_id FROM Cart WHERE user_id = p_user_id)
     ORDER BY item_id
       FOR UPDATE;

    -- Copy the cart with current prices first. Inserting straight from a
    -- SELECT on Menu_Items would fail: the stock trigger updates Menu_Items,
    -- and MySQL forbids a trigger changing a table its statement is reading.
    DROP TEMPORARY TABLE IF EXISTS tmp_order_lines;
    CREATE TEMPORARY TABLE tmp_order_lines AS
        SELECT c.item_id, c.quantity, m.price AS unit_price
          FROM Cart c
          JOIN Menu_Items m ON m.item_id = c.item_id
         WHERE c.user_id = p_user_id;

    IF (SELECT COUNT(*) FROM tmp_order_lines) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Your cart is empty';
    END IF;

    -- Monthly limit. The customer's row is locked first, so two orders placed
    -- at the same moment can't both squeeze under the limit.
    IF p_payment_method = 'Account' THEN
        SELECT COUNT(*) INTO v_locked FROM Users WHERE user_id = p_user_id FOR UPDATE;
        SELECT monthly_limit, spent_this_month INTO v_limit, v_spent
          FROM Account_Balances WHERE user_id = p_user_id;
        SELECT SUM(quantity * unit_price) INTO v_order_total FROM tmp_order_lines;
        IF v_spent + v_order_total > v_limit THEN
            SET v_msg = CONCAT('This order would take your monthly bill over its Rs. ', FORMAT(v_limit, 0),
                               ' limit (Rs. ', FORMAT(GREATEST(v_limit - v_spent, 0), 0), ' left this month)');
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
        END IF;
    END IF;

    INSERT INTO Orders (user_id, requested_pickup_time, acceptance_deadline,
                        cancellation_deadline, special_instructions)
    VALUES (p_user_id,
            p_requested_pickup_time,
            NOW() + INTERVAL 10 MINUTE,
            GREATEST(NOW() + INTERVAL 5 MINUTE, p_requested_pickup_time - INTERVAL 20 MINUTE),
            NULLIF(TRIM(p_special_instructions), ''));

    SET p_new_order_id = LAST_INSERT_ID();

    -- Triggers check stock, deduct it and add up total_amount
    INSERT INTO Order_Details (order_id, item_id, quantity, unit_price)
    SELECT p_new_order_id, item_id, quantity, unit_price FROM tmp_order_lines;

    INSERT INTO Payments (order_id, payment_method, amount, transaction_reference)
    SELECT p_new_order_id, p_payment_method, total_amount, p_transaction_reference
      FROM Orders WHERE order_id = p_new_order_id;

    DELETE FROM Cart WHERE user_id = p_user_id;
    DROP TEMPORARY TABLE tmp_order_lines;

    COMMIT;
END$$

-- ---------------------------------------------------------------------
-- Helpers used by the procedures below (the backend does not call these).
-- ---------------------------------------------------------------------

-- CheckStaff: the user must be active and have one of the listed roles
CREATE PROCEDURE CheckStaff(IN p_user_id INT, IN p_roles VARCHAR(100), IN p_message VARCHAR(255))
BEGIN
    IF NOT EXISTS (SELECT 1 FROM Users
                    WHERE user_id = p_user_id AND is_active AND FIND_IN_SET(role, p_roles)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = p_message;
    END IF;
END$$

-- MoveOrderStatus: the one place an order's status changes.
-- Locks the order row first, so if two staff press "Accept" at the same
-- moment the second one gets a clear error instead of a silent no-op.
-- Records who did it and why (read by trg_orders_after_update).
CREATE PROCEDURE MoveOrderStatus(
    IN p_order_id        INT,
    IN p_from            VARCHAR(100),   -- allowed current statuses, comma-separated
    IN p_to              VARCHAR(20),
    IN p_actor_id        INT,
    IN p_note            VARCHAR(255),
    IN p_estimated_ready DATETIME,       -- only used when accepting
    IN p_wrong_status    VARCHAR(255)    -- message if the order is in another status
)
BEGIN
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET @actor_id = NULL, @status_note = NULL;
        RESIGNAL;
    END;

    START TRANSACTION;

    SELECT status INTO v_status FROM Orders WHERE order_id = p_order_id FOR UPDATE;
    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order not found';
    ELSEIF NOT FIND_IN_SET(v_status, p_from) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = p_wrong_status;
    END IF;

    SET @actor_id = p_actor_id, @status_note = p_note;
    UPDATE Orders
       SET status = p_to,
           estimated_ready_time = COALESCE(p_estimated_ready, estimated_ready_time)
     WHERE order_id = p_order_id;
    SET @actor_id = NULL, @status_note = NULL;

    COMMIT;
END$$

-- ---------------------------------------------------------------------
-- CancelOrder: customer cancels their own order before the deadline,
-- while it is still waiting (Received / Accepted). Once the kitchen has
-- started cooking it can no longer be cancelled.
-- Trigger restores stock and voids / refunds the payment.
-- ---------------------------------------------------------------------
CREATE PROCEDURE CancelOrder(IN p_order_id INT, IN p_user_id INT)
BEGIN
    IF NOT EXISTS (SELECT 1 FROM Orders WHERE order_id = p_order_id AND user_id = p_user_id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order not found';
    END IF;

    CALL MoveOrderStatus(p_order_id, 'Received,Accepted', 'Cancelled', p_user_id,
                         'Cancelled by customer', NULL,
                         'This order can no longer be cancelled');
END$$

-- ---------------------------------------------------------------------
-- AcceptOrder: manager / cashier commits to a new order and promises a
-- ready time (defaults to the requested pickup time). It must be accepted
-- within the 10-minute window, and the ready time can't be later than the
-- pickup time the customer asked for - if the kitchen can't make it,
-- reject the order with that reason instead.
-- ---------------------------------------------------------------------
CREATE PROCEDURE AcceptOrder(IN p_order_id INT, IN p_staff_id INT, IN p_estimated_ready_time DATETIME)
BEGIN
    DECLARE v_pickup DATETIME;
    DECLARE v_deadline DATETIME;
    DECLARE v_ready DATETIME;

    CALL CheckStaff(p_staff_id, 'admin,cashier', 'Only the manager or cashier can accept orders');

    SELECT requested_pickup_time, acceptance_deadline INTO v_pickup, v_deadline
      FROM Orders WHERE order_id = p_order_id;
    IF v_pickup IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order not found';
    END IF;
    IF NOW() > v_deadline THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The 10-minute acceptance window for this order has passed';
    END IF;

    SET v_ready = COALESCE(p_estimated_ready_time, v_pickup);
    IF v_ready <= NOW() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The estimated ready time must be in the future';
    ELSEIF v_ready > v_pickup THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The order must be ready by the requested pickup time - reject it if the kitchen cannot make it';
    END IF;

    CALL MoveOrderStatus(p_order_id, 'Received', 'Accepted', p_staff_id, NULL, v_ready,
                         'Only new orders can be accepted');
END$$

-- ---------------------------------------------------------------------
-- RejectOrder: manager / cashier declines a new order. A reason is
-- required (e.g. "Pizza oven is down", "Can't be ready by 1:00 PM").
-- Trigger restores stock and voids / refunds the payment.
-- ---------------------------------------------------------------------
CREATE PROCEDURE RejectOrder(IN p_order_id INT, IN p_staff_id INT, IN p_reason VARCHAR(255))
BEGIN
    CALL CheckStaff(p_staff_id, 'admin,cashier', 'Only the manager or cashier can reject orders');

    IF COALESCE(TRIM(p_reason), '') = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A reason is required to reject an order';
    END IF;

    CALL MoveOrderStatus(p_order_id, 'Received', 'Rejected', p_staff_id, p_reason, NULL,
                         'Only new orders can be rejected');
END$$

-- ---------------------------------------------------------------------
-- StartPreparing / MarkReady: the kitchen moves accepted orders along.
-- ---------------------------------------------------------------------
CREATE PROCEDURE StartPreparing(IN p_order_id INT, IN p_staff_id INT)
BEGIN
    CALL CheckStaff(p_staff_id, 'admin,kitchen', 'Only kitchen staff can start preparing orders');
    CALL MoveOrderStatus(p_order_id, 'Accepted', 'Preparing', p_staff_id, NULL, NULL,
                         'Only accepted orders can be started');
END$$

CREATE PROCEDURE MarkReady(IN p_order_id INT, IN p_staff_id INT)
BEGIN
    CALL CheckStaff(p_staff_id, 'admin,kitchen', 'Only kitchen staff can mark orders ready');
    CALL MoveOrderStatus(p_order_id, 'Preparing', 'Ready', p_staff_id, NULL, NULL,
                         'Only orders being prepared can be marked ready');
END$$

-- ---------------------------------------------------------------------
-- ConfirmPayment: cashier received cash / verified a wallet transaction
-- in the cafeteria's Easypaisa / JazzCash merchant app.
-- A wallet payment that was still unchecked when the order became a No
-- Show (so it went on the monthly bill) can be verified later - that
-- takes it off the bill. Monthly-bill orders are paid with the bill.
-- ---------------------------------------------------------------------
CREATE PROCEDURE ConfirmPayment(IN p_order_id INT, IN p_staff_id INT)
BEGIN
    DECLARE v_status VARCHAR(20);
    DECLARE v_method VARCHAR(20);

    CALL CheckStaff(p_staff_id, 'admin,cashier', 'Only the manager or cashier can confirm payments');

    SELECT payment_status, payment_method INTO v_status, v_method FROM Payments WHERE order_id = p_order_id;
    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No payment found for this order';
    ELSEIF v_method = 'Account' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This order is on the monthly bill - record the payment against the bill';
    ELSEIF NOT (v_status = 'Pending' OR (v_status = 'Billed' AND v_method <> 'Cash')) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This payment is not pending';
    END IF;

    UPDATE Payments
       SET payment_status = 'Confirmed', verified_by = p_staff_id, verified_at = NOW()
     WHERE order_id = p_order_id;
END$$

-- ---------------------------------------------------------------------
-- CompletePickup: customer collects the food at the counter. Takes the
-- payment if it is still pending (e.g. cash) - or adds it to the monthly
-- bill - and completes the order in one transaction.
-- ---------------------------------------------------------------------
CREATE PROCEDURE CompletePickup(IN p_order_id INT, IN p_staff_id INT)
BEGIN
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET @actor_id = NULL, @status_note = NULL;
        RESIGNAL;
    END;

    CALL CheckStaff(p_staff_id, 'admin,cashier', 'Only the manager or cashier can hand orders over');

    START TRANSACTION;

    SELECT status INTO v_status FROM Orders WHERE order_id = p_order_id FOR UPDATE;
    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order not found';
    ELSEIF v_status <> 'Ready' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only ready orders can be handed over';
    END IF;

    IF (SELECT payment_method FROM Payments WHERE order_id = p_order_id) = 'Account' THEN
        UPDATE Payments SET payment_status = 'Billed'
         WHERE order_id = p_order_id AND payment_status = 'Pending';
    ELSEIF (SELECT payment_status FROM Payments WHERE order_id = p_order_id) = 'Pending' THEN
        CALL ConfirmPayment(p_order_id, p_staff_id);
    END IF;

    SET @actor_id = p_staff_id, @status_note = NULL;
    UPDATE Orders SET status = 'Completed' WHERE order_id = p_order_id;
    SET @actor_id = NULL;

    COMMIT;
END$$

-- ---------------------------------------------------------------------
-- MarkCollected: the customer DID collect (and pay for) a No Show order,
-- but the cashier didn't record it in time. Turns it into Completed, takes
-- it off the monthly bill (the cash was taken at the counter) and records
-- who corrected it. Monthly-bill orders stay on the bill.
-- ---------------------------------------------------------------------
CREATE PROCEDURE MarkCollected(IN p_order_id INT, IN p_staff_id INT)
BEGIN
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET @actor_id = NULL, @status_note = NULL;
        RESIGNAL;
    END;

    CALL CheckStaff(p_staff_id, 'admin,cashier', 'Only the manager or cashier can correct an order');

    START TRANSACTION;

    SELECT status INTO v_status FROM Orders WHERE order_id = p_order_id FOR UPDATE;
    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order not found';
    ELSEIF v_status <> 'No Show' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only No Show orders can be marked as collected';
    END IF;

    UPDATE Payments
       SET payment_status = 'Confirmed', verified_by = p_staff_id, verified_at = NOW()
     WHERE order_id = p_order_id AND payment_method <> 'Account' AND payment_status IN ('Pending', 'Billed');

    SET @actor_id = p_staff_id, @status_note = 'Collected - recorded late by staff';
    UPDATE Orders SET status = 'Completed' WHERE order_id = p_order_id;
    SET @actor_id = NULL, @status_note = NULL;

    COMMIT;
END$$

-- =====================================================================
-- MONTHLY BILL PAYMENTS
-- Each locks the customer's row first, so two payments for the same bill
-- (e.g. cashier and customer at the same moment) can't overpay it.
-- =====================================================================

-- CheckReferenceUnused: a wallet transaction ID can pay for only one thing
CREATE PROCEDURE CheckReferenceUnused(IN p_reference VARCHAR(50))
BEGIN
    IF EXISTS (SELECT 1 FROM Payments WHERE transaction_reference = p_reference)
       OR EXISTS (SELECT 1 FROM Account_Payments WHERE transaction_reference = p_reference) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This transaction ID has already been used';
    END IF;
END$$

-- ---------------------------------------------------------------------
-- SubmitAccountPayment: customer paid (part of) their bill by Easypaisa /
-- JazzCash and enters the transaction ID. Pending until a cashier checks it.
-- ---------------------------------------------------------------------
CREATE PROCEDURE SubmitAccountPayment(
    IN  p_user_id   INT,
    IN  p_amount    DECIMAL(10,2),
    IN  p_method    VARCHAR(20),
    IN  p_reference VARCHAR(50),
    OUT p_new_id    INT
)
BEGIN
    DECLARE v_owed DECIMAL(10,2);
    DECLARE v_locked INT;
    DECLARE v_msg VARCHAR(255);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    SET p_reference = NULLIF(TRIM(p_reference), '');
    IF p_method IS NULL OR p_method NOT IN ('Easypaisa', 'JazzCash') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Pay online with Easypaisa or JazzCash';
    END IF;
    IF p_reference IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enter the transaction ID from your payment message';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enter the amount you paid';
    END IF;

    START TRANSACTION;

    SELECT COUNT(*) INTO v_locked FROM Users
     WHERE user_id = p_user_id AND role = 'customer' AND is_active FOR UPDATE;
    IF v_locked = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Customer account not found';
    END IF;
    CALL CheckReferenceUnused(p_reference);

    -- What is owed and not already waiting to be checked
    SELECT balance - pending_payments INTO v_owed FROM Account_Balances WHERE user_id = p_user_id;
    IF v_owed <= 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'There is nothing left to pay on your bill';
    ELSEIF p_amount > v_owed THEN
        SET v_msg = CONCAT('That is more than you owe - the most you can pay is Rs. ', FORMAT(v_owed, 0));
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    INSERT INTO Account_Payments (user_id, amount, method, status, transaction_reference, submitted_by)
    VALUES (p_user_id, p_amount, p_method, 'Pending', p_reference, p_user_id);
    SET p_new_id = LAST_INSERT_ID();

    COMMIT;
END$$

-- ---------------------------------------------------------------------
-- RecordAccountPayment: staff take a payment towards a customer's bill.
--   Cash / Easypaisa / JazzCash (manager or cashier): money received, or a
--     wallet transfer already checked in the merchant app -> Confirmed.
--   Waiver (manager only): writes the amount off; a reason is required.
-- ---------------------------------------------------------------------
CREATE PROCEDURE RecordAccountPayment(
    IN  p_user_id   INT,
    IN  p_staff_id  INT,
    IN  p_amount    DECIMAL(10,2),
    IN  p_method    VARCHAR(20),
    IN  p_reference VARCHAR(50),
    IN  p_note      VARCHAR(255),
    OUT p_new_id    INT
)
BEGIN
    DECLARE v_balance DECIMAL(10,2);
    DECLARE v_locked INT;
    DECLARE v_msg VARCHAR(255);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    SET p_reference = NULLIF(TRIM(p_reference), ''), p_note = NULLIF(TRIM(p_note), '');
    IF p_method IS NULL OR p_method NOT IN ('Cash', 'Easypaisa', 'JazzCash', 'Waiver') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payment method must be Cash, Easypaisa, JazzCash or Waiver';
    END IF;
    IF p_method = 'Waiver' THEN
        CALL CheckStaff(p_staff_id, 'admin', 'Only the manager can waive a bill');
        IF p_note IS NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A reason is required to waive a bill';
        END IF;
    ELSE
        CALL CheckStaff(p_staff_id, 'admin,cashier', 'Only the manager or cashier can record payments');
    END IF;
    IF p_method IN ('Easypaisa', 'JazzCash') AND p_reference IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enter the transaction ID of the Easypaisa / JazzCash payment';
    END IF;
    IF p_method IN ('Cash', 'Waiver') THEN
        SET p_reference = NULL;
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Enter an amount greater than zero';
    END IF;

    START TRANSACTION;

    SELECT COUNT(*) INTO v_locked FROM Users WHERE user_id = p_user_id AND role = 'customer' FOR UPDATE;
    IF v_locked = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Customer account not found';
    END IF;
    IF p_reference IS NOT NULL THEN
        CALL CheckReferenceUnused(p_reference);
    END IF;

    SELECT balance INTO v_balance FROM Account_Balances WHERE user_id = p_user_id;
    IF v_balance <= 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This customer does not owe anything';
    ELSEIF p_amount > v_balance THEN
        SET v_msg = CONCAT('That is more than the customer owes (Rs. ', FORMAT(v_balance, 0), ')');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    INSERT INTO Account_Payments (user_id, amount, method, status, transaction_reference, note,
                                  submitted_by, verified_by, verified_at)
    VALUES (p_user_id, p_amount, p_method, 'Confirmed', p_reference, p_note, p_staff_id, p_staff_id, NOW());
    SET p_new_id = LAST_INSERT_ID();

    COMMIT;
END$$

-- ---------------------------------------------------------------------
-- ConfirmAccountPayment / RejectAccountPayment: cashier checked an online
-- bill payment in the merchant app. Rejecting needs a reason the customer
-- will see (e.g. "No payment with this ID").
-- ---------------------------------------------------------------------
CREATE PROCEDURE ConfirmAccountPayment(IN p_payment_id INT, IN p_staff_id INT)
BEGIN
    DECLARE v_user_id INT;
    DECLARE v_amount DECIMAL(10,2);
    DECLARE v_status VARCHAR(20);
    DECLARE v_balance DECIMAL(10,2);
    DECLARE v_locked INT;
    DECLARE v_msg VARCHAR(255);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    CALL CheckStaff(p_staff_id, 'admin,cashier', 'Only the manager or cashier can confirm payments');

    START TRANSACTION;

    SELECT user_id INTO v_user_id FROM Account_Payments WHERE account_payment_id = p_payment_id;
    IF v_user_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payment not found';
    END IF;
    SELECT COUNT(*) INTO v_locked FROM Users WHERE user_id = v_user_id FOR UPDATE;
    SELECT amount, status INTO v_amount, v_status
      FROM Account_Payments WHERE account_payment_id = p_payment_id FOR UPDATE;
    IF v_status <> 'Pending' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This payment has already been checked';
    END IF;

    SELECT balance INTO v_balance FROM Account_Balances WHERE user_id = v_user_id;
    IF v_amount > v_balance THEN
        SET v_msg = CONCAT('This payment is more than the customer now owes (Rs. ', FORMAT(GREATEST(v_balance, 0), 0),
                           ') - reject it and settle the difference with the customer');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    UPDATE Account_Payments
       SET status = 'Confirmed', verified_by = p_staff_id, verified_at = NOW()
     WHERE account_payment_id = p_payment_id;

    COMMIT;
END$$

CREATE PROCEDURE RejectAccountPayment(IN p_payment_id INT, IN p_staff_id INT, IN p_reason VARCHAR(255))
BEGIN
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    CALL CheckStaff(p_staff_id, 'admin,cashier', 'Only the manager or cashier can reject payments');
    IF COALESCE(TRIM(p_reason), '') = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A reason is required to reject a payment';
    END IF;

    START TRANSACTION;

    SELECT status INTO v_status FROM Account_Payments WHERE account_payment_id = p_payment_id FOR UPDATE;
    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payment not found';
    ELSEIF v_status <> 'Pending' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This payment has already been checked';
    END IF;

    UPDATE Account_Payments
       SET status = 'Rejected', note = TRIM(p_reason), verified_by = p_staff_id, verified_at = NOW()
     WHERE account_payment_id = p_payment_id;

    COMMIT;
END$$

-- ---------------------------------------------------------------------
-- ProcessOverdueOrders: run every few minutes (by the backend, or the
-- event below). Rejects orders nobody accepted in time and marks orders
-- that were never collected as No Show. Recorded as done by the system.
-- ---------------------------------------------------------------------
CREATE PROCEDURE ProcessOverdueOrders(OUT p_rejected INT, OUT p_no_shows INT)
BEGIN
    SET @actor_id = NULL;

    SET @status_note = 'Not accepted within 10 minutes';
    UPDATE Orders SET status = 'Rejected'
     WHERE status = 'Received' AND NOW() > acceptance_deadline;
    SET p_rejected = ROW_COUNT();

    SET @status_note = 'Not collected within 30 minutes of the pickup time';
    UPDATE Orders SET status = 'No Show'
     WHERE status = 'Ready' AND NOW() > requested_pickup_time + INTERVAL 30 MINUTE;
    SET p_no_shows = ROW_COUNT();

    SET @status_note = NULL;
END$$

DELIMITER ;

-- Optional: let MySQL run it automatically every 5 minutes
-- (needs: SET GLOBAL event_scheduler = ON;)
-- CREATE EVENT ev_process_overdue_orders
--     ON SCHEDULE EVERY 5 MINUTE
--     DO CALL ProcessOverdueOrders(@rejected, @no_shows);
