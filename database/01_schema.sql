-- =====================================================================
-- Campus Cafeteria Online Ordering System - Schema (MySQL 8.0+)
-- Clean install. Uses a NEW database name (campus_cafeteria) so it can
-- never overwrite an older cafeteria_system database.
-- Run order: 01_schema -> 02_triggers -> 03_procedures -> 04_views -> 05_seed
-- =====================================================================

CREATE DATABASE IF NOT EXISTS campus_cafeteria
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE campus_cafeteria;

-- ---------------------------------------------------------------------
-- 1. USERS
-- Students, GCs, army personnel, faculty and staff, identified by their
-- university / service ID.
-- user_type = who the person is at the university
-- role      = what the person may do in this system:
--   customer  places orders (students, GCs, army personnel, faculty, staff)
--   admin     the cafeteria manager: accepts/rejects orders, menu, reports (only one)
--   cashier   counter staff: accepts/rejects orders, takes payment, hands food over
--   kitchen   chef: starts preparing orders and marks them ready
-- ---------------------------------------------------------------------
CREATE TABLE Users (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    university_id   VARCHAR(30)  NOT NULL UNIQUE,          -- student ID or employee ID
    full_name       VARCHAR(100) NOT NULL,
    email           VARCHAR(120) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    user_type       ENUM('student', 'gc', 'army', 'faculty', 'staff') NOT NULL,
    role            ENUM('customer', 'admin', 'cashier', 'kitchen') NOT NULL DEFAULT 'customer',
    password_hash   VARCHAR(255) NOT NULL,                  -- hashed by the backend, never plain text
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    -- Monthly bill (customers): may they buy now and pay at the end of the month,
    -- and up to how much a month (NULL = the default in Billing_Settings)
    account_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    monthly_limit   DECIMAL(10,2) NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Only ONE admin can exist: every non-admin gets NULL (UNIQUE allows many NULLs)
    admin_guard     TINYINT GENERATED ALWAYS AS (CASE WHEN role = 'admin' THEN 1 ELSE NULL END) STORED,
    UNIQUE KEY uq_single_admin (admin_guard),

    -- Students can only be customers; staff roles must be university employees
    CONSTRAINT chk_role_user_type CHECK (role = 'customer' OR user_type IN ('faculty', 'staff')),
    CONSTRAINT chk_monthly_limit CHECK (monthly_limit IS NULL OR monthly_limit >= 0)
);

-- ---------------------------------------------------------------------
-- 2. CATEGORIES
-- ---------------------------------------------------------------------
CREATE TABLE Categories (
    category_id     INT AUTO_INCREMENT PRIMARY KEY,
    category_name   VARCHAR(60) NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------
-- 3. MENU ITEMS
-- is_available is the admin's on/off switch; an item can be ordered only
-- when is_available = TRUE AND stock_quantity > 0 (see view Menu_Catalog).
-- ---------------------------------------------------------------------
CREATE TABLE Menu_Items (
    item_id             INT AUTO_INCREMENT PRIMARY KEY,
    category_id         INT NOT NULL,
    item_name           VARCHAR(100) NOT NULL UNIQUE,
    description         VARCHAR(255),
    price               DECIMAL(10,2) NOT NULL,
    stock_quantity      INT NOT NULL DEFAULT 0,
    low_stock_threshold INT NOT NULL DEFAULT 5,
    is_available        BOOLEAN NOT NULL DEFAULT TRUE,
    image_url           VARCHAR(500),
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_menu_category FOREIGN KEY (category_id) REFERENCES Categories(category_id),
    CONSTRAINT chk_item_price CHECK (price >= 0),
    CONSTRAINT chk_item_stock CHECK (stock_quantity >= 0),
    CONSTRAINT chk_low_stock_threshold CHECK (low_stock_threshold >= 0)
);

-- ---------------------------------------------------------------------
-- 4. ORDERS
-- Status lifecycle (enforced by trigger trg_orders_before_update):
--   Received -> Accepted -> Preparing -> Ready -> Completed
--     Received  = placed, waiting for the manager / cashier to review it
--     Accepted  = manager committed to it; waiting for the kitchen to start
--     Preparing = the chef has started cooking
--     Ready     = food is at the counter; Completed = handed to the customer
--   Received -> Rejected                 (declined with a reason / not accepted in time)
--   Received | Accepted -> Cancelled     (customer, before cancellation_deadline and
--                                         before the kitchen starts cooking)
--   Ready -> No Show                     (not collected 30 min after pickup time)
-- Times: requested_pickup_time = what the customer asked for,
--        estimated_ready_time  = what the cafeteria promised when accepting,
--        the *_at columns      = when each step actually happened.
-- ---------------------------------------------------------------------
CREATE TABLE Orders (
    order_id                INT AUTO_INCREMENT PRIMARY KEY,
    user_id                 INT NOT NULL,
    order_date              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    requested_pickup_time   DATETIME NOT NULL,
    acceptance_deadline     DATETIME NOT NULL,      -- cafeteria must accept before this
    cancellation_deadline   DATETIME NOT NULL,      -- customer may cancel until this
    estimated_ready_time    DATETIME NULL,          -- set when the order is accepted
    accepted_at             DATETIME NULL,
    preparing_at            DATETIME NULL,          -- kitchen started cooking
    ready_at                DATETIME NULL,
    picked_up_at            DATETIME NULL,
    closed_at               DATETIME NULL,          -- cancelled / rejected / no-show time
    close_reason            VARCHAR(255) NULL,      -- why it was rejected / cancelled / no-show

    status ENUM('Received', 'Accepted', 'Preparing', 'Ready', 'Completed', 'Cancelled', 'Rejected', 'No Show')
        NOT NULL DEFAULT 'Received',
    total_amount            DECIMAL(10,2) NOT NULL DEFAULT 0.00,   -- maintained by trigger
    special_instructions    VARCHAR(255),

    CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES Users(user_id),
    CONSTRAINT chk_order_total CHECK (total_amount >= 0),

    INDEX idx_order_user (user_id),
    INDEX idx_order_date (order_date),
    INDEX idx_order_status (status),
    INDEX idx_requested_pickup (requested_pickup_time)
);

-- ---------------------------------------------------------------------
-- 5. ORDER DETAILS  (many-to-many between Orders and Menu_Items)
-- Composite primary key: one row per item per order.
-- unit_price is copied at order time so later price changes don't alter history.
-- ---------------------------------------------------------------------
CREATE TABLE Order_Details (
    order_id    INT NOT NULL,
    item_id     INT NOT NULL,
    quantity    INT NOT NULL,
    unit_price  DECIMAL(10,2) NOT NULL,

    PRIMARY KEY (order_id, item_id),
    CONSTRAINT fk_detail_order FOREIGN KEY (order_id) REFERENCES Orders(order_id),
    CONSTRAINT fk_detail_item  FOREIGN KEY (item_id)  REFERENCES Menu_Items(item_id),
    CONSTRAINT chk_detail_quantity CHECK (quantity > 0),
    CONSTRAINT chk_detail_price CHECK (unit_price >= 0)
);

-- ---------------------------------------------------------------------
-- 6. PAYMENTS  (one per order)
-- Cash: Pending until the cashier collects it at pickup.
-- Easypaisa / JazzCash: customer submits the transaction reference;
--   Pending until a cashier verifies it. Choosing a method is NOT proof.
-- Account ("monthly bill"): Pending while the order is in progress,
--   Billed when it is handed over = added to the customer's monthly bill.
-- No Show: a still-Pending payment becomes Billed (trigger) - the food was
--   made, so it is added to the monthly bill whatever the method.
-- Cancelled / Rejected: Confirmed -> Refunded, Pending -> Void (trigger).
-- Money owed = Billed payments - confirmed Account_Payments.
-- ---------------------------------------------------------------------
CREATE TABLE Payments (
    payment_id              INT AUTO_INCREMENT PRIMARY KEY,
    order_id                INT NOT NULL UNIQUE,
    payment_method          ENUM('Cash', 'Easypaisa', 'JazzCash', 'Account') NOT NULL,
    payment_status          ENUM('Pending', 'Confirmed', 'Billed', 'Refunded', 'Void') NOT NULL DEFAULT 'Pending',
    amount                  DECIMAL(10,2) NOT NULL,
    transaction_reference   VARCHAR(50) NULL,
    verified_by             INT NULL,               -- cashier/admin who confirmed it
    verified_at             DATETIME NULL,
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_payment_order    FOREIGN KEY (order_id)    REFERENCES Orders(order_id),
    CONSTRAINT fk_payment_verifier FOREIGN KEY (verified_by) REFERENCES Users(user_id),
    CONSTRAINT chk_payment_amount CHECK (amount >= 0),
    -- digital wallets need a reference, cash and the monthly bill must not have one
    CONSTRAINT chk_payment_reference CHECK (
        (payment_method IN ('Cash', 'Account') AND transaction_reference IS NULL) OR
        (payment_method IN ('Easypaisa', 'JazzCash') AND transaction_reference IS NOT NULL)
    ),
    UNIQUE KEY uq_payment_reference (transaction_reference),
    INDEX idx_payment_status (payment_status)
);

-- ---------------------------------------------------------------------
-- 6b. BILLING SETTINGS  (exactly one row; the manager can change it)
-- A month's bill is due on due_day of the next month: October's bill is
-- due by 10 November. From the 11th, a customer with any of it unpaid
-- cannot order (checked in PlaceOrder) until they pay.
-- ---------------------------------------------------------------------
CREATE TABLE Billing_Settings (
    setting_id              TINYINT PRIMARY KEY DEFAULT 1,
    accounts_open           BOOLEAN NOT NULL DEFAULT TRUE,          -- "monthly bill" offered at checkout
    due_day                 TINYINT NOT NULL DEFAULT 10,
    default_monthly_limit   DECIMAL(10,2) NOT NULL DEFAULT 15000.00,
    updated_by              INT NULL,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES Users(user_id),
    CONSTRAINT chk_settings_single_row CHECK (setting_id = 1),
    CONSTRAINT chk_settings_due_day CHECK (due_day BETWEEN 1 AND 28),
    CONSTRAINT chk_settings_limit CHECK (default_monthly_limit >= 0)
);

INSERT INTO Billing_Settings (setting_id) VALUES (1);

-- ---------------------------------------------------------------------
-- 6c. ACCOUNT PAYMENTS  (money paid towards a customer's monthly bill)
-- Cash at the counter: recorded by the cashier, Confirmed at once.
-- Easypaisa / JazzCash: either the customer submits the transaction ID
--   online (Pending until a cashier checks the merchant app) or the
--   cashier records one they have already checked (Confirmed).
-- Waiver: the manager writes off an amount, with a reason.
-- Payments are applied to the oldest charges first.
-- ---------------------------------------------------------------------
CREATE TABLE Account_Payments (
    account_payment_id      INT AUTO_INCREMENT PRIMARY KEY,
    user_id                 INT NOT NULL,                   -- whose bill
    amount                  DECIMAL(10,2) NOT NULL,
    method                  ENUM('Cash', 'Easypaisa', 'JazzCash', 'Waiver') NOT NULL,
    status                  ENUM('Pending', 'Confirmed', 'Rejected') NOT NULL DEFAULT 'Pending',
    transaction_reference   VARCHAR(50) NULL,
    note                    VARCHAR(255) NULL,              -- waiver / rejection reason, cashier's note
    submitted_by            INT NOT NULL,                   -- the customer (online) or the staff member
    verified_by             INT NULL,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at             DATETIME NULL,

    CONSTRAINT fk_account_payment_user      FOREIGN KEY (user_id)      REFERENCES Users(user_id),
    CONSTRAINT fk_account_payment_submitter FOREIGN KEY (submitted_by) REFERENCES Users(user_id),
    CONSTRAINT fk_account_payment_verifier  FOREIGN KEY (verified_by)  REFERENCES Users(user_id),
    CONSTRAINT chk_account_payment_amount CHECK (amount > 0),
    CONSTRAINT chk_account_payment_reference CHECK (
        (method IN ('Cash', 'Waiver') AND transaction_reference IS NULL) OR
        (method IN ('Easypaisa', 'JazzCash') AND transaction_reference IS NOT NULL)
    ),
    CONSTRAINT chk_account_payment_waiver_reason CHECK (method <> 'Waiver' OR note IS NOT NULL),
    UNIQUE KEY uq_account_payment_reference (transaction_reference),
    INDEX idx_account_payment_user (user_id),
    INDEX idx_account_payment_status (status)
);

-- ---------------------------------------------------------------------
-- 7. CART  (temporary; emptied when the order is placed)
-- ---------------------------------------------------------------------
CREATE TABLE Cart (
    user_id     INT NOT NULL,
    item_id     INT NOT NULL,
    quantity    INT NOT NULL DEFAULT 1,
    added_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, item_id),
    CONSTRAINT fk_cart_user FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_cart_item FOREIGN KEY (item_id) REFERENCES Menu_Items(item_id) ON DELETE CASCADE,
    CONSTRAINT chk_cart_quantity CHECK (quantity > 0)
);

-- ---------------------------------------------------------------------
-- 8. REVIEWS  (one per user per item; only buyers - see trigger)
-- ---------------------------------------------------------------------
CREATE TABLE Reviews (
    review_id   INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    item_id     INT NOT NULL,
    rating      TINYINT NOT NULL,
    comment     VARCHAR(500),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_review_user FOREIGN KEY (user_id) REFERENCES Users(user_id),
    CONSTRAINT fk_review_item FOREIGN KEY (item_id) REFERENCES Menu_Items(item_id),
    CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
    UNIQUE KEY uq_user_item_review (user_id, item_id)
);

-- ---------------------------------------------------------------------
-- 9. ORDER STATUS HISTORY  (written only by trigger)
-- Gives the customer's tracking timeline real times for every step,
-- and an audit trail of who changed what and why.
-- changed_by is NULL when the system did it (e.g. automatic rejection).
-- ---------------------------------------------------------------------
CREATE TABLE Order_Status_History (
    history_id  INT AUTO_INCREMENT PRIMARY KEY,
    order_id    INT NOT NULL,
    old_status  VARCHAR(20) NULL,
    new_status  VARCHAR(20) NOT NULL,
    changed_by  INT NULL,
    note        VARCHAR(255) NULL,
    changed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_history_order FOREIGN KEY (order_id)   REFERENCES Orders(order_id),
    CONSTRAINT fk_history_user  FOREIGN KEY (changed_by) REFERENCES Users(user_id),
    INDEX idx_history_order (order_id)
);
