-- =====================================================================
-- Seed data: categories, menu, staff accounts and demo customers.
-- Passwords are stored as hashes (werkzeug pbkdf2 format, checked by Flask).
--
--   Role      University ID  Email                        Password
--   admin     EMP-0001       admin@university.edu         Admin@123
--   cashier   EMP-0002       cashier@university.edu       Cashier@123
--   kitchen   EMP-0003       kitchen@university.edu       Kitchen@123
--   customer  STU001         ali.hassan@university.edu    student123
--   customer  STU002         fatima.khan@university.edu   student123
--   customer  EMP-1001       sana.iqbal@university.edu    faculty123
--
-- Change the staff passwords before any real use.
-- =====================================================================
USE campus_cafeteria;

INSERT INTO Categories (category_name) VALUES
    ('Breakfast'), ('Lunch'), ('Snacks'), ('Beverages');

INSERT INTO Users (university_id, full_name, email, phone, user_type, role, password_hash) VALUES
    ('EMP-0001', 'Cafeteria Admin',  'admin@university.edu',       '03000000001', 'staff',   'admin',
     'pbkdf2:sha256:600000$2b5f40f5f8bd215f$459b7d85f939be25635a0b1000673963dc6cc8d607288f45512316abf848b15b'),
    ('EMP-0002', 'Counter Cashier',  'cashier@university.edu',     '03000000002', 'staff',   'cashier',
     'pbkdf2:sha256:600000$d5f60390ba285564$b737a4980e845d8a214b05396ea232da684b5c35f5e6b52b0cf3031ff9e5cf01'),
    ('EMP-0003', 'Head Chef',        'kitchen@university.edu',     '03000000003', 'staff',   'kitchen',
     'pbkdf2:sha256:600000$GQPhuVo77uPdIfXz$8bbf1d752b6f7c2fcda7e785483232a4dbd878cc153ceccd6b33b9a49e022a65'),
    ('STU001',   'Ali Hassan',       'ali.hassan@university.edu',  '03001234567', 'student', 'customer',
     'pbkdf2:sha256:600000$d6b2f6e271bb9cf3$32c092723c3d76d6045af04b5d1dc14efa8d034d4e2a1f526387734fdbf35906'),
    ('STU002',   'Fatima Khan',      'fatima.khan@university.edu', '03019876543', 'student', 'customer',
     'pbkdf2:sha256:600000$89fcae1cf21f3667$374fc260c8bc29d4af3b925a3959aec289dea64b23bf8f896f9bcc9d160e58dd'),
    ('EMP-1001', 'Dr. Sana Iqbal',   'sana.iqbal@university.edu',  '03215550000', 'faculty', 'customer',
     'pbkdf2:sha256:600000$323ad9ab8660d52a$ed5ae1d8b01120092198fd2b8febac57aa6768509f542c4c48c430124ce45c17');

INSERT INTO Menu_Items (category_id, item_name, description, price, stock_quantity, image_url)
SELECT c.category_id, v.item_name, v.description, v.price, v.stock, v.image_url
FROM (
    SELECT 'Breakfast' AS category, 'Pancakes' AS item_name, 'Fluffy pancakes with maple syrup and butter' AS description, 90 AS price, 20 AS stock,
           'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&h=300&fit=crop' AS image_url
    UNION ALL SELECT 'Breakfast', 'Egg Omelette', 'Three-egg omelette with cheese and vegetables', 70, 25,
           'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Lunch', 'Classic Burger', 'Juicy beef patty with fresh vegetables and special sauce', 120, 40,
           'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Lunch', 'Margherita Pizza', 'Classic pizza with tomato sauce, mozzarella and basil', 180, 25,
           'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Lunch', 'Chicken Sandwich', 'Grilled chicken breast with lettuce and mayo', 100, 30,
           'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Lunch', 'Pasta Alfredo', 'Creamy alfredo pasta with parmesan cheese', 150, 15,
           'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Snacks', 'French Fries', 'Crispy golden fries with ketchup', 60, 0,
           'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Snacks', 'Samosa', 'Crispy fried pastry with spiced potato filling (2 pieces)', 30, 60,
           'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Snacks', 'Spring Rolls', 'Crispy vegetable spring rolls (4 pieces)', 80, 35,
           'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Beverages', 'Coffee', 'Hot brewed coffee - Americano, Latte or Cappuccino', 50, 100,
           'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Beverages', 'Orange Juice', 'Freshly squeezed orange juice', 40, 8,
           'https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=400&h=300&fit=crop'
    UNION ALL SELECT 'Beverages', 'Chocolate Shake', 'Rich and creamy chocolate milkshake', 80, 6,
           'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=400&h=300&fit=crop'
) v
JOIN Categories c ON c.category_name = v.category;
