-- =====================================================================
-- Triggers - business rules the database enforces no matter which
-- program (Flask, Workbench, a script) touches the data.
--
-- Who / why: the procedures in 03_procedures.sql set two session
-- variables before changing an order's status, and the history trigger
-- records them:
--   @actor_id    = user_id of the person making the change (NULL = system)
--   @status_note = reason, e.g. why an order was rejected
-- =====================================================================
USE campus_cafeteria;

DELIMITER $$

-- ---------------------------------------------------------------------
-- New orders always start as 'Received' + first history entry
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_orders_before_insert
BEFORE INSERT ON Orders
FOR EACH ROW
BEGIN
    IF NEW.status <> 'Received' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'New orders must start with status Received';
    END IF;
END$$

CREATE TRIGGER trg_orders_after_insert
AFTER INSERT ON Orders
FOR EACH ROW
BEGIN
    INSERT INTO Order_Status_History (order_id, old_status, new_status, changed_by, changed_at)
    VALUES (NEW.order_id, NULL, NEW.status, NEW.user_id, NEW.order_date);
END$$

-- ---------------------------------------------------------------------
-- Before an item is added to an order: is it available and in stock?
-- FOR UPDATE locks the menu row so two customers can't buy the last item.
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_order_details_before_insert
BEFORE INSERT ON Order_Details
FOR EACH ROW
BEGIN
    DECLARE v_stock INT;
    DECLARE v_available BOOLEAN;
    DECLARE v_name VARCHAR(100);
    DECLARE v_order_status VARCHAR(20);
    DECLARE v_msg VARCHAR(255);

    SELECT status INTO v_order_status FROM Orders WHERE order_id = NEW.order_id;
    IF v_order_status <> 'Received' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Items can only be added to a newly received order';
    END IF;

    SELECT stock_quantity, is_available, item_name
      INTO v_stock, v_available, v_name
      FROM Menu_Items
     WHERE item_id = NEW.item_id
       FOR UPDATE;

    IF v_available = FALSE THEN
        SET v_msg = CONCAT(v_name, ' is currently unavailable');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;

    IF v_stock = 0 THEN
        SET v_msg = CONCAT(v_name, ' is out of stock');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    ELSEIF v_stock < NEW.quantity THEN
        SET v_msg = CONCAT('Only ', v_stock, ' ', v_name, ' left in stock');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;
END$$

-- After an item is added: take it out of stock and add it to the order total
CREATE TRIGGER trg_order_details_after_insert
AFTER INSERT ON Order_Details
FOR EACH ROW
BEGIN
    UPDATE Menu_Items
       SET stock_quantity = stock_quantity - NEW.quantity
     WHERE item_id = NEW.item_id;

    UPDATE Orders
       SET total_amount = total_amount + (NEW.quantity * NEW.unit_price)
     WHERE order_id = NEW.order_id;
END$$

-- ---------------------------------------------------------------------
-- Status changes: only allowed transitions, deadlines respected,
-- and the matching timestamp is filled in automatically.
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_orders_before_update
BEFORE UPDATE ON Orders
FOR EACH ROW
BEGIN
    DECLARE v_payment_status VARCHAR(20);
    DECLARE v_msg VARCHAR(255);

    IF NEW.status <> OLD.status THEN

        IF NOT (
               (OLD.status = 'Received'  AND NEW.status IN ('Accepted', 'Rejected', 'Cancelled'))
            OR (OLD.status = 'Accepted'  AND NEW.status IN ('Preparing', 'Cancelled'))
            OR (OLD.status = 'Preparing' AND NEW.status = 'Ready')
            OR (OLD.status = 'Ready'     AND NEW.status IN ('Completed', 'No Show'))
        ) THEN
            SET v_msg = CONCAT('Order status cannot change from ', OLD.status, ' to ', NEW.status);
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
        END IF;

        IF NEW.status = 'Cancelled' AND NOW() > OLD.cancellation_deadline THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The cancellation deadline for this order has passed';
        END IF;

        IF NEW.status = 'Rejected' AND COALESCE(TRIM(@status_note), '') = '' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A reason is required to reject an order';
        END IF;

        -- Food is handed over only after it is paid for
        IF NEW.status = 'Completed' THEN
            SELECT payment_status INTO v_payment_status FROM Payments WHERE order_id = OLD.order_id;
            IF v_payment_status IS NULL OR v_payment_status <> 'Confirmed' THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payment must be confirmed before the order is completed';
            END IF;
        END IF;

        CASE NEW.status
            WHEN 'Accepted'  THEN SET NEW.accepted_at = NOW();
            WHEN 'Preparing' THEN SET NEW.preparing_at = NOW();
            WHEN 'Ready'     THEN SET NEW.ready_at = NOW();
            WHEN 'Completed' THEN SET NEW.picked_up_at = NOW();
            ELSE                                -- Cancelled, Rejected, No Show
                SET NEW.closed_at = NOW();
                SET NEW.close_reason = NULLIF(TRIM(@status_note), '');
        END CASE;
    END IF;
END$$

-- After a status change: history, stock restore and payment update
CREATE TRIGGER trg_orders_after_update
AFTER UPDATE ON Orders
FOR EACH ROW
BEGIN
    IF NEW.status <> OLD.status THEN
        INSERT INTO Order_Status_History (order_id, old_status, new_status, changed_by, note)
        VALUES (NEW.order_id, OLD.status, NEW.status, @actor_id, NULLIF(TRIM(@status_note), ''));

        -- Cancelled / Rejected: food was not handed out -> put items back in stock.
        -- Runs only on the transition INTO these final states, so never twice.
        -- No Show does NOT restore stock: the food was already prepared.
        IF NEW.status IN ('Cancelled', 'Rejected') THEN
            UPDATE Menu_Items m
              JOIN Order_Details od ON od.item_id = m.item_id
               SET m.stock_quantity = m.stock_quantity + od.quantity
             WHERE od.order_id = NEW.order_id;

            UPDATE Payments
               SET payment_status = CASE WHEN payment_status = 'Confirmed' THEN 'Refunded' ELSE 'Void' END
             WHERE order_id = NEW.order_id
               AND payment_status IN ('Pending', 'Confirmed');
        END IF;
    END IF;
END$$

-- ---------------------------------------------------------------------
-- Reviews: only customers who actually received the item may review it
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_reviews_before_insert
BEFORE INSERT ON Reviews
FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM Orders o
          JOIN Order_Details od ON od.order_id = o.order_id
         WHERE o.user_id = NEW.user_id
           AND od.item_id = NEW.item_id
           AND o.status = 'Completed'
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'You can only review items from your completed orders';
    END IF;
END$$

DELIMITER ;
