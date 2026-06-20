-- UP migration: approved delivery-trip payroll for logistics workers.
-- Existing logistics_transactions are retained as historical records.

CREATE TABLE IF NOT EXISTS truck_types (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_truck_types_name (name),
  INDEX idx_truck_types_active (is_active, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS logistics_locations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  location_category VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_logistics_location (location_category, name),
  INDEX idx_logistics_locations_active (is_active, location_category, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS logistics_rates (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  truck_type_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  trip_type VARCHAR(30) NOT NULL DEFAULT 'Any',
  role VARCHAR(20) NOT NULL,
  base_rate DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  additional_rate DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  multiplier DECIMAL(8,2) NOT NULL DEFAULT 1.00,
  special_rule_description VARCHAR(500) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  effective_date DATE NOT NULL,
  created_by INT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_logistics_rates_truck_type FOREIGN KEY (truck_type_id) REFERENCES truck_types(id),
  CONSTRAINT fk_logistics_rates_location FOREIGN KEY (location_id) REFERENCES logistics_locations(id),
  INDEX idx_logistics_rates_lookup (truck_type_id, location_id, trip_type, role, status, effective_date),
  INDEX idx_logistics_rates_status (status, effective_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_trips (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  employee_id INT NOT NULL,
  truck_type_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  logistics_rate_id BIGINT NULL,
  trip_date DATE NOT NULL,
  trip_type VARCHAR(30) NOT NULL,
  role VARCHAR(20) NOT NULL,
  plate_number VARCHAR(30) NULL,
  base_rate DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  additional_rate DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  multiplier DECIMAL(8,2) NOT NULL DEFAULT 1.00,
  total_trip_pay DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  special_rule_description VARCHAR(500) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'Draft',
  payroll_run_id INT NULL,
  approved_by INT NULL,
  approved_at DATETIME NULL,
  submitted_by INT NULL,
  submitted_at DATETIME NULL,
  created_by INT NULL,
  updated_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_delivery_trip_truck_type FOREIGN KEY (truck_type_id) REFERENCES truck_types(id),
  CONSTRAINT fk_delivery_trip_location FOREIGN KEY (location_id) REFERENCES logistics_locations(id),
  CONSTRAINT fk_delivery_trip_rate FOREIGN KEY (logistics_rate_id) REFERENCES logistics_rates(id),
  INDEX idx_delivery_trips_employee_period (employee_id, trip_date, status),
  INDEX idx_delivery_trips_approval (status, trip_date),
  INDEX idx_delivery_trips_payroll_run (payroll_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO truck_types (name, description, is_active)
SELECT 'Closed Van', 'Client logistics truck type', 1
WHERE NOT EXISTS (SELECT 1 FROM truck_types WHERE name = 'Closed Van');

INSERT INTO truck_types (name, description, is_active)
SELECT 'Wing Van', 'Client logistics truck type', 1
WHERE NOT EXISTS (SELECT 1 FROM truck_types WHERE name = 'Wing Van');

INSERT INTO logistics_locations (location_category, name, description, is_active)
SELECT 'Manila', 'Manila', 'Metro Manila deliveries', 1
WHERE NOT EXISTS (SELECT 1 FROM logistics_locations WHERE location_category = 'Manila' AND name = 'Manila');

INSERT INTO logistics_locations (location_category, name, description, is_active)
SELECT 'Province', 'Province', 'Standard provincial delivery', 1
WHERE NOT EXISTS (SELECT 1 FROM logistics_locations WHERE location_category = 'Province' AND name = 'Province');

INSERT INTO logistics_locations (location_category, name, description, is_active)
SELECT 'Special Location', 'La Union', 'Special delivery location', 1
WHERE NOT EXISTS (SELECT 1 FROM logistics_locations WHERE location_category = 'Special Location' AND name = 'La Union');

INSERT INTO logistics_locations (location_category, name, description, is_active)
SELECT 'Special Location', 'Tiaong', 'Special delivery location', 1
WHERE NOT EXISTS (SELECT 1 FROM logistics_locations WHERE location_category = 'Special Location' AND name = 'Tiaong');

INSERT INTO logistics_locations (location_category, name, description, is_active)
SELECT 'Special Location', 'Pangasinan', 'Special delivery location', 1
WHERE NOT EXISTS (SELECT 1 FROM logistics_locations WHERE location_category = 'Special Location' AND name = 'Pangasinan');

INSERT INTO logistics_locations (location_category, name, description, is_active)
SELECT 'Special Location', 'Tayabas', 'Special delivery location', 1
WHERE NOT EXISTS (SELECT 1 FROM logistics_locations WHERE location_category = 'Special Location' AND name = 'Tayabas');

-- Closed Van rates.
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '1st Trip', 'Driver', 750.00, 0.00, 1.00, 'Closed Van provincial first trip', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Province'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '1st Trip' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '1st Trip', 'Helper', 650.00, 0.00, 1.00, 'Closed Van provincial first trip', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Province'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '1st Trip' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '1st Trip', 'Driver', 650.00, 0.00, 1.00, 'Closed Van Manila first trip', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Manila'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '1st Trip' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '1st Trip', 'Helper', 600.00, 0.00, 1.00, 'Closed Van Manila first trip', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Manila'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '1st Trip' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '2nd Trip', 'Driver', 750.00, 0.00, 1.00, 'Closed Van provincial second trip', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Province'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '2nd Trip' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '2nd Trip', 'Helper', 650.00, 0.00, 0.50, 'Closed Van provincial second-trip helper half rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Province'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '2nd Trip' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '2nd Trip', 'Driver', 650.00, 0.00, 1.00, 'Closed Van Manila second trip', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Manila'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '2nd Trip' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '2nd Trip', 'Helper', 600.00, 0.00, 0.50, 'Closed Van Manila second-trip helper half rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Manila'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '2nd Trip' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, 'Any', 'Driver', 800.00, 0.00, 1.00, 'Closed Van Tiaong special rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Tiaong'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = 'Any' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, 'Any', 'Helper', 700.00, 0.00, 1.00, 'Closed Van Tiaong special rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Tiaong'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = 'Any' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, 'Any', 'Driver', 1150.00, 0.00, 1.00, 'Closed Van Pangasinan special rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Pangasinan'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = 'Any' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, 'Any', 'Helper', 800.00, 0.00, 1.00, 'Closed Van Pangasinan special rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Pangasinan'
WHERE tt.name = 'Closed Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = 'Any' AND r.role = 'Helper' AND r.status = 'Active');

-- Wing Van rates.
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '1st Trip', 'Driver', 1100.00, 300.00, 1.00, 'Wing Van provincial first trip with additional rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Province'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '1st Trip' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '1st Trip', 'Helper', 900.00, 300.00, 1.00, 'Wing Van provincial first trip with applicable additional rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Province'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '1st Trip' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '1st Trip', 'Driver', 950.00, 250.00, 1.00, 'Wing Van Manila first trip with additional rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Manila'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '1st Trip' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '1st Trip', 'Helper', 750.00, 250.00, 1.00, 'Wing Van Manila first trip with applicable additional rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Manila'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '1st Trip' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '2nd Trip', 'Driver', 1100.00, 0.00, 1.00, 'Wing Van provincial second trip', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Province'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '2nd Trip' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '2nd Trip', 'Helper', 900.00, 0.00, 0.50, 'Wing Van provincial second-trip helper half rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Province'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '2nd Trip' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '2nd Trip', 'Driver', 950.00, 0.00, 1.00, 'Wing Van Manila second trip', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Manila'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '2nd Trip' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, '2nd Trip', 'Helper', 750.00, 0.00, 0.50, 'Wing Van Manila second-trip helper half rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'Manila'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = '2nd Trip' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, 'Any', 'Driver', 1100.00, 0.00, 2.00, 'Wing Van La Union x2 rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'La Union'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = 'Any' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, 'Any', 'Helper', 900.00, 0.00, 2.00, 'Wing Van La Union x2 rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name = 'La Union'
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = 'Any' AND r.role = 'Helper' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, 'Any', 'Driver', 1500.00, 0.00, 1.00, 'Wing Van special route rate', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name IN ('Tayabas', 'Pangasinan')
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = 'Any' AND r.role = 'Driver' AND r.status = 'Active');
INSERT INTO logistics_rates (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date)
SELECT tt.id, ll.id, 'Any', 'Helper', 1100.00, 366.67, 1.00, 'Wing Van special route helper rate with additional amount', 'Active', '2026-01-01'
FROM truck_types tt JOIN logistics_locations ll ON ll.name IN ('Tayabas', 'Pangasinan')
WHERE tt.name = 'Wing Van' AND NOT EXISTS (SELECT 1 FROM logistics_rates r WHERE r.truck_type_id = tt.id AND r.location_id = ll.id AND r.trip_type = 'Any' AND r.role = 'Helper' AND r.status = 'Active');

-- Existing systems use Per-Trip. Trip-Based is an explicit logistics alias for assignment screens.
INSERT INTO wage_types (name, description)
SELECT 'Trip-Based', 'Logistics: paid from approved delivery trips'
WHERE NOT EXISTS (SELECT 1 FROM wage_types WHERE LOWER(name) = 'trip-based');
