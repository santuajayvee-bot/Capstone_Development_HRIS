-- DOWN migration: removes only the new trip-based logistics schema.
-- Existing logistics_transactions and payroll history are intentionally retained.

DELETE FROM wage_types WHERE LOWER(name) = 'trip-based';
DROP TABLE IF EXISTS delivery_trips;
DROP TABLE IF EXISTS logistics_rates;
DROP TABLE IF EXISTS logistics_locations;
DROP TABLE IF EXISTS truck_types;
